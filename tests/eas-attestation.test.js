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

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  // See tests/erc8004-lookup.test.js for why both the top-level exports AND
  // the nested `.ethers` namespace need overriding.
  const overrides = {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({})),
    Wallet: jest.fn().mockImplementation(() => ({ address: '0x' + 'a'.repeat(40) }))
  };
  return {
    ...actual,
    ...overrides,
    ethers: { ...actual.ethers, ...overrides }
  };
});

const { EASAttestationService } = require('../utils/eas-attestation');

describe('EASAttestationService', () => {
  beforeEach(() => {
    process.env.KINETIX_SIGNING_KEY = '0x' + '1'.repeat(64);
    mockAttest.mockReset();
    mockConnect.mockReset();
    mockEncodeData.mockClear();
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

  it('submits an attestation and returns the uid/txHash', async () => {
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
    expect(mockAttest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipient: receipt.recipient.wallet_address })
      })
    );
  });

  it('throws NO_WALLET if the recipient has no wallet_address', async () => {
    const service = new EASAttestationService();
    await service.initialize('base_sepolia');

    const receipt = {
      receipt_id: 'rcpt_kx_test2',
      recipient: {},
      commitment: {},
      verification_result: {}
    };

    await expect(service.submitAttestation(receipt)).rejects.toThrow(/NO_WALLET/);
  });

  it('throws if submitAttestation is called before initialize', async () => {
    const service = new EASAttestationService();
    await expect(service.submitAttestation({ recipient: { wallet_address: '0x1' } }))
      .rejects.toThrow(/not initialized/);
  });
});
