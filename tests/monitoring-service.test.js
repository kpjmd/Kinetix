// tests/monitoring-service.test.js
// Tests for the evidence-collection scheduler. Mocks data-store and both
// platform clients — no relays, no nak binary, no Moltbook API.
//
// Scope note: this file covers the scheduler and the per-run bounds. The
// collectors themselves are exercised separately.

jest.mock('../services/data-store');
jest.mock('../utils/moltbook-api', () => ({ search: jest.fn() }));
jest.mock('../utils/clawstr-api', () => ({
  getFeed: jest.fn(),
  getEventsByAuthor: jest.fn(),
  // Not mocked away: normalisation is pure and its behaviour is what decides
  // whether a stored identity can match anything.
  normalizeNostrPubkey: jest.requireActual('../utils/clawstr-api').normalizeNostrPubkey
}));

const dataStore = require('../services/data-store');
const clawstrApi = require('../utils/clawstr-api');
const { MonitoringService } = require('../services/monitoring-service');

function makeCommitment(overrides = {}) {
  return {
    commitment_id: 'cmt_kx_test',
    status: 'active',
    // Far future, so an unrelated test never trips the expiry-scoring path.
    end_date: new Date(Date.now() + 86400000).toISOString(),
    start_date: new Date(Date.now() - 86400000).toISOString(),
    evidence: [],
    criteria: { platform: 'clawstr' },
    ...overrides
  };
}

function makeVerificationService() {
  return {
    addEvidence: jest.fn().mockResolvedValue(undefined),
    scoreVerification: jest.fn().mockResolvedValue(undefined)
  };
}

describe('MonitoringService scheduler', () => {
  let service;
  let verificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    dataStore.listCommitments.mockResolvedValue([]);
    service = new MonitoringService();
    verificationService = makeVerificationService();
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  it('ticks exactly on the configured interval', async () => {
    // Regression lock: this used to build `*/60 * * * *`. Cron minute fields
    // only range 0-59, so that rule was already degenerate at the configured
    // default and silently misbehaves above it.
    service.initialize(verificationService);
    await service.start(60);

    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(3599999);
    expect(dataStore.listCommitments).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(dataStore.listCommitments).toHaveBeenCalledTimes(1);
  });

  it('honours an interval a cron minute field could not express', async () => {
    // `*/90 * * * *` is not 90 minutes — it is a minute field out of range.
    service.initialize(verificationService);
    await service.start(90);

    await jest.advanceTimersByTimeAsync(3600000);
    expect(dataStore.listCommitments).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1800000);
    expect(dataStore.listCommitments).toHaveBeenCalledTimes(1);
  });

  it('refuses to start before initialize', async () => {
    // Otherwise the failure surfaces inside a timer callback, once per
    // commitment, forever — instead of loudly at startup.
    await expect(service.start(60)).rejects.toThrow(/before initialize/);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects a non-positive or non-numeric interval', async () => {
    service.initialize(verificationService);

    await expect(service.start(0)).rejects.toThrow(/Invalid monitoring interval/);
    await expect(service.start(NaN)).rejects.toThrow(/Invalid monitoring interval/);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is idempotent: a second start does not create a second timer', async () => {
    service.initialize(verificationService);
    await service.start(60);
    await service.start(60);

    expect(jest.getTimerCount()).toBe(1);
  });

  it('stop() clears the timer and can be called twice', async () => {
    service.initialize(verificationService);
    await service.start(60);
    service.stop();

    expect(jest.getTimerCount()).toBe(0);
    expect(() => service.stop()).not.toThrow();
  });

  it('does not run a tick until the interval elapses by default', async () => {
    service.initialize(verificationService);
    await service.start(60);

    expect(dataStore.listCommitments).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3600000);
    expect(dataStore.listCommitments).toHaveBeenCalledTimes(1);
  });

  it('runs one tick right away when immediate is set', async () => {
    service.initialize(verificationService);
    await service.start(60, { immediate: true });

    expect(dataStore.listCommitments).toHaveBeenCalledTimes(1);
  });

  it('does not let a scheduled run failure escape as an unhandled rejection', async () => {
    service.initialize(verificationService);
    dataStore.listCommitments.mockRejectedValue(new Error('disk gone'));
    await service.start(60);

    await expect(jest.advanceTimersByTimeAsync(3600000)).resolves.toBeUndefined();
  });
});

