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

const request = require('supertest');
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
      expect(res.body.details).toMatch(/platform is required/);
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
      expect(res.body.details).toMatch(/platform_handle is required/);
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
    });
  });
});
