// tests/x402-server.test.js
// HTTP-level tests for the x402 verification server.
//
// Runs with X402_TEST_MODE=true so the payment middleware is skipped and these
// assertions isolate the handler contract — the part an OKX reviewer probes.
// The 402 shape itself needs a live facilitator and is covered by
// scripts/okx-preflight-check.js against a deployed URL.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be set before requiring the server: both are read at module load.
process.env.X402_TEST_MODE = 'true';
process.env.NETWORK_ID = 'base_mainnet';
process.env.DEFAULT_NETWORK = 'base_mainnet';
process.env.ALLOW_EPHEMERAL_SIGNING_KEY = 'true';
delete process.env.NODE_ENV;
delete process.env.OKX_LISTED;

// Dummy OKX credentials so the server constructs its X-Layer facilitator
// client and exercises the "both networks" accepts[] path below. Safe: in
// TEST_MODE the resource server is never initialized, so OKXFacilitatorClient
// never makes a real HTTP call — its constructor does no I/O.
process.env.OKX_API_KEY = 'test';
process.env.OKX_SECRET_KEY = 'test';
process.env.OKX_PASSPHRASE = 'test';

// A fresh empty directory, so the first request exercises the same cold-start
// path a new Railway volume would.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetix-x402-'));
process.env.DATA_DIR = TEST_DATA_DIR;

// @coinbase/x402 pulls in `jose`, which ships ESM that Jest cannot parse under
// this repo's transform-free setup. Only createFacilitatorConfig is used, and
// in test mode the facilitator is never initialized, so a stub is sufficient.
jest.mock('@coinbase/x402', () => ({
  createFacilitatorConfig: () => ({ url: 'https://facilitator.test.invalid' })
}));

// This file requires the REAL api/x402/server.js, which requires the REAL
// verification-service.js singleton — meaning the tests below that let a
// commitment expire and score (see "scores an expired commitment..." and
// "exposes receipt_id..." further down) run the REAL issueAttestation()
// path, including its best-effort on-chain submission calls, unless every
// external side effect it can reach is mocked here.
//
// This file sets NETWORK_ID/DEFAULT_NETWORK to base_mainnet (above) and
// nothing in this repo substitutes a fake signing key for eas-attestation.js
// or erc8004-reputation.js (only attestation-service.js has an
// ALLOW_EPHEMERAL_SIGNING_KEY escape hatch, for the receipt SIGNING key, not
// these). Both modules call require('dotenv').config() at their own top
// level and pick up the real KINETIX_SIGNING_KEY from .env regardless of
// this file's test-mode flags. Before these mocks existed, that combination
// broadcast 6 real attest() transactions to Base MAINNET from Kinetix's
// actual production wallet during a routine `npx jest` run — the ERC-8004
// leg was accidentally safe only because these tests' payloads never include
// erc8004_token_id, so _mapReceiptToFeedback throws before any network call;
// EAS had no equivalent guard once eas-attestation.js stopped throwing
// NO_WALLET for a walletless recipient (see utils/eas-attestation.js) and
// started anchoring at the zero address instead. ipfs-manager.js is real
// Pinata credentials from .env too, so it is mocked for the same reason —
// independent of the on-chain issue, an unmocked run here was pinning test
// fixture data to public IPFS on every test run.
//
// Do not remove these mocks to "test the real path" — use
// scripts/seed-okx-receipt.js (which is deliberately gated behind --confirm
// and a manual balance check) for that instead.
jest.mock('../utils/ipfs-manager', () => ({
  uploadJSON: jest.fn().mockResolvedValue({
    ipfsHash: 'QmTestFixtureNotARealPin',
    gatewayUrl: 'https://gateway.pinata.cloud/ipfs/QmTestFixtureNotARealPin'
  })
}));
jest.mock('../utils/eas-attestation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  submitAttestation: jest.fn().mockResolvedValue({
    uid: '0xtest-eas-uid',
    txHash: '0xtest-eas-tx',
    explorerUrl: 'https://test.invalid/attestation/0xtest-eas-uid',
    recipient: '0x0000000000000000000000000000000000000000',
    anchorMode: 'unattributed'
  }),
  networkName: 'base_mainnet',
  network: { schemaUID: '0x' + 'ab'.repeat(32) }
}));
jest.mock('../utils/erc8004-reputation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  // None of this file's payloads ever set erc8004_token_id, so the real
  // module would reject every attempt with NOT_REGISTERED before any network
  // call anyway (see utils/erc8004-reputation.js _mapReceiptToFeedback) —
  // this mock just makes that explicit and removes the real module's own
  // require('dotenv').config()/createSigner() from the load path entirely.
  submitAttestation: jest.fn().mockRejectedValue(
    Object.assign(new Error('Recipient has no erc8004_token_id.'), { code: 'NOT_REGISTERED' })
  ),
  networkName: 'base_mainnet'
}));

