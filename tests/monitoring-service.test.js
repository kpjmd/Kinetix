// tests/monitoring-service.test.js
// Tests for the evidence-collection scheduler. Mocks data-store and both
// platform clients — no relays, no nak binary, no Moltbook API.
//
// Scope note: this file covers the scheduler and the per-run bounds. The
// collectors themselves are exercised separately.

jest.mock('../services/data-store');
jest.mock('../utils/moltbook-api', () => ({ search: jest.fn() }));
jest.mock('../utils/clawstr-api', () => ({ getFeed: jest.fn() }));

const dataStore = require('../services/data-store');
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
