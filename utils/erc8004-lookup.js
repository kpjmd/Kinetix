// /utils/erc8004-lookup.js
// Resolves an agent's ERC-8004 token ID from their wallet address.
//
// The IdentityRegistry has no reverse (address -> tokenId) view function —
// only ownerOf(tokenId) -> address. The only way to resolve the reverse
// direction is to scan `Registered(agentId indexed, agentURI, owner indexed)`
// events and build an owner -> agentId index ourselves. This module
// incrementally maintains that index (persisted via data-store.js) so a
// lookup after the first cold scan only needs to catch up on new blocks.

const { ethers } = require('ethers');
require('dotenv').config();

const abiData = require('../config/erc8004/erc8004-abis.json');
const dataStore = require('../services/data-store');
const { resolveNetwork } = require('./network');

const NETWORKS = {
  base_mainnet: {
    rpc: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    identityRegistry: abiData.IdentityRegistry.address.base_mainnet,
    deploymentBlock: abiData.IdentityRegistry.deploymentBlock.base_mainnet
  },
  base_sepolia: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    identityRegistry: abiData.IdentityRegistry.address.base_sepolia,
    deploymentBlock: abiData.IdentityRegistry.deploymentBlock.base_sepolia
  }
};

// Public Base RPCs cap eth_getLogs block ranges (mainnet.base.org/sepolia.base.org
// reject ranges over 2000 blocks) — scan in fixed windows just under that cap.
const CHUNK_SIZE = 2000;
// Re-check for new registrations at most this often per resolveTokenId() call.
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

const _contracts = {};

function _log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [ERC8004Lookup] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function _getContract(network) {
  if (_contracts[network]) return _contracts[network];

  const cfg = NETWORKS[network];
  if (!cfg) {
    throw new Error(`Unknown network: ${network}. Use base_mainnet or base_sepolia`);
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const contract = new ethers.Contract(cfg.identityRegistry, abiData.IdentityRegistry.abi, provider);
  _contracts[network] = { provider, contract, cfg };
  return _contracts[network];
}

/**
 * Incrementally scan Registered events since the last cached block and
 * merge them into the owner -> agentId cache for a network.
 * @param {string} network - 'base_mainnet' or 'base_sepolia'
 * @returns {Promise<Object>} the (possibly updated) cache
 */
async function refreshCache(network) {
  const { provider, contract, cfg } = _getContract(network);
  const latestBlock = await provider.getBlockNumber();

  let cache = await dataStore.loadERC8004LookupCache(network);
  if (!cache) {
    cache = {
      network,
      last_scanned_block: cfg.deploymentBlock - 1,
      owner_to_token_id: {}
    };
  }

  if (cache.last_scanned_block >= latestBlock) {
    return cache;
  }

  const ownerToTokenId = { ...cache.owner_to_token_id };
  let fromBlock = cache.last_scanned_block + 1;
  let lastPersistedBlock = cache.last_scanned_block;

  while (fromBlock <= latestBlock) {
    const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, latestBlock);

    let events;
    try {
      events = await contract.queryFilter(contract.filters.Registered(), fromBlock, toBlock);
    } catch (error) {
      _log(`queryFilter failed for ${network} blocks ${fromBlock}-${toBlock}, stopping this refresh (will resume from last persisted block next time)`, {
        error: error.message
      });
      break;
    }

    for (const event of events) {
      const agentId = event.args.agentId.toString();
      const owner = event.args.owner.toLowerCase();
      // An owner with more than one registration: we keep the most recently
      // scanned tokenId, but flag it — feedback would otherwise silently go to
      // whichever token happened to be scanned last.
      if (ownerToTokenId[owner] && ownerToTokenId[owner] !== agentId) {
        _log(`Owner ${owner} has multiple ERC-8004 registrations (${ownerToTokenId[owner]} -> ${agentId}); keeping the newer tokenId`, { owner });
      }
      ownerToTokenId[owner] = agentId;
    }

    lastPersistedBlock = toBlock;
    cache = await dataStore.saveERC8004LookupCache(network, {
      network,
      last_scanned_block: lastPersistedBlock,
      owner_to_token_id: ownerToTokenId
    });

    fromBlock = toBlock + 1;
  }

  _log(`Refreshed lookup cache for ${network}`, {
    scanned_through_block: lastPersistedBlock,
    known_owners: Object.keys(ownerToTokenId).length
  });

  return cache;
}

/**
 * Resolve a wallet address to its ERC-8004 token ID, if registered.
 * @param {string} walletAddress
 * @param {string} network - 'base_mainnet' or 'base_sepolia'
 * @returns {Promise<string|null>} token ID as a string, or null if not found
 */
async function resolveTokenId(walletAddress, network = null) {
  const net = resolveNetwork(network);
  if (!walletAddress) return null;

  const addr = walletAddress.toLowerCase();

  let cache = await dataStore.loadERC8004LookupCache(net);
  const isStale = !cache || (Date.now() - new Date(cache.updated_at).getTime()) > CACHE_MAX_AGE_MS;
  if (isStale || !cache.owner_to_token_id?.[addr]) {
    cache = await refreshCache(net);
  }

  const tokenId = cache.owner_to_token_id?.[addr];
  if (!tokenId) return null;

  // Confirm the cached mapping still holds — the token may have been
  // transferred to a different wallet since it was registered.
  const { contract } = _getContract(net);
  try {
    const currentOwner = (await contract.ownerOf(tokenId)).toLowerCase();
    if (currentOwner !== addr) {
      _log(`Cached tokenId ${tokenId} for ${addr} no longer matches on-chain owner (${currentOwner}) — treating as unresolved`, { network: net });
      return null;
    }
  } catch (error) {
    // Fail closed: an unverified token could have been transferred, and
    // submitting feedback to it would attribute a receipt to the wrong owner.
    // The reconciliation retry loop will re-attempt this later.
    _log(`ownerOf(${tokenId}) check failed — cannot confirm owner, treating as unresolved`, { error: error.message });
    return null;
  }

  return tokenId;
}

module.exports = { refreshCache, resolveTokenId, NETWORKS };
