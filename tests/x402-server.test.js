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

const validPayload = {
  agent_id: 'agent_test_001',
  commitment_description: 'Post a daily build log for 7 days',
  verification_type: 'consistency',
  criteria: { duration_days: 7, frequency: 'daily', minimum_actions: 7 }
};

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

    it('reports health with the mainnet ERC-8004 token id', async () => {
      const res = await request(server).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('operational');
      expect(res.body.erc8004_token_id).toBe(16892);
      expect(res.body.x402_network).toBe('eip155:8453');
    });
  });
});