describe('MonitoringService.checkAllActive', () => {
  let service;
  let verificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MonitoringService();
    verificationService = makeVerificationService();
    service.initialize(verificationService);
  });

  it('skips a tick while a previous run is still in flight', async () => {
    let release;
    dataStore.listCommitments.mockReturnValue(new Promise(resolve => { release = resolve; }));

    const first = service.checkAllActive();
    const second = await service.checkAllActive();

    expect(second).toBeUndefined();
    expect(dataStore.listCommitments).toHaveBeenCalledTimes(1);

    release([]);
    await first;

    // The guard must clear even so, or monitoring stops forever after one run.
    await service.checkAllActive();
    expect(dataStore.listCommitments).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight guard when a run throws', async () => {
    dataStore.listCommitments.mockRejectedValueOnce(new Error('boom'));
    await expect(service.checkAllActive()).rejects.toThrow('boom');

    dataStore.listCommitments.mockResolvedValue([]);
    await service.checkAllActive();
    expect(dataStore.listCommitments).toHaveBeenCalledTimes(2);
  });

  it('continues past a commitment whose collector throws', async () => {
    const good = makeCommitment({ commitment_id: 'cmt_good' });
    const bad = makeCommitment({ commitment_id: 'cmt_bad' });
    dataStore.listCommitments.mockResolvedValue([bad, good]);

    jest.spyOn(service, 'checkCommitment').mockImplementation(async c => {
      if (c.commitment_id === 'cmt_bad') throw new Error('relay down');
    });

    await service.checkAllActive();
    expect(service.checkCommitment).toHaveBeenCalledTimes(2);
  });

  it('caps a run and processes soonest-expiring commitments first', async () => {
    // Under a cap, the commitments about to be scored must not be starved by
    // long-running ones.
    const now = Date.now();
    const many = Array.from({ length: 60 }, (_, i) =>
      makeCommitment({
        commitment_id: `cmt_${i}`,
        // Descending end_date, so insertion order is the opposite of priority.
        end_date: new Date(now + (60 - i) * 86400000).toISOString()
      })
    );
    dataStore.listCommitments.mockResolvedValue(many);
    jest.spyOn(service, 'checkCommitment').mockResolvedValue(undefined);

    await service.checkAllActive();

    expect(service.checkCommitment).toHaveBeenCalledTimes(50);
    const processed = service.checkCommitment.mock.calls.map(c => c[0].commitment_id);
    expect(processed[0]).toBe('cmt_59');
    expect(processed).not.toContain('cmt_0');
  });

  it('does not mutate the caller order of the commitment list', async () => {
    const list = [
      makeCommitment({ commitment_id: 'later', end_date: new Date(Date.now() + 200000).toISOString() }),
      makeCommitment({ commitment_id: 'sooner', end_date: new Date(Date.now() + 100000).toISOString() })
    ];
    dataStore.listCommitments.mockResolvedValue(list);
    jest.spyOn(service, 'checkCommitment').mockResolvedValue(undefined);

    await service.checkAllActive();
    expect(list.map(c => c.commitment_id)).toEqual(['later', 'sooner']);
  });
});

