// tests/security-hardening.test.js
// Covers the pre-mainnet security/correctness hardening: signing-key leak
// safety, network resolution, canonical receipt hashing, and on-chain
// submission idempotency.

describe('signing-key helper', () => {
  const ORIGINAL = process.env.KINETIX_SIGNING_KEY;
  afterEach(() => { process.env.KINETIX_SIGNING_KEY = ORIGINAL; });

  const { getSigningKey, createSigner } = require('../utils/signing-key');

  it('trims a valid key with surrounding whitespace', () => {
    process.env.KINETIX_SIGNING_KEY = '0x' + 'a'.repeat(64) + '  ';
    expect(getSigningKey()).toBe('0x' + 'a'.repeat(64));
  });

  it('never includes key material in the error for a malformed key', () => {
    process.env.KINETIX_SIGNING_KEY = '0xSECRET_MATERIAL_should_never_be_logged';
    expect(() => getSigningKey()).toThrow(/Invalid KINETIX_SIGNING_KEY format/);
    try { createSigner(); } catch (e) {
      expect(e.message).not.toContain('SECRET_MATERIAL');
    }
  });

  it('reports a clear error when unset', () => {
    delete process.env.KINETIX_SIGNING_KEY;
    expect(() => getSigningKey()).toThrow(/not set/);
  });
});

describe('network resolver', () => {
  const { resolveNetwork } = require('../utils/network');
  const OD = process.env.DEFAULT_NETWORK;
  const ON = process.env.NETWORK_ID;
  afterEach(() => {
    process.env.DEFAULT_NETWORK = OD; process.env.NETWORK_ID = ON;
    if (OD === undefined) delete process.env.DEFAULT_NETWORK;
    if (ON === undefined) delete process.env.NETWORK_ID;
  });

  it('honors an explicit network', () => {
    delete process.env.DEFAULT_NETWORK; delete process.env.NETWORK_ID;
    expect(resolveNetwork('base_mainnet')).toBe('base_mainnet');
  });

  it('fails fast when nothing is configured (no silent mainnet default)', () => {
    delete process.env.DEFAULT_NETWORK; delete process.env.NETWORK_ID;
    expect(() => resolveNetwork()).toThrow(/No network configured/);
  });

  it('refuses to infer when the two env layers disagree', () => {
    process.env.DEFAULT_NETWORK = 'base_sepolia';
    process.env.NETWORK_ID = 'base-mainnet';
    expect(() => resolveNetwork()).toThrow(/split-brain/);
  });

  it('still honors an explicit network even under an env split-brain', () => {
    process.env.DEFAULT_NETWORK = 'base_sepolia';
    process.env.NETWORK_ID = 'base-mainnet';
    expect(resolveNetwork('base_sepolia')).toBe('base_sepolia');
  });
});

describe('canonical receipt hash', () => {
  const { canonicalHash } = require('../utils/receipt-canonical');

  const base = () => ({
    receipt_id: 'rcpt_kx_1',
    verification_result: { overall_score: 80, status: 'verified' },
    metadata: { issued_at: '2025-01-01T00:00:00Z', onchain_status: 'pending' },
    reputation_context: { reputation_value: 80, ipfs_uri: null },
    eas: { status: 'pending' },
    signatures: { kinetix_signature: '0xsig' }
  });

  it('is stable when only post-issuance mutable fields change', () => {
    const a = base();
    const h1 = canonicalHash(a);
    a.metadata.onchain_status = 'submitted';
    a.metadata.onchain_tx_hash = '0xdead';
    a.reputation_context.ipfs_uri = 'ipfs://Qm';
    a.reputation_context.submission_index = '4';
    a.eas.status = 'submitted';
    a.eas.attestation_uid = '0xuid';
    a.signatures.kinetix_signature = '0xdifferent';
    expect(canonicalHash(a)).toBe(h1);
  });

  it('changes when an immutable field changes', () => {
    const a = base();
    const h1 = canonicalHash(a);
    a.verification_result.overall_score = 100;
    expect(canonicalHash(a)).not.toBe(h1);
  });
});

describe('reconcile idempotency', () => {
  jest.mock('../services/data-store');
  jest.mock('../utils/erc8004-reputation', () => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    submitAttestation: jest.fn(),
    networkName: 'base_sepolia'
  }));
  jest.mock('../utils/eas-attestation', () => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    submitAttestation: jest.fn()
  }));
  jest.mock('../utils/ipfs-manager', () => ({ uploadJSON: jest.fn() }));
  jest.mock('../utils/erc8004-lookup', () => ({ resolveTokenId: jest.fn() }));

  const reputationService = require('../utils/erc8004-reputation');
  const { ReconciliationService } = require('../services/reconciliation-service');

  it('does not re-submit a receipt already in a terminal on-chain state', async () => {
    const service = new ReconciliationService();
    const receipt = {
      receipt_id: 'rcpt_kx_done',
      recipient: { agent_id: 'a', wallet_address: '0x' + 'a'.repeat(40), erc8004_token_id: '42' },
      metadata: { onchain_status: 'submitted' }
    };

    const outcome = await service.reconcileOne(receipt);

    expect(outcome.status).toBe('submitted');
    expect(reputationService.submitAttestation).not.toHaveBeenCalled();
  });
});
