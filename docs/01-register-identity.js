#!/usr/bin/env node

/**
 * ERC-8004 Identity Registration Script for Kinetix
 * 
 * This script registers Kinetix as an agent on the ERC-8004 Identity Registry.
 * 
 * Prerequisites:
 * - .env file configured with PRIVATE_KEY, PINATA_API_KEY, etc.
 * - kinetix_metadata.json file prepared
 * - Base mainnet or testnet ETH in wallet
 * 
 * Usage:
 *   node scripts/erc8004/01-register-identity.js [--network base_mainnet|base_sepolia]
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

// ============================================
// Configuration
// ============================================

const NETWORK = process.argv.includes('--network') 
  ? process.argv[process.argv.indexOf('--network') + 1] 
  : process.env.DEFAULT_NETWORK || 'base_sepolia';

const NETWORKS = {
  base_mainnet: {
    rpc: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    chainId: 8453,
    name: 'Base Mainnet',
    explorer: 'https://basescan.org'
  },
  base_sepolia: {
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    identityRegistry: '0x8004AA63c570c570eBF15376c0dB199918BFe9Fb',
    chainId: 84532,
    name: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org'
  }
};

const IDENTITY_REGISTRY_ABI = [
  'function registerAgent(string metadataURI) external returns (uint256)',
  'event AgentRegistered(uint256 indexed tokenId, address indexed controller, string metadataURI)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)'
];

// ============================================
// Helper Functions
// ============================================

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
  if (error) {
    console.error(error);
  }
}

async function uploadToIPFS(metadata) {
  log('Uploading metadata to IPFS via Pinata...');
  
  const pinataApiKey = process.env.PINATA_API_KEY;
  const pinataSecretKey = process.env.PINATA_SECRET_API_KEY;
  
  if (!pinataApiKey || !pinataSecretKey) {
    throw new Error('Pinata API credentials not found in .env file');
  }
  
  try {
    const response = await axios.post(
      'https://api.pinata.cloud/pinning/pinJSONToIPFS',
      metadata,
      {
        headers: {
          'Content-Type': 'application/json',
          'pinata_api_key': pinataApiKey,
          'pinata_secret_api_key': pinataSecretKey
        }
      }
    );
    
    const ipfsHash = response.data.IpfsHash;
    log('✓ Successfully uploaded to IPFS', { ipfsHash });
    
    return ipfsHash;
  } catch (error) {
    logError('Failed to upload to IPFS', error.response?.data || error);
    throw error;
  }
}

function validateMetadata(metadata) {
  log('Validating metadata structure...');
  
  const required = [
    'agent.name',
    'agent.description',
    'agent.type',
    'identity.publicKey',
    'identity.signatureScheme',
    'identity.controller'
  ];
  
  for (const field of required) {
    const keys = field.split('.');
    let value = metadata;
    for (const key of keys) {
      value = value?.[key];
    }
    if (!value) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  
  log('✓ Metadata validation passed');
}

async function checkBalance(provider, address) {
  const balance = await provider.getBalance(address);
  const ethBalance = ethers.formatEther(balance);
  log(`Wallet balance: ${ethBalance} ETH`, { address });
  
  if (balance === 0n) {
    throw new Error('Wallet has zero balance. Please fund your wallet first.');
  }
  
  return balance;
}

async function estimateGasCost(contract, metadataURI, provider) {
  log('Estimating gas cost...');
  
  try {
    const gasEstimate = await contract.registerAgent.estimateGas(metadataURI);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    
    const estimatedCost = gasEstimate * gasPrice;
    const estimatedCostEth = ethers.formatEther(estimatedCost);
    
    log('✓ Gas estimation complete', {
      gasEstimate: gasEstimate.toString(),
      gasPrice: ethers.formatUnits(gasPrice, 'gwei') + ' gwei',
      estimatedCost: estimatedCostEth + ' ETH'
    });
    
    return { gasEstimate, gasPrice, estimatedCost };
  } catch (error) {
    logError('Gas estimation failed', error);
    throw error;
  }
}

async function waitForConfirmation(tx, provider) {
  log('Waiting for transaction confirmation...', { txHash: tx.hash });
  
  const receipt = await tx.wait();
  
  log('✓ Transaction confirmed', {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString()
  });
  
  return receipt;
}

function parseRegistrationEvent(receipt, contract) {
  log('Parsing registration event...');
  
  const agentRegisteredEvent = receipt.logs.find(log => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed.name === 'AgentRegistered';
    } catch {
      return false;
    }
  });
  
  if (!agentRegisteredEvent) {
    throw new Error('AgentRegistered event not found in transaction logs');
  }
  
  const parsed = contract.interface.parseLog(agentRegisteredEvent);
  const tokenId = parsed.args.tokenId;
  const controller = parsed.args.controller;
  const metadataURI = parsed.args.metadataURI;
  
  log('✓ Successfully parsed registration event', {
    tokenId: tokenId.toString(),
    controller,
    metadataURI
  });
  
  return { tokenId, controller, metadataURI };
}

async function saveResults(network, results) {
  const resultsDir = path.join(__dirname, '../../results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const filename = `registration-${network}-${Date.now()}.json`;
  const filepath = path.join(resultsDir, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
  log(`✓ Results saved to ${filepath}`);
}

// ============================================
// Main Registration Function
// ============================================

async function registerKinetixIdentity() {
  log(`Starting Kinetix ERC-8004 Identity Registration on ${NETWORKS[NETWORK].name}`);
  log('Network configuration:', NETWORKS[NETWORK]);
  
  try {
    // Step 1: Load and validate metadata
    log('\n=== Step 1: Load Metadata ===');
    const metadataPath = path.join(__dirname, '../../config/kinetix_metadata.json');
    
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    validateMetadata(metadata);
    
    // Step 2: Upload to IPFS
    log('\n=== Step 2: Upload to IPFS ===');
    const ipfsHash = await uploadToIPFS(metadata);
    const metadataURI = `ipfs://${ipfsHash}`;
    
    // Step 3: Setup blockchain connection
    log('\n=== Step 3: Setup Blockchain Connection ===');
    const provider = new ethers.JsonRpcProvider(NETWORKS[NETWORK].rpc);
    const privateKey = process.env.PRIVATE_KEY;
    
    if (!privateKey || privateKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      throw new Error('Valid PRIVATE_KEY not found in .env file');
    }
    
    const signer = new ethers.Wallet(privateKey, provider);
    const walletAddress = await signer.getAddress();
    log('✓ Wallet connected', { address: walletAddress });
    
    // Step 4: Check balance
    log('\n=== Step 4: Check Balance ===');
    await checkBalance(provider, walletAddress);
    
    // Step 5: Setup contract
    log('\n=== Step 5: Setup Contract ===');
    const identityRegistry = new ethers.Contract(
      NETWORKS[NETWORK].identityRegistry,
      IDENTITY_REGISTRY_ABI,
      signer
    );
    log('✓ Contract instance created', {
      address: NETWORKS[NETWORK].identityRegistry
    });
    
    // Step 6: Estimate gas
    log('\n=== Step 6: Estimate Gas ===');
    const { gasEstimate, gasPrice, estimatedCost } = await estimateGasCost(
      identityRegistry,
      metadataURI,
      provider
    );
    
    // Step 7: Confirm before proceeding (if mainnet)
    if (NETWORK === 'base_mainnet' && process.env.REQUIRE_MAINNET_APPROVAL === 'true') {
      log('\n⚠️  MAINNET DEPLOYMENT - Please confirm:');
      log(`Network: ${NETWORKS[NETWORK].name}`);
      log(`Estimated Cost: ${ethers.formatEther(estimatedCost)} ETH`);
      log(`Metadata URI: ${metadataURI}`);
      log('\nPress Ctrl+C to cancel, or wait 10 seconds to proceed...');
      
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    // Step 8: Register agent
    log('\n=== Step 8: Register Agent ===');
    log('Submitting transaction...');
    
    const tx = await identityRegistry.registerAgent(metadataURI, {
      gasLimit: gasEstimate * 120n / 100n // 20% buffer
    });
    
    log('✓ Transaction submitted', { txHash: tx.hash });
    log(`View on explorer: ${NETWORKS[NETWORK].explorer}/tx/${tx.hash}`);
    
    // Step 9: Wait for confirmation
    log('\n=== Step 9: Wait for Confirmation ===');
    const receipt = await waitForConfirmation(tx, provider);
    
    // Step 10: Parse results
    log('\n=== Step 10: Parse Results ===');
    const { tokenId, controller } = parseRegistrationEvent(receipt, identityRegistry);
    
    // Step 11: Verify registration
    log('\n=== Step 11: Verify Registration ===');
    const owner = await identityRegistry.ownerOf(tokenId);
    const storedURI = await identityRegistry.tokenURI(tokenId);
    
    if (owner.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error('Owner mismatch! Registration may have failed.');
    }
    
    if (storedURI !== metadataURI) {
      throw new Error('Metadata URI mismatch! Registration may have failed.');
    }
    
    log('✓ Registration verified successfully');
    
    // Step 12: Save results
    log('\n=== Step 12: Save Results ===');
    const results = {
      network: NETWORK,
      networkName: NETWORKS[NETWORK].name,
      kinetixTokenId: tokenId.toString(),
      controller: controller,
      walletAddress: walletAddress,
      metadataURI: metadataURI,
      ipfsHash: ipfsHash,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      timestamp: new Date().toISOString(),
      explorerUrl: `${NETWORKS[NETWORK].explorer}/tx/${receipt.hash}`,
      agentUrl: `https://8004scan.io/agent/${tokenId}`
    };
    
    await saveResults(NETWORK, results);
    
    // Step 13: Success summary
    log('\n=== ✅ REGISTRATION COMPLETE ===');
    log('🎉 Kinetix has been successfully registered on ERC-8004!');
    log('\n📋 Summary:');
    log(`   Token ID: ${tokenId}`);
    log(`   Network: ${NETWORKS[NETWORK].name}`);
    log(`   Transaction: ${receipt.hash}`);
    log(`   Block: ${receipt.blockNumber}`);
    log(`   Gas Used: ${receipt.gasUsed}`);
    log(`\n🔗 Links:`);
    log(`   BaseScan: ${NETWORKS[NETWORK].explorer}/tx/${receipt.hash}`);
    log(`   8004scan: https://8004scan.io/agent/${tokenId}`);
    log(`   IPFS: https://gateway.pinata.cloud/ipfs/${ipfsHash}`);
    log('\n⚠️  IMPORTANT: Save this Token ID!');
    log(`   Update your .env file:`);
    log(`   KINETIX_ERC8004_TOKEN_ID=${tokenId}`);
    log(`   KINETIX_METADATA_IPFS_HASH=${ipfsHash}`);
    
    return results;
    
  } catch (error) {
    logError('Registration failed', error);
    
    if (error.code === 'INSUFFICIENT_FUNDS') {
      log('\n💡 Tip: Your wallet needs more ETH to pay for gas.');
      if (NETWORK === 'base_sepolia') {
        log('   Get free testnet ETH: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet');
      }
    }
    
    process.exit(1);
  }
}

// ============================================
// Run Script
// ============================================

if (require.main === module) {
  registerKinetixIdentity()
    .then(() => {
      log('\nScript completed successfully ✅');
      process.exit(0);
    })
    .catch((error) => {
      logError('Script failed', error);
      process.exit(1);
    });
}

module.exports = { registerKinetixIdentity };
