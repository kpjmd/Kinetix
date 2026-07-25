// tests/discovery-service.test.js
// Regression test for the dedup-key bug: a decided (approved/rejected)
// suggestion must not permanently block future requests with the same
// agent_id + normalized_claim.

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

describe('DiscoveryService dedup', () => {
  let tmpDir;
  let discoveryService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kinetix-discovery-test-'));
    process.env.DATA_DIR = tmpDir;
    jest.resetModules();
    discoveryService = require('../services/discovery-service');
    await discoveryService.ensureDirectory();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeRequest(overrides = {}) {
    return {
      agent_id: 'agent_test',
      source_platform: 'moltbook',
      claim_text: 'I post daily',
      normalized_claim: 'i post daily',
      suggested_verification: { verification_type: 'consistency', description: 'daily posting' },
      ...overrides
    };
  }

  it('blocks a second request while the first is still pending', async () => {
    const first = await discoveryService.addVerificationRequest(makeRequest());
    expect(first).not.toBeNull();

    const second = await discoveryService.addVerificationRequest(makeRequest());
    expect(second).toBeNull();
  });

  it('allows a new request once the prior one was rejected', async () => {
    const first = await discoveryService.addVerificationRequest(makeRequest());
    await discoveryService.rejectSuggestion(first.id, 'admin');

    const second = await discoveryService.addVerificationRequest(makeRequest());
    expect(second).not.toBeNull();
  });

  it('allows a new request once the prior one was approved', async () => {
    const first = await discoveryService.addVerificationRequest(makeRequest());

    discoveryService.initialize({
      createVerification: jest.fn().mockResolvedValue({ verification_id: 'v1' })
    }, null);
    await discoveryService.approveSuggestion(first.id, 'admin');

    const second = await discoveryService.addVerificationRequest(makeRequest());
    expect(second).not.toBeNull();
  });
});
