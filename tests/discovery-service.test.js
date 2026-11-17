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

  it('carries an EVM wallet through from suggestion to commitment, so a discovery-sourced receipt can anchor on-chain', async () => {
    // Previously agent_wallet_address had no producer on a suggestion at all,
    // so an approved discovery-sourced commitment could never get an EVM
    // identity — the only route was a paid x402 call that supplied one
    // directly. This is the passthrough that closes that gap.
    const createVerification = jest.fn().mockResolvedValue({ verification_id: 'v1' });
    const request = await discoveryService.addVerificationRequest(
      makeRequest({ agent_wallet_address: '0x' + 'b'.repeat(40), agent_erc8004_token_id: '123' })
    );

    discoveryService.initialize({ createVerification }, null);
    await discoveryService.approveSuggestion(request.id, 'admin');

    expect(createVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet_address: '0x' + 'b'.repeat(40),
        erc8004_token_id: '123'
      })
    );
  });

  it('defaults to an empty wallet_address (not null) when the suggestion has none, so attestation-service can distinguish "no wallet" from a real EVM address', async () => {
    const createVerification = jest.fn().mockResolvedValue({ verification_id: 'v1' });
    const request = await discoveryService.addVerificationRequest(makeRequest());

    discoveryService.initialize({ createVerification }, null);
    await discoveryService.approveSuggestion(request.id, 'admin');

    expect(createVerification).toHaveBeenCalledWith(
      expect.objectContaining({ wallet_address: '' })
    );
  });

  describe('platform validation on approve', () => {
    const withCriteria = (criteria, overrides = {}) => makeRequest({
      suggested_verification: { verification_type: 'consistency', description: 'd', criteria },
      ...overrides
    });

    it('fills a missing criteria.platform from the source platform', async () => {
      const createVerification = jest.fn().mockResolvedValue({ verification_id: 'v1' });
      const request = await discoveryService.addVerificationRequest(withCriteria({ frequency: 'daily' }));

      discoveryService.initialize({ createVerification }, null);
      await discoveryService.approveSuggestion(request.id, 'admin');

      expect(createVerification).toHaveBeenCalledWith(expect.objectContaining({
        criteria: { frequency: 'daily', platform: 'moltbook' }
      }));
    });

    it.each(['base_l2', 'github', 'algorand'])(
      'rejects a claim about %s, which nothing can collect for, and leaves it pending',
      async platform => {
        const createVerification = jest.fn();
        const request = await discoveryService.addVerificationRequest(withCriteria({ platform }));

        discoveryService.initialize({ createVerification }, null);
        await expect(discoveryService.approveSuggestion(request.id, 'kinetix_autonomous'))
          .rejects.toThrow(/Cannot monitor platform/);

        expect(createVerification).not.toHaveBeenCalled();
        expect((await discoveryService.getSuggestion(request.id)).status).toBe('pending');
      }
    );

    it('rejects a platform other than the one the agent was seen on', async () => {
      const createVerification = jest.fn();
      const request = await discoveryService.addVerificationRequest(
        withCriteria({ platform: 'moltbook' }, { source_platform: 'clawstr', agent_pubkey: 'abc' })
      );

      discoveryService.initialize({ createVerification }, null);
      await expect(discoveryService.approveSuggestion(request.id, 'admin'))
        .rejects.toThrow(/came from clawstr/);
      expect(createVerification).not.toHaveBeenCalled();
    });

    it('approves a clawstr suggestion on clawstr', async () => {
      const createVerification = jest.fn().mockResolvedValue({ verification_id: 'v1' });
      const request = await discoveryService.addVerificationRequest(
        withCriteria({ platform: 'clawstr' }, { source_platform: 'clawstr', agent_pubkey: 'abc' })
      );

      discoveryService.initialize({ createVerification }, null);
      await discoveryService.approveSuggestion(request.id, 'admin');

      expect(createVerification).toHaveBeenCalledWith(expect.objectContaining({
        platform_profiles: { clawstr: 'abc' },
        criteria: { platform: 'clawstr' }
      }));
    });
  });

  describe('self-referential discoveries', () => {
    const KINETIX_HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';

    it.each([
      ['a Clawstr post by Kinetix\'s own key', { source_platform: 'clawstr', agent_id: 'x', agent_pubkey: KINETIX_HEX }],
      ['a Moltbook post by Kinetix', { source_platform: 'moltbook', agent_id: 'Kinetix' }]
    ])('skips %s at queue time', async (_label, overrides) => {
      expect(await discoveryService.addVerificationRequest(makeRequest(overrides))).toBeNull();
      expect(await discoveryService.addSuggestion(makeRequest(overrides))).toBeNull();
      expect(await discoveryService.listPending()).toHaveLength(0);
    });

    it('refuses to approve a self-referential suggestion queued before the filter', async () => {
      const id = 'disc_legacyself';
      await fs.writeFile(path.join(tmpDir, 'discovery-queue', `${id}.json`), JSON.stringify({
        id,
        status: 'pending',
        source_platform: 'clawstr',
        agent_id: KINETIX_HEX,
        agent_pubkey: KINETIX_HEX,
        suggested_verification: { verification_type: 'consistency', description: 'd', criteria: {} }
      }));
      const createVerification = jest.fn();
      discoveryService.initialize({ createVerification }, null);

      await expect(discoveryService.approveSuggestion(id, 'kinetix_autonomous'))
        .rejects.toThrow(/about Kinetix itself/);
      expect(createVerification).not.toHaveBeenCalled();
    });
  });
});
