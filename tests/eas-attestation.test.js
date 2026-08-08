// tests/eas-attestation.test.js
// Tests for EAS (chain-agnostic) attestation submission. Mocks ethers and the
// eas-sdk — no live RPC/EAS calls.

jest.mock('../config/eas/eas-config.json', () => ({
  base_sepolia: {
    easAddress: '0x4200000000000000000000000000000000000021',
    schemaRegistryAddress: '0x4200000000000000000000000000000000000021',
    schema: 'string receiptId,bytes32 receiptHash,string verificationType,uint8 score,string ipfsUri',
    schemaUID: '0x' + 'ab'.repeat(32),
    explorer: 'https://base-sepolia.easscan.org'
  },
  base_mainnet: {
    easAddress: '0x4200000000000000000000000000000000000021',
    schemaRegistryAddress: '0x4200000000000000000000000000000000000021',
    schema: 'string receiptId,bytes32 receiptHash,string verificationType,uint8 score,string ipfsUri',
    schemaUID: null,
    explorer: 'https://base.easscan.org'
  }
}));

const mockAttest = jest.fn();
const mockConnect = jest.fn();
const mockEncodeData = jest.fn(() => '0xdeadbeef');

jest.mock('@ethereum-attestation-service/eas-sdk', () => ({
  EAS: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    attest: mockAttest
  })),
  SchemaEncoder: jest.fn().mockImplementation(() => ({
    encodeData: mockEncodeData
  }))
}));

// getFeeData is required by utils/gas-guard.js's assertGasWithinCeiling,
// called at the top of submitAttestation as of the universal-EAS-anchoring
// change — a provider mock without it would throw a plain TypeError there
// rather than exercising anything meaningful.
const mockGetFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 1n }); // ~1 wei, far under any gwei ceiling

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  // See tests/erc8004-lookup.test.js for why both the top-level exports AND
  // the nested `.ethers` namespace need overriding.
  const overrides = {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({ getFeeData: mockGetFeeData })),
    Wallet: jest.fn().mockImplementation(() => ({ address: '0x' + 'a'.repeat(40) }))
  };
  return {
    ...actual,
    ...overrides,
    ethers: { ...actual.ethers, ...overrides }
  };
});

const { canonicalHash } = require('../utils/receipt-canonical');
const { EASAttestationService } = require('../utils/eas-attestation');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('EASAttestationService', () => {
  beforeEach(() => {
    process.env.KINETIX_SIGNING_KEY = '0x' + '1'.repeat(64);
    mockAttest.mockReset();
    mockConnect.mockReset();
    mockEncodeData.mockClear();
    mockGetFeeData.mockClear();
    mockGetFeeData.mockResolvedValue({ maxFeePerGas: 1n });
  });

  it('initializes and connects when a schema is registered for the network', async () => {
    const service = new EASAttestationService();
    await service.initialize('base_sepolia');
    expect(service.initialized).toBe(true);
    expect(mockConnect).toHaveBeenCalled();
  });

  it('throws if no schema has been registered for the network yet', async () => {
    const service = new EASAttestationService();
    await expect(service.initialize('base_mainnet')).rejects.toThrow(/No EAS schema registered/);
  });

  it('submits an attestation and returns the uid/txHash, naming the real recipient', async () => {
    mockAttest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue('0xuid123'),
      receipt: { hash: '0xtxhash123' }
    });

    const service = new EASAttestationService();
    await service.initialize('base_sepolia');

    const receipt = {
      receipt_id: 'rcpt_kx_test',
      recipient: { wallet_address: '0x' + 'c'.repeat(40) },
      commitment: { verification_type: 'consistency' },
      verification_result: { overall_score: 90 },
      reputation_context: { ipfs_uri: 'ipfs://Qm123' }
    };

    const result = await service.submitAttestation(receipt);

    expect(result.uid).toBe('0xuid123');
    expect(result.txHash).toBe('0xtxhash123');
    expect(result.explorerUrl).toContain('0xuid123');
    expect(result.anchorMode).toBe('recipient');
    // ethers.getAddress checksums — the raw all-lowercase 'c'*40 input above
    // must come back EIP-55 checksummed, not passed through verbatim.
    expect(result.recipient).not.toBe(receipt.recipient.wallet_address);
    expect(result.recipient.toLowerCase()).toBe(receipt.recipient.wallet_address);
    expect(mockAttest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipient: result.recipient })
      })
    );

    // Exact schema-encoder field mapping, in order. The eas-sdk mock returns
    // a fixed '0xdeadbeef' regardless of input, so without asserting the call
    // args a swapped field (e.g. verificationType <-> ipfsUri) would ship green.
    expect(mockEncodeData).toHaveBeenCalledWith([
      { name: 'receiptId', value: 'rcpt_kx_test', type: 'string' },
      { name: 'receiptHash', value: canonicalHash(receipt), type: 'bytes32' },
      { name: 'verificationType', value: 'consistency', type: 'string' },
      { name: 'score', value: 90, type: 'uint8' },
      { name: 'ipfsUri', value: 'ipfs://Qm123', type: 'string' }
    ]);
  });

  it('anchors at the zero address instead of throwing when the recipient has no wallet_address', async () => {
    mockAttest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue('0xuid456'),
      receipt: { hash: '0xtxhash456' }
    });

    const service = new EASAttestationService();
    await service.initialize('base_sepolia');

    const receipt = {
      receipt_id: 'rcpt_kx_test2',
      recipient: {},
      commitment: {},
      verification_result: {}
    };

    const result = await service.submitAttestation(receipt);

    expect(result.recipient).toBe(ZERO_ADDRESS);
    expect(result.anchorMode).toBe('unattributed');
    expect(mockAttest).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recipient: ZERO_ADDRESS }) })
    );
  });

  it('anchors at the zero address for a Nostr pubkey, never passing it through as an EVM recipient', async () => {
    mockAttest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue('0xuid789'),
      receipt: { hash: '0xtxhash789' }
    });

    const service = new EASAttestationService();
    await service.initialize('base_sepolia');

    const receipt = {
      receipt_id: 'rcpt_kx_test3',
      // 64-char hex Nostr pubkey — same length class as an address but the
      // wrong shape (no 0x prefix, 64 hex chars not 40).
      recipient: { wallet_address: '02caec3224a3fd392dd06ce2b80f3db42a592cd475681a78d7c8cb78520c1f4b' },
      commitment: {},
      verification_result: {}
    };

    const result = await service.submitAttestation(receipt);

    expect(result.recipient).toBe(ZERO_ADDRESS);
    expect(result.anchorMode).toBe('unattributed');
  });

  it('throws GAS_CEILING before calling attest when the gas price exceeds the ceiling', async () => {
    mockGetFeeData.mockResolvedValue({ maxFeePerGas: 1_000_000_000_000n }); // 1000 gwei, far above default 50

    const service = new EASAttestationService();
    await service.initialize('base_sepolia');

    const receipt = {
      receipt_id: 'rcpt_kx_test4',
      recipient: { wallet_address: '0x' + 'c'.repeat(40) },
      commitment: {},
      verification_result: {}
    };

    await expect(service.submitAttestation(receipt)).rejects.toMatchObject({ code: 'GAS_CEILING' });
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('throws if submitAttestation is called before initialize', async () => {
    const service = new EASAttestationService();
    await expect(service.submitAttestation({ recipient: { wallet_address: '0x1' } }))
      .rejects.toThrow(/not initialized/);
  });
});