describe('MonitoringService Clawstr collection', () => {
  const NPUB = 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5';
  const HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';

  let service;
  let verificationService;

  const nostrEvent = (id, secondsAgo, overrides = {}) => ({
    id,
    pubkey: HEX,
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000) - secondsAgo,
    sig: 'f'.repeat(128),
    content: `post ${id}`,
    ...overrides
  });

  const relayResult = (events, relaysOk = 3) => ({ events, relaysOk, relaysTotal: 3 });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MonitoringService();
    verificationService = makeVerificationService();
    service.initialize(verificationService);
    // _recordCollection reloads and saves; by default hand back what it asked for.
    dataStore.loadCommitment.mockImplementation(async () => makeCommitment({ pubkey: HEX }));
    dataStore.saveCommitment.mockResolvedValue(undefined);
  });

  it('queries by author, not by subclaw feed', async () => {
    // getFeed reads one community feed and filters by author, so an agent
    // posting anywhere else is invisible and 50 items is a tiny window.
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([nostrEvent('a', 3600)]));

    await service.checkCommitment(makeCommitment({ pubkey: HEX }));

    expect(clawstrApi.getFeed).not.toHaveBeenCalled();
    expect(clawstrApi.getEventsByAuthor).toHaveBeenCalledWith(HEX, expect.objectContaining({
      since: expect.any(Number),
      until: expect.any(Number)
    }));
  });

  it('decodes an npub stored by a path that does not go through the gate', async () => {
    // discovery-service and the free API route write pubkey unnormalised.
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([]));

    await service.checkCommitment(makeCommitment({ pubkey: NPUB }));

    expect(clawstrApi.getEventsByAuthor).toHaveBeenCalledWith(HEX, expect.anything());
  });

  it('records evidence with the fields verification-rules requires', async () => {
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([nostrEvent('a', 3600)]));

    await service.checkCommitment(makeCommitment({ pubkey: HEX }));

    const [, evidence] = verificationService.addEvidence.mock.calls[0];
    // _validateEvidence drops silently on a missing required field.
    expect(evidence.event_id).toBe('a');
    expect(evidence.timestamp).toEqual(expect.any(String));
    expect(evidence.signature).toHaveLength(128);
    expect(evidence.collected_at).toEqual(expect.any(String));
  });

  it('does not count the same event twice when two relays both return it', async () => {
    const dupe = nostrEvent('same', 3600);
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([dupe, { ...dupe }]));

    await service.checkCommitment(makeCommitment({ pubkey: HEX }));

    expect(verificationService.addEvidence).toHaveBeenCalledTimes(1);
  });

  it('does not drop new evidence because an existing item has no key', async () => {
    // The seen-set used to take `undefined` from a keyless item, which then
    // matched the next keyless item and silently discarded it.
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([nostrEvent('a', 3600)]));
    const commitment = makeCommitment({ pubkey: HEX, evidence: [{ platform: 'clawstr' }] });

    await service.checkCommitment(commitment);

    expect(verificationService.addEvidence).toHaveBeenCalledTimes(1);
  });

  it('rejects events outside the commitment window, including future-dated ones', async () => {
    // created_at is set by the author, so backdating and future-dating are both
    // things a scored agent controls.
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([
      nostrEvent('inside', 3600),
      nostrEvent('before-start', 5 * 86400),
      nostrEvent('far-future', -30 * 86400)
    ]));

    await service.checkCommitment(makeCommitment({ pubkey: HEX }));

    const ids = verificationService.addEvidence.mock.calls.map(c => c[1].event_id);
    expect(ids).toEqual(['inside']);
  });

  it('records a failed collection without crediting it as a success', async () => {
    // An unreachable relay yields the same empty result as an inactive agent.
    // last_success_at is what lets scoring tell them apart.
    clawstrApi.getEventsByAuthor.mockRejectedValue(new Error('all relays down'));

    await service.checkCommitment(makeCommitment({ pubkey: HEX }));

    expect(verificationService.addEvidence).not.toHaveBeenCalled();
    const saved = dataStore.saveCommitment.mock.calls[0][0];
    expect(saved.monitoring.last_success_at).toBeNull();
    expect(saved.monitoring.consecutive_failures).toBe(1);
  });

  it('still offers an ended commitment for scoring when collection failed', async () => {
    // Returning early here instead would mean a lasting outage never scores at
    // all: the commitment sits active forever and the customer never gets the
    // receipt they paid for. The grace window in verification-service is what
    // bounds it, so scoring has to be reached for that check to run.
    clawstrApi.getEventsByAuthor.mockRejectedValue(new Error('all relays down'));
    const expired = makeCommitment({
      pubkey: HEX,
      end_date: new Date(Date.now() - 1000).toISOString()
    });
    dataStore.loadCommitment.mockResolvedValue(expired);

    await service.checkCommitment(expired);

    expect(verificationService.scoreVerification).toHaveBeenCalledWith(expired.commitment_id);
  });

  it('marks a partial relay outage as an unsuccessful collection', async () => {
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([nostrEvent('a', 3600)], 1));

    await service.checkCommitment(makeCommitment({ pubkey: HEX }));

    const saved = dataStore.saveCommitment.mock.calls[0][0];
    expect(saved.monitoring.last_success_at).toBeNull();
  });

  it('scores an expired commitment once collection has succeeded', async () => {
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([nostrEvent('a', 3600)]));
    const expired = makeCommitment({
      pubkey: HEX,
      end_date: new Date(Date.now() - 1000).toISOString()
    });
    dataStore.loadCommitment.mockResolvedValue(expired);

    await service.checkCommitment(expired);

    expect(verificationService.scoreVerification).toHaveBeenCalledWith(expired.commitment_id);
  });

  it('scores against the reloaded commitment, not the stale batch snapshot', async () => {
    // addEvidence rewrites the file, so the snapshot checkAllActive handed down
    // is out of date by the time expiry is evaluated.
    clawstrApi.getEventsByAuthor.mockResolvedValue(relayResult([]));
    const stale = makeCommitment({ pubkey: HEX, status: 'active' });
    dataStore.loadCommitment.mockResolvedValue(
      makeCommitment({ pubkey: HEX, status: 'verified', end_date: new Date(Date.now() - 1000).toISOString() })
    );

    await service.checkCommitment(stale);

    expect(verificationService.scoreVerification).not.toHaveBeenCalled();
  });

  it('treats an undecodable pubkey as nothing to collect, not a retryable fault', async () => {
    await service.checkCommitment(makeCommitment({ pubkey: 'not-a-key', platform_profiles: {} }));

    expect(clawstrApi.getEventsByAuthor).not.toHaveBeenCalled();
    expect(verificationService.addEvidence).not.toHaveBeenCalled();
    const saved = dataStore.saveCommitment.mock.calls[0][0];
    // Retrying an unparseable key forever would never succeed.
    expect(saved.monitoring.last_success_at).toEqual(expect.any(String));
  });
});
