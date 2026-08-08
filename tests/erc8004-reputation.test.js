// tests/erc8004-reputation.test.js
// No test file existed for this module before. Focuses on the pieces the
// on-chain-anchoring fixes touch directly: _mapReceiptToFeedback's identity
// resolution (P1: metadata.resolved_erc8004_token_id vs the frozen
// recipient.erc8004_token_id), isSelfVerification's matching branches
// (including the P1 fix to check the resolved token id too), and the gas
// guard delegation. No live RPC calls — provider/contract/walletAddress/
// kinetixTokenId are set directly on a fresh instance rather than going
// through initialize().

const { canonicalHash } = require('../utils/receipt-canonical');
const { ERC8004ReputationService } = require('../utils/erc8004-reputation');

function makeReceipt(overrides = {}) {
  return {
    receipt_id: 'rcpt_kx_test',
    recipient: { agent_id: 'test_agent', pubkey: '', wallet_address: '0x' + 'a'.repeat(40), erc8004_token_id: null },
    commitment: { verification_type: 'consistency', description: 'a'.repeat(100) },
    verification_result: { overall_score: 90, status: 'verified' },
    metadata: {},
    ...overrides
  };
}

function makeService(overrides = {}) {
  const service = new ERC8004ReputationService();
  service.initialized = true;
  service.walletAddress = '0x' + 'f'.repeat(40);
  service.kinetixTokenId = '16892';
  Object.assign(service, overrides);
  return service;
}

describe('_mapReceiptToFeedback', () => {
  it('throws NOT_REGISTERED when neither recipient.erc8004_token_id nor a resolved token exist', () => {
    const service = makeService();
    const receipt = makeReceipt();
    expect(() => service._mapReceiptToFeedback(receipt, 'Qm123'))
      .toThrow(expect.objectContaining({ code: 'NOT_REGISTERED' }));
  });

  it('uses recipient.erc8004_token_id when no resolved token is present', () => {
    const service = makeService();
    const receipt = makeReceipt({ recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: '42' } });
    const params = service._mapReceiptToFeedback(receipt, 'Qm123');
    expect(params.agentId).toBe('42');
  });

  it('prefers metadata.resolved_erc8004_token_id over recipient.erc8004_token_id when both are present', () => {
    // P1: reconciliation writes a late-resolved token to metadata, not
    // recipient (which is frozen post-signing). The resolved one must win —
    // it reflects what reconciliation actually found on-chain, and it's the
    // only one that can ever be updated.
    const service = makeService();
    const receipt = makeReceipt({
      recipient: { agent_id: 'a', wallet_address: '0x' + 'b'.repeat(40), erc8004_token_id: '1' },
      metadata: { resolved_erc8004_token_id: '2' }
    });
    const params = service._mapReceiptToFeedback(receipt, 'Qm123');
    expect(params.agentId).toBe('2');
  });

  it('truncates endpoint to 64 characters', () => {
    const service = makeService();
    const receipt = makeReceipt({
      recipient: { agent_id: 'a', erc8004_token_id: '1' },
      commitment: { verification_type: 'consistency', description: 'x'.repeat(200) }
    });
    const params = service._mapReceiptToFeedback(receipt, 'Qm123');
    expect(params.endpoint).toHaveLength(64);
  });

  it('computes feedbackHash as canonicalHash(receipt), matching the EAS receiptHash and the signed payload', () => {
    const service = makeService();
    const receipt = makeReceipt({ recipient: { agent_id: 'a', erc8004_token_id: '1' } });
    const params = service._mapReceiptToFeedback(receipt, 'Qm123');
    expect(params.feedbackHash).toBe(canonicalHash(receipt));
  });

  it('builds feedbackURI as ipfs://<hash>', () => {
    const service = makeService();
    const receipt = makeReceipt({ recipient: { agent_id: 'a', erc8004_token_id: '1' } });
    const params = service._mapReceiptToFeedback(receipt, 'QmABC');
    expect(params.feedbackURI).toBe('ipfs://QmABC');
  });

  it('defaults value/tag1/tag2 when the receipt is missing scoring/commitment fields', () => {
    const service = makeService();
    const receipt = {
      receipt_id: 'rcpt_kx_test',
      recipient: { agent_id: 'a', erc8004_token_id: '1' }
    };
    const params = service._mapReceiptToFeedback(receipt, 'Qm123');
    expect(params.value).toBe(0);
    expect(params.tag1).toBe('unknown');
    expect(params.tag2).toBe('unknown');
    expect(params.valueDecimals).toBe(0);
  });
});

describe('isSelfVerification', () => {
  it('is true for agent_id "kinetix" (case-insensitive)', () => {
    const service = makeService();
    expect(service.isSelfVerification(makeReceipt({ recipient: { agent_id: 'KINETIX' } }))).toBe(true);
  });

  it('is true for agent_id "kinetix_official"', () => {
    const service = makeService();
    expect(service.isSelfVerification(makeReceipt({ recipient: { agent_id: 'kinetix_official' } }))).toBe(true);
  });

  it('is true when recipient.pubkey matches the signing wallet, case-insensitively', () => {
    const service = makeService({ walletAddress: '0x' + 'AB'.repeat(20) });
    const receipt = makeReceipt({ recipient: { agent_id: 'someone', pubkey: '0x' + 'ab'.repeat(20) } });
    expect(service.isSelfVerification(receipt)).toBe(true);
  });

  it('is true when recipient.erc8004_token_id matches kinetixTokenId, across string/number', () => {
    const service = makeService({ kinetixTokenId: 16892 });
    const receipt = makeReceipt({ recipient: { agent_id: 'someone', erc8004_token_id: '16892' } });
    expect(service.isSelfVerification(receipt)).toBe(true);
  });

  it('is true when metadata.resolved_erc8004_token_id (not recipient.erc8004_token_id) matches kinetixTokenId', () => {
    // P1 fix: isSelfVerification must read effectiveTokenId, or a late resolve
    // that happens to land Kinetix's own token slips past this guard and
    // reverts on-chain (SELF_VERIFICATION rejected by the registry).
    const service = makeService({ kinetixTokenId: '16892' });
    const receipt = makeReceipt({
      recipient: { agent_id: 'someone', erc8004_token_id: '999' },
      metadata: { resolved_erc8004_token_id: '16892' }
    });
    expect(service.isSelfVerification(receipt)).toBe(true);
  });

  it('is false for an unrelated recipient', () => {
    const service = makeService();
    const receipt = makeReceipt({
      recipient: { agent_id: 'someone_else', pubkey: '0x' + 'c'.repeat(40), erc8004_token_id: '55' }
    });
    expect(service.isSelfVerification(receipt)).toBe(false);
  });
});

describe('_assertGasWithinCeiling', () => {
  it('delegates to the shared gas guard using this.provider', async () => {
    const getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n });
    const service = makeService({ provider: { getFeeData } });
    await expect(service._assertGasWithinCeiling()).resolves.toBeUndefined();
    expect(getFeeData).toHaveBeenCalled();
  });

  it('throws GAS_CEILING when the shared gas guard would', async () => {
    const getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000_000n });
    const service = makeService({ provider: { getFeeData } });
    await expect(service._assertGasWithinCeiling()).rejects.toMatchObject({ code: 'GAS_CEILING' });
  });
});