const request = require('supertest');
const clawstrApi = require('../utils/clawstr-api');
const server = require('../api/x402/server');

// Kinetix's own live Clawstr identity, and the hex it decodes to. The gate
// bech32-decodes the handle now, so a placeholder like 'npub1testhandle' is a
// checksum failure and a 400.
const KINETIX_NPUB = 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5';
const KINETIX_HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';

const validPayload = {
  agent_id: 'agent_test_001',
  commitment_description: 'Post a daily build log for 7 days',
  verification_type: 'consistency',
  platform: 'clawstr',
  // Kinetix's own Clawstr identity: a real npub, because the gate now decodes it.
  platform_handle: KINETIX_NPUB,
  criteria: { duration_days: 7, frequency: 'daily', minimum_actions: 7 }
};

// Read a stored commitment the way monitoring-service would.
function readCommitment(commitmentId) {
  return JSON.parse(
    fs.readFileSync(path.join(TEST_DATA_DIR, 'commitments', `${commitmentId}.json`), 'utf8')
  );
}

describe('x402 verification server', () => {
  beforeAll(async () => {
    await server.initializeServices();
  });

  // The paid response carries a baseline snapshot read from the Nostr relays.
  // Never reach them from a test: stub the one query the baseline makes with
  // a day of recent activity. Individual tests override it.
  let eventsByAuthor;
  beforeEach(() => {
    const now = Math.floor(Date.now() / 1000);
    eventsByAuthor = jest.spyOn(clawstrApi, 'getEventsByAuthor').mockResolvedValue({
      events: [
        { id: 'e1', created_at: now - 3600, content: 'build log day 1' },
        { id: 'e2', created_at: now - 7200, content: 'build log day 1, part 2' }
      ],
      relaysOk: 3,
      relaysTotal: 3
    });
  });
  afterEach(() => {
    eventsByAuthor.mockRestore();
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe('POST /api/x402/verify/premium', () => {
    it('creates a commitment on a cold data directory', async () => {
      // Regression lock: initializeServices must create the data directories,
      // which are gitignored and therefore absent from a fresh deploy image.
      const res = await request(server).post('/api/x402/verify/premium').send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.commitment_id).toMatch(/^cmt_kx_/);
      expect(res.body.tier).toBe('premium');
      expect(res.body.features).toEqual(['all_scoring', 'ipfs_upload', 'erc8004_submission']);
    });

    it('rejects a missing agent_id with 400 and the required field list', async () => {
      const { agent_id, ...withoutAgentId } = validPayload;
      const res = await request(server).post('/api/x402/verify/premium').send(withoutAgentId);

      expect(res.status).toBe(400);
      expect(res.body.required).toContain('agent_id');
    });

    it('rejects an unknown verification_type with 400, not 500', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, verification_type: 'fraud' });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/Invalid verification_type/);
    });

    it('rejects a non-numeric duration_days with 400 rather than a Date RangeError', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { ...validPayload.criteria, duration_days: 'abc' } });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/duration_days/);
    });

    it('rejects a negative duration_days instead of accepting a past end date', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { ...validPayload.criteria, duration_days: -5 } });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/duration_days/);
    });

    it('rejects a non-object criteria with 400', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: 'not-an-object' });

      expect(res.status).toBe(400);
    });

    it('refuses to sell a verification with no observable platform', async () => {
      // Without a platform, nothing collects evidence and the verification is
      // guaranteed to score 0/failed regardless of what the agent does. A 400
      // here also means @x402/express skips settlement, so nobody is charged.
      const { platform, ...withoutPlatform } = validPayload;
      const res = await request(server).post('/api/x402/verify/premium').send(withoutPlatform);

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/Missing required field: platform/);
      expect(res.body.missing[0]).toMatchObject({ field: 'platform', example: 'clawstr' });
    });

    it('refuses a platform with no working evidence collector', async () => {
      // monitoring-service has a telegram branch, but it falls through to
      // "not yet implemented" and would collect nothing.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform: 'telegram' });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/Unsupported platform/);
    });

    it('refuses a platform with no handle', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform_handle: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/Missing required field: platform_handle/);
      expect(res.body.missing[0].example).toBe(KINETIX_NPUB);
    });

    it('persists the monitoring target so evidence collection can find the agent', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform: 'clawstr', platform_handle: KINETIX_NPUB });
      expect(res.status).toBe(200);

      // Read the stored commitment the way monitoring-service would.
      const stored = JSON.parse(
        fs.readFileSync(path.join(TEST_DATA_DIR, 'commitments', `${res.body.commitment_id}.json`), 'utf8')
      );
      expect(stored.criteria.platform).toBe('clawstr');
      // The handle as given is kept for display...
      expect(stored.platform_profiles.clawstr).toBe(KINETIX_NPUB);
      // ...but `pubkey` must be hex. Relays return hex in event.pubkey, so a
      // stored npub matches no event and the commitment collects nothing while
      // looking valid. This assertion previously expected the raw npub.
      expect(stored.pubkey).toBe(KINETIX_HEX);
    });

    it('accepts a bare hex handle and normalises its case', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform_handle: KINETIX_HEX.toUpperCase() });

      expect(res.status).toBe(200);
      expect(readCommitment(res.body.commitment_id).pubkey).toBe(KINETIX_HEX);
    });

    it('rejects a malformed clawstr handle before charging for it', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform_handle: 'npub1nonsense' });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/clawstr platform_handle/);
    });

    it('refuses moltbook while its collector cannot attribute evidence', async () => {
      // moltbookApi.search is a text search with no author filter, so any post
      // mentioning the handle would become that agent's evidence.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform: 'moltbook', platform_handle: 'some_agent' });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/Unsupported platform/);
    });

    it('pins a minimum_actions target when the caller omits one', async () => {
      // Not in any inputSchema, so advanced/premium callers cannot supply it.
      // Left undefined it made completion_rate NaN, which _getStatus reports as
      // 'failed' — a paid verification that collected evidence and scored zero.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { duration_days: 7, frequency: 'daily' } });

      expect(res.status).toBe(200);
      const stored = readCommitment(res.body.commitment_id);
      expect(stored.criteria.minimum_actions).toBe(7);
    });

    it('rejects a minimum_actions of 0 rather than selling a guaranteed pass', async () => {
      // completed/0 is Infinity, clamped to a completion_rate of 100.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { ...validPayload.criteria, minimum_actions: 0 } });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/minimum_actions/);
    });

    it('clamps duration_days to the tier cap', async () => {
      // The clamp used to be overwritten by a later spread of the caller's
      // criteria, so a tier cap could be bought past at tier price.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { ...validPayload.criteria, duration_days: 3650 } });

      expect(res.status).toBe(200);

      const status = await request(server).get(`/api/x402/verify/${res.body.commitment_id}/status`);
      const windowDays =
        (new Date(status.body.end_date) - new Date(status.body.created_at)) / (24 * 60 * 60 * 1000);
      expect(Math.round(windowDays)).toBe(90);
    });

    it('never echoes internal error detail on a server fault', async () => {
      // Anything that does reach a 500 must not carry error.message, which for
      // an fs or RPC failure leaks container paths to an anonymous caller.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { milestones: [{ deadline: 'not-a-date' }] } });

      if (res.status === 500) {
        expect(res.body.details).toBeUndefined();
      }
    });

    it('rejects verification_type "time_bound" with no milestones before payment (OKX round-6 regression)', async () => {
      // This exact combination was the discovery example's own default
      // (criteria: { duration_days: 30 }, verification_type: 'time_bound')
      // until this fix — it passed payment and crashed at scoring, unguarded
      // by _validateCommitment. Must now 400 before a 402 is ever issued.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, verification_type: 'time_bound', criteria: { duration_days: 30 } });

      expect(res.status).toBe(400);
      expect(res.headers['payment-required']).toBeUndefined();
    });

    it('rejects verification_type "quality" with no quality_metrics/minimum_samples before payment', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, verification_type: 'quality', criteria: { duration_days: 14 } });

      expect(res.status).toBe(400);
      expect(res.headers['payment-required']).toBeUndefined();
    });

    it('refuses even a well-formed time_bound request, which could only ever score failed', async () => {
      // The Clawstr collector never tags evidence with a milestone_id, so
      // _scoreTimeBound marks every milestone missed. Selling it takes payment
      // for a foregone `failed`.
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({
          ...validPayload,
          verification_type: 'time_bound',
          criteria: { milestones: [{ milestone_id: 'm1', deadline: '2026-12-01T00:00:00Z' }] }
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_VERIFICATION_TYPE');
      expect(res.body.example).toBe('consistency');
      expect(res.headers['payment-required']).toBeUndefined();
    });
  });

  describe('POST /api/x402/verify/advanced', () => {
    it('rejects verification_type "quality" with no quality_metrics/minimum_samples before payment', async () => {
      const res = await request(server)
        .post('/api/x402/verify/advanced')
        .send({ ...validPayload, criteria: { verification_type: 'quality', duration_days: 14 } });

      expect(res.status).toBe(400);
      expect(res.headers['payment-required']).toBeUndefined();
    });

    it('accepts a quality request judged on post length', async () => {
      const res = await request(server)
        .post('/api/x402/verify/advanced')
        .send({
          ...validPayload,
          criteria: {
            verification_type: 'quality',
            duration_days: 14,
            quality_metrics: { minimum_length: 10 },
            minimum_samples: 5
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.baseline.outlook_reason).toMatch(/10-character minimum/);
    });

    it('refuses quality metrics no Clawstr evidence carries', async () => {
      // response_time_minutes is read from a field the collector never sets,
      // so it would score 0 whatever the agent did.
      const res = await request(server)
        .post('/api/x402/verify/advanced')
        .send({
          ...validPayload,
          criteria: {
            verification_type: 'quality',
            duration_days: 14,
            quality_metrics: { response_time_minutes: 30 },
            minimum_samples: 5
          }
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_QUALITY_METRIC');
      expect(res.body.details).toMatch(/response_time_minutes/);
    });
  });

  describe('POST /api/x402/verify/basic', () => {
    it('requires an action per day, not a single action for the whole window', async () => {
      // The route hardcoded minimum_actions: 1 against a 7-day daily window, so
      // one post scored 100% completion and sold a `verified` receipt.
      const res = await request(server).post('/api/x402/verify/basic').send({
        agent_id: 'agent_basic_001',
        platform: 'clawstr',
        platform_handle: KINETIX_NPUB
      });

      expect(res.status).toBe(200);
      const stored = readCommitment(res.body.commitment_id);
      expect(stored.criteria.minimum_actions).toBe(stored.criteria.duration_days);
    });
  });

  describe('free endpoints', () => {
    it('serves the attestation lookup without payment, 404 for an unknown id', async () => {
      // A 402 here would mean the payment middleware over-matched.
      const res = await request(server).get('/api/v1/attestation/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Attestation not found' });
    });

    it('serves the status route without payment, 404 for an unknown id', async () => {
      const res = await request(server).get('/api/x402/verify/cmt_kx_missing/status');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Verification not found' });
    });

    it('reports collection health so a deferral is not mistaken for a hang', async () => {
      const created = await request(server).post('/api/x402/verify/premium').send(validPayload);
      const res = await request(server).get(`/api/x402/verify/${created.body.commitment_id}/status`);

      expect(res.status).toBe(200);
      // No tick has run in-process, so nothing has written a monitoring block.
      expect(res.body.collection).toEqual({ state: 'not_monitored' });
    });

    it('reports status for a real commitment', async () => {
      const created = await request(server).post('/api/x402/verify/premium').send(validPayload);
      const res = await request(server).get(`/api/x402/verify/${created.body.commitment_id}/status`);

      expect(res.status).toBe(200);
      expect(res.body.verification_id).toBe(created.body.commitment_id);
    });

    it('scores an expired commitment exactly once under concurrent polls', async () => {
      // The status route triggers scoring, and scoring issues the attestation
      // and (for an ERC-8004-registered recipient) broadcasts giveFeedback.
      // Without serialization, simultaneous polls each ran the whole path —
      // two receipts and two transactions for one payment.
      const attestationsDir = path.join(TEST_DATA_DIR, 'attestations');
      const before = fs.readdirSync(attestationsDir).length;

      const created = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { duration_days: 0.00002 } }); // ~1.7s
      expect(created.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 2500));

      const polls = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(server).get(`/api/x402/verify/${created.body.commitment_id}/status`)
        )
      );

      polls.forEach(res => expect(res.status).toBe(200));
      expect(fs.readdirSync(attestationsDir).length).toBe(before + 1);
    }, 15000);

    it('exposes receipt_id on repeat polls so a buyer can fetch what they paid for', async () => {
      const created = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: { duration_days: 0.00002 } }); // ~1.7s

      await new Promise(resolve => setTimeout(resolve, 2500));

      // First poll triggers scoring; the second is the one that used to return
      // a trimmed object with no receipt_id, stranding the buyer.
      const first = await request(server).get(`/api/x402/verify/${created.body.commitment_id}/status`);
      const second = await request(server).get(`/api/x402/verify/${created.body.commitment_id}/status`);

      expect(first.body.receipt_id).toBeTruthy();
      expect(second.body.receipt_id).toBe(first.body.receipt_id);
      expect(Object.keys(second.body).sort()).toEqual(Object.keys(first.body).sort());

      const receipt = await request(server).get(`/api/v1/attestation/${second.body.receipt_id}`);
      expect(receipt.status).toBe(200);
      expect(receipt.body.receipt_id).toBe(second.body.receipt_id);
    }, 15000);

    it('reports health with the mainnet ERC-8004 token id', async () => {
      const res = await request(server).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('operational');
      expect(res.body.erc8004_token_id).toBe(16892);
      expect(res.body.x402_network).toBe('eip155:8453');
      expect(res.body.x402_networks).toEqual(['eip155:196', 'eip155:8453']);
    });
  });

  // OKX AI rejected this listing seven times. The cause was that the paid
  // routes were registered POST-only, so OKX's own probe
  // (`onchainos agent x402-check --endpoint …`, which issues a GET) fell past
  // every handler to Express's HTML 404 and reported "not a valid x402
  // service" — meaning their stack could never read the Bazaar inputSchema
  // that documents our parameters.
  //
  // These tests run with X402_TEST_MODE=true, so the payment middleware is not
  // mounted and a 402 cannot be asserted here — scripts/okx-preflight-check.js
  // covers that against a live deploy. What Jest locks is that the routes
  // EXIST for these verbs and never fall through to a 404.
  describe('parameterless probes (OKX discovery)', () => {
    const tiers = [
      { tier: 'basic', required: ['agent_id', 'platform', 'platform_handle'] },
      { tier: 'advanced', required: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle'] },
      { tier: 'premium', required: ['agent_id', 'commitment_description', 'platform', 'platform_handle'] }
    ];

    it.each(tiers)('GET /$tier with no parameters is a probe, and a paid one is told how to call', async ({ tier, required }) => {
      const res = await request(server).get(`/api/x402/verify/${tier}`);

      // In production the payment middleware answers this with the 402
      // challenge first; reaching the handler means it arrived paid. It must
      // be 4xx (unsettled) and say exactly how to repeat it correctly — it
      // used to be a 405, the dead end OKX's GET-replaying buyers hit.
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_PARAMETERS');
      expect(res.body.charged).toBe(false);
      expect(res.body.required).toEqual(required);
      expect(res.body.how_to_call.method).toBe('POST');
      expect(res.body.how_to_call.example_request.agent_id).toBeTruthy();
      expect(res.body.how_to_call.example_get).toMatch(new RegExp(`^/api/x402/verify/${tier}\\?`));
    });

    it.each(tiers)('POST /$tier with no body is treated as a probe, not bad input', async ({ tier, required }) => {
      // In production this same request never reaches the handler: the payment
      // middleware answers it with the 402 challenge. Arriving here means it
      // came in paid, and a 400 keeps @x402/express from settling.
      const res = await request(server).post(`/api/x402/verify/${tier}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing request body');
      expect(res.body.required).toEqual(required);
      expect(res.text).not.toMatch(/ENOENT|node_modules/);
    });

    it.each(tiers)('POST /$tier with {} is treated the same as no body', async ({ tier }) => {
      const res = await request(server).post(`/api/x402/verify/${tier}`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing request body');
    });

    it('rejects an array body rather than treating it as an empty probe', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .set('Content-Type', 'application/json')
        .send('[]');

      expect(res.status).toBe(400);
      // Not the probe path: an array carries no keys but is malformed input.
      expect(res.body.error).not.toBe('Missing request body');
    });

    it('keys every paid route under both GET and POST, sharing one config', () => {
      const { protectedRoutes } = server;

      for (const { tier } of tiers) {
        const post = protectedRoutes[`POST /api/x402/verify/${tier}`];
        const get = protectedRoutes[`GET /api/x402/verify/${tier}`];

        expect(post).toBeDefined();
        expect(get).toBeDefined();
        // Same object reference, so the GET and POST challenges cannot drift.
        expect(get).toBe(post);
        expect(protectedRoutes[`HEAD /api/x402/verify/${tier}`]).toBe(post);
        expect(get.accepts.some(a => a.network === 'eip155:196')).toBe(true);
      }
    });
  });

  // OKX AI delisted this service (2026-09-30): "did not deliver after the
  // buyer completed payment ... error responses unclear". Each test below
  // pins one of the concrete failures traced from production logs.
  describe('delivery on payment (OKX round 10)', () => {
    const attestationService = require('../services/attestation-service');

    it('delivers a signed certificate, a baseline and next steps, not just an id', async () => {
      const res = await request(server).post('/api/x402/verify/premium').send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.delivered).toEqual(['certificate', 'baseline']);
      expect(res.body.summary).toMatch(/Monitoring started for agent_test_001/);

      const { certificate } = res.body;
      expect(certificate.type).toBe('kinetix_commitment_certificate');
      expect(certificate.commitment_id).toBe(res.body.commitment_id);
      expect(certificate.pubkey).toBe(KINETIX_HEX);
      expect(certificate.criteria.minimum_actions).toBe(7);
      // Checkable by anyone with the published address, the same way as a receipt.
      expect(attestationService.verifyReceipt(certificate)).toBe(true);
      expect(attestationService.verifyReceipt({ ...certificate, agent_id: 'someone_else' })).toBe(false);

      expect(res.body.baseline).toMatchObject({ status: 'complete', events_found: 2, active_days: 1 });
      expect(res.body.next_steps.status_url).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:\\d+/api/x402/verify/${res.body.commitment_id}/status$`)
      );
      expect(res.body.final_receipt_expected_by).toBeTruthy();

      // Stored with the commitment, in the same write.
      expect(readCommitment(res.body.commitment_id).certificate.signatures.kinetix_signature)
        .toBe(certificate.signatures.kinetix_signature);
    });

    it('still delivers when the relays are down, with the baseline marked unavailable', async () => {
      eventsByAuthor.mockRejectedValue(new Error('all relays down'));

      const res = await request(server).post('/api/x402/verify/premium').send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.certificate).toBeTruthy();
      expect(res.body.baseline.status).toBe('unavailable');
      expect(res.body.baseline.reason).not.toMatch(/all relays down/);
    });

    it('performs the verification on a paid GET with query parameters (OKX replays with GET)', async () => {
      const res = await request(server)
        .get('/api/x402/verify/premium')
        .query({
          agent_id: 'agent_get_001',
          commitment_description: 'Post daily for 7 days',
          platform: 'clawstr',
          platform_handle: KINETIX_NPUB,
          criteria: JSON.stringify({ duration_days: 7, frequency: 'daily' })
        });

      expect(res.status).toBe(200);
      const stored = readCommitment(res.body.commitment_id);
      expect(stored.agent_id).toBe('agent_get_001');
      expect(stored.criteria).toMatchObject({ duration_days: 7, frequency: 'daily', minimum_actions: 7 });
    });

    it('accepts criteria as dotted query keys, coercing numbers', async () => {
      const res = await request(server)
        .get('/api/x402/verify/premium')
        .query({
          agent_id: 'agent_get_002',
          commitment_description: 'Post weekly',
          platform: 'clawstr',
          platform_handle: KINETIX_HEX,
          'criteria.duration_days': '14',
          'criteria.frequency': 'weekly'
        });

      expect(res.status).toBe(200);
      const stored = readCommitment(res.body.commitment_id);
      expect(stored.criteria.duration_days).toBe(14);
      expect(stored.criteria.frequency).toBe('weekly');
    });

    it('validates GET query parameters before any 402', async () => {
      const res = await request(server)
        .get('/api/x402/verify/premium')
        .query({ agent_id: '13373', commitment_description: 'test', platform: 'clawstr', platform_handle: 'test' });

      expect(res.status).toBe(400);
      expect(res.headers['payment-required']).toBeUndefined();
      expect(res.body.field).toBe('platform_handle');
    });

    it('accepts criteria sent as a JSON string in a POST body (OKX types it as a string)', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: '{"duration_days":7,"frequency":"daily"}' });

      expect(res.status).toBe(200);
      expect(readCommitment(res.body.commitment_id).criteria.frequency).toBe('daily');
    });

    it('explains a corrupted npub without echoing the checksum a buyer once prepended', async () => {
      // The exact value a buyer sent on 2026-09-30: five characters dropped.
      const truncated = 'npub1xpxr0awey3j9q3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5';
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform_handle: truncated });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVALID_PLATFORM_HANDLE',
        field: 'platform_handle',
        received: truncated,
        example: KINETIX_NPUB,
        charged: false
      });
      expect(res.body.error).toMatch(/58 characters long/);
      expect(res.text).not.toMatch(/checksum|expected "/i);
    });

    it('names the field and a real example for the placeholder "test"', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, platform_handle: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/"test" is not a Nostr public key/);
      expect(res.body.example).toBe(KINETIX_NPUB);
      expect(res.body.payment_note).toMatch(/not charged/);
      expect(res.body.how_to_call.example_request.platform_handle).toBe(KINETIX_NPUB);
    });

    it('lists every missing field with its type and an example', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ agent_id: 'a1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing required fields: commitment_description, platform, platform_handle');
      expect(res.body.missing.map(m => m.field)).toEqual(['commitment_description', 'platform', 'platform_handle']);
      for (const m of res.body.missing) {
        expect(m.type).toBe('string');
        expect(m.example).toBeTruthy();
      }
    });

    it('answers malformed JSON and unknown routes with JSON, not HTML', async () => {
      const bad = await request(server)
        .post('/api/x402/verify/premium')
        .set('Content-Type', 'application/json')
        .send('{"agent_id": ');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_JSON');

      const missing = await request(server).get('/api/x402/verify/platinum');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('NOT_FOUND');
    });

    it('links the receipt from the status route', async () => {
      const created = await request(server).post('/api/x402/verify/premium').send(validPayload);
      const res = await request(server).get(`/api/x402/verify/${created.body.commitment_id}/status`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('receipt_url', null);
    });

    it('records the payment as pending settlement, never pre-confirmed', async () => {
      const created = await request(server).post('/api/x402/verify/premium').send(validPayload);
      const dir = path.join(TEST_DATA_DIR, 'x402-payments');
      const record = fs.readdirSync(dir)
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
        .find(p => p.commitment_id === created.body.commitment_id);

      expect(record.status).toBe('pending_settlement');
    });

    it('declares parameters where OKX\'s buyer CLI reads them, so its paid replay carries them', () => {
      // `onchainos payment pay` replays with only the params named in the
      // challenge's top-level outputSchema.input; without it a real buyer's
      // paid replay arrived empty (2026-10-01).
      const challenge = { x402Version: 2, accepts: [{ scheme: 'exact' }] };
      const encoded = Buffer.from(JSON.stringify(challenge)).toString('base64');
      const out = JSON.parse(Buffer.from(server.withOutputSchema(encoded, 'premium'), 'base64').toString('utf8'));

      expect(out.accepts).toEqual(challenge.accepts);
      expect(out.outputSchema.method).toBe('GET');
      expect(out.outputSchema.input.platform_handle).toMatchObject({ type: 'string', required: true });
      expect(out.outputSchema.input.criteria).toMatchObject({ type: 'object', required: false });
      expect(Object.keys(out.outputSchema.input).filter(k => out.outputSchema.input[k].required).sort())
        .toEqual(['agent_id', 'commitment_description', 'platform', 'platform_handle']);
      // A header it cannot parse passes through untouched.
      expect(server.withOutputSchema('not base64 json', 'premium')).toBe('not base64 json');
    });

    it.each(['basic', 'advanced', 'premium'])(
      'the advertised %s examples succeed verbatim, as POST and as GET',
      async tier => {
        const discovery = require('../api/x402/server').protectedRoutes[`POST /api/x402/verify/${tier}`]
          .extensions.bazaar;
        const body = discovery.info.input.body;

        const post = await request(server).post(`/api/x402/verify/${tier}`).send(body);
        expect(post.status).toBe(200);

        const probe = await request(server).post(`/api/x402/verify/${tier}`).send({ agent_id: 'x' });
        const get = await request(server).get(probe.body.how_to_call.example_get);
        expect(get.status).toBe(200);
      }
    );
  });

  describe('premium criteria is optional', () => {
    it('defaults an omitted criteria to a 7-day daily consistency window', async () => {
      // criteria used to be required while `criteria: {}` already produced
      // exactly this — so the requirement only forced a caller to name a
      // polymorphic parameter OKX said could not be inferred.
      const { criteria, verification_type, ...withoutCriteria } = validPayload;
      const res = await request(server).post('/api/x402/verify/premium').send(withoutCriteria);

      expect(res.status).toBe(200);

      const stored = readCommitment(res.body.commitment_id);
      expect(stored.verification_type).toBe('consistency');
      expect(stored.criteria.duration_days).toBe(7);
      // Derived, not 1: a 1-action target over a 7-day window would sell a
      // `verified` receipt for a single post.
      expect(stored.criteria.minimum_actions).toBe(7);
    });

    it('still rejects a criteria that is present but not an object', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, criteria: 'not-an-object' });

      expect(res.status).toBe(400);
    });

    it('still requires quality sub-fields when that type is chosen', async () => {
      const res = await request(server)
        .post('/api/x402/verify/premium')
        .send({ ...validPayload, verification_type: 'quality', criteria: undefined });

      expect(res.status).toBe(400);
      expect(res.body.field).toBe('criteria.quality_metrics');
    });
  });
});
