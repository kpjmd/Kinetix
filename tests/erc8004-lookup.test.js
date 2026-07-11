// tests/erc8004-lookup.test.js
// Tests for ERC-8004 owner -> tokenId resolution via Registered event scanning.
// Mocks ethers and data-store — no live RPC calls.

jest.mock('../config/erc8004/erc8004-abis.json', () => ({
  IdentityRegistry: {
    address: { base_mainnet: '0xIdentityMainnet', base_sepolia: '0xIdentitySepolia' },
    deploymentBlock: { base_mainnet: 100, base_sepolia: 100 },
    abi: []
  }
}));

const mockQueryFilter = jest.fn();
const mockOwnerOf = jest.fn();
const mockGetBlockNumber = jest.fn();

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  // ethers v6 exposes both top-level named exports AND a nested `.ethers`
  // namespace pointing at the same values (`require('ethers').ethers.Contract
  // === require('ethers').Contract`). Consuming code here destructures via
  // `const { ethers } = require('ethers')`, so overrides must apply to BOTH
  // paths or the real (network-calling) implementations leak through.
  const overrides = {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBlockNumber: mockGetBlockNumber
    })),
    Contract: jest.fn().mockImplementation(() => ({
      queryFilter: mockQueryFilter,
      ownerOf: mockOwnerOf,
      filters: { Registered: () => 'REGISTERED_FILTER' }
    }))
  };
  return {
    ...actual,
    ...overrides,
    ethers: { ...actual.ethers, ...overrides }
  };
});

jest.mock('../services/data-store');
const dataStore = require('../services/data-store');
const erc8004Lookup = require('../utils/erc8004-lookup');

describe('erc8004-lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a token ID by scanning Registered events across chunks', async () => {
    const testAddress = '0xabcdef0000000000000000000000000000000001';

    dataStore.loadERC8004LookupCache.mockResolvedValue(null);
    dataStore.saveERC8004LookupCache.mockImplementation((network, data) =>
      Promise.resolve({ ...data, updated_at: new Date().toISOString() })
    );
    mockGetBlockNumber.mockResolvedValue(2500); // deploymentBlock=100 -> 2 chunks of <=2000 blocks
    mockQueryFilter
      .mockResolvedValueOnce([
        { args: { agentId: 42n, owner: '0xAbCdEf0000000000000000000000000000000001', agentURI: 'ipfs://x' } }
      ])
      .mockResolvedValueOnce([]);
    mockOwnerOf.mockResolvedValue(testAddress);

    const tokenId = await erc8004Lookup.resolveTokenId(testAddress, 'base_mainnet');

    expect(tokenId).toBe('42');
    expect(mockQueryFilter).toHaveBeenCalledTimes(2);
    expect(dataStore.saveERC8004LookupCache).toHaveBeenCalled();
  });

  it('returns null when the cached token owner no longer matches (token transferred)', async () => {
    const testAddress = '0x' + 'b'.repeat(40);

    dataStore.loadERC8004LookupCache.mockResolvedValue({
      network: 'base_sepolia',
      last_scanned_block: 5000,
      owner_to_token_id: { [testAddress]: '7' },
      updated_at: new Date().toISOString()
    });
    mockOwnerOf.mockResolvedValue('0x' + 'd'.repeat(40)); // different current owner

    const tokenId = await erc8004Lookup.resolveTokenId(testAddress, 'base_sepolia');

    expect(tokenId).toBeNull();
    expect(mockQueryFilter).not.toHaveBeenCalled(); // fresh cache hit — no rescan needed
  });

  it('returns null for an address with no registration found', async () => {
    dataStore.loadERC8004LookupCache.mockResolvedValue(null);
    mockGetBlockNumber.mockResolvedValue(99); // deploymentBlock - 1 => already "up to date", nothing to scan

    const tokenId = await erc8004Lookup.resolveTokenId('0x' + 'e'.repeat(40), 'base_mainnet');

    expect(tokenId).toBeNull();
    expect(mockQueryFilter).not.toHaveBeenCalled();
    expect(mockOwnerOf).not.toHaveBeenCalled();
  });

  it('returns null immediately for an empty wallet address', async () => {
    const tokenId = await erc8004Lookup.resolveTokenId('', 'base_mainnet');
    expect(tokenId).toBeNull();
    expect(dataStore.loadERC8004LookupCache).not.toHaveBeenCalled();
  });
});
