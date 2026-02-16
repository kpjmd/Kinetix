// /utils/ipfs-manager.js
// IPFS integration via Pinata REST API for ERC-8004 metadata and attestations

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config();

const PINATA_API_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

function _log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [IPFSManager] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * Upload JSON data to IPFS via Pinata
 * @param {Object} jsonData - JSON object to pin
 * @param {Object} options - Optional pinata metadata/options
 * @returns {Promise<{ipfsHash: string, gatewayUrl: string}>}
 */
async function uploadJSON(jsonData, options = {}) {
  const pinataApiKey = process.env.PINATA_API_KEY;
  const pinataSecretKey = process.env.PINATA_SECRET_API_KEY;

  if (!pinataApiKey || !pinataSecretKey) {
    throw new Error('Pinata API credentials not found. Set PINATA_API_KEY and PINATA_SECRET_API_KEY in .env');
  }

  _log('Uploading JSON to IPFS via Pinata...');

  const payload = {
    pinataContent: jsonData
  };
  if (options.name) {
    payload.pinataMetadata = { name: options.name };
  }

  const response = await axios.post(PINATA_API_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'pinata_api_key': pinataApiKey,
      'pinata_secret_api_key': pinataSecretKey
    }
  });

  const ipfsHash = response.data.IpfsHash;
  const gateway = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';
  const gatewayUrl = `${gateway}${ipfsHash}`;

  _log('Upload successful', { ipfsHash, gatewayUrl });
  return { ipfsHash, gatewayUrl };
}

/**
 * Fetch JSON from IPFS via gateway
 * @param {string} ipfsHash - IPFS CID
 * @returns {Promise<Object>} Retrieved JSON
 */
async function fetchJSON(ipfsHash) {
  const gateway = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';
  const url = `${gateway}${ipfsHash}`;

  _log(`Fetching from IPFS: ${url}`);
  const response = await axios.get(url, { timeout: 30000 });
  _log('Fetch successful');
  return response.data;
}

/**
 * Load metadata template, populate identity fields, and upload to IPFS
 * @param {string} network - Target network (base_mainnet or base_sepolia)
 * @returns {Promise<{ipfsHash: string, gatewayUrl: string, metadata: Object}>}
 */
async function uploadAgentMetadata(network = null) {
  const signingKey = process.env.KINETIX_SIGNING_KEY;
  if (!signingKey) {
    throw new Error('KINETIX_SIGNING_KEY not set in .env');
  }

  const wallet = new ethers.Wallet(signingKey);
  const address = wallet.address;

  // Load metadata template
  const metadataPath = path.join(__dirname, '../config/erc8004/kinetix_metadata.json');
  const raw = await fs.readFile(metadataPath, 'utf-8');
  const metadata = JSON.parse(raw);

  // Populate identity fields
  metadata.identity.publicKey = address;
  metadata.identity.controller = address;
  metadata.blockchain.wallet_address = address;
  metadata.metadata.updated_at = new Date().toISOString();

  // Inject registrations field if network is specified
  if (network) {
    // Determine target network
    const targetNetwork = network || process.env.DEFAULT_NETWORK || 'base_mainnet';

    // Load existing registration to get token ID
    const dataStore = require('../services/data-store');
    const registration = await dataStore.loadERC8004Identity(targetNetwork);

    if (!registration) {
      throw new Error(`No registration found for ${targetNetwork}. Cannot create registrations field.`);
    }

    // Load ABIs to get contract address
    const abis = require('../config/erc8004/erc8004-abis.json');
    const registryAddress = abis.IdentityRegistry.address[targetNetwork];

    // Build CAIP-10 identifier
    const chainIds = {
      'base_mainnet': 8453,
      'base_sepolia': 84532
    };
    const chainId = chainIds[targetNetwork];
    const caip10 = `eip155:${chainId}:${registryAddress}`;

    // Inject registrations field
    metadata.registrations = [
      {
        agentId: parseInt(registration.tokenId),
        agentRegistry: caip10
      }
    ];

    _log('Registrations field injected', { agentId: registration.tokenId, agentRegistry: caip10 });
  }

  _log('Metadata populated', { controller: address });

  // Upload
  const result = await uploadJSON(metadata, { name: 'kinetix-erc8004-metadata' });
  return { ...result, metadata };
}

module.exports = {
  uploadJSON,
  fetchJSON,
  uploadAgentMetadata
};
