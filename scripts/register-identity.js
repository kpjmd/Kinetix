#!/usr/bin/env node

/**
 * ERC-8004 Identity Registration Script for Kinetix
 *
 * Usage:
 *   node scripts/register-identity.js [--network base_mainnet|base_sepolia]
 *
 * Prerequisites:
 *   - KINETIX_SIGNING_KEY set in .env
 *   - PINATA_API_KEY and PINATA_SECRET_API_KEY set in .env
 *   - ETH balance in wallet for gas
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

const ipfsManager = require('../utils/ipfs-manager');
const identityService = require('../utils/erc8004-identity');
const dataStore = require('../services/data-store');

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function main() {
  // Parse network argument
  const network = process.argv.includes('--network')
    ? process.argv[process.argv.indexOf('--network') + 1]
    : process.env.DEFAULT_NETWORK || 'base_sepolia';

  log(`=== Kinetix ERC-8004 Identity Registration ===`);
  log(`Network: ${network}`);

  // Step 1: Upload metadata to IPFS
  log('\n--- Step 1: Upload Metadata to IPFS ---');
  const { ipfsHash, gatewayUrl, metadata } = await ipfsManager.uploadAgentMetadata();
  const metadataURI = `ipfs://${ipfsHash}`;
  log('Metadata URI: ' + metadataURI);

  // Step 2: Initialize identity service
  log('\n--- Step 2: Initialize Blockchain Connection ---');
  await identityService.initialize(network);

  // Step 3: Check balance
  log('\n--- Step 3: Check Wallet Balance ---');
  await identityService.checkBalance();

  // Step 4: Estimate gas
  log('\n--- Step 4: Estimate Gas ---');
  const { estimatedCostEth } = await identityService.estimateRegistrationGas(metadataURI);
  log(`Estimated cost: ${estimatedCostEth} ETH`);

  // Step 5: Mainnet safety pause
  if (network === 'base_mainnet' && process.env.REQUIRE_MAINNET_APPROVAL === 'true') {
    log('\nMAINNET DEPLOYMENT - Waiting 10 seconds before proceeding...');
    log('Press Ctrl+C to cancel.');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Step 6: Register
  log('\n--- Step 6: Register Agent ---');
  const result = await identityService.registerAgent(metadataURI);

  // Step 7: Verify on-chain
  log('\n--- Step 7: Verify Registration ---');
  const verification = await identityService.verifyRegistration(result.tokenId);
  if (!verification.isValid) {
    throw new Error('On-chain verification failed. Owner mismatch.');
  }

  // Step 8: Save results to data/erc8004/
  log('\n--- Step 8: Save Results ---');
  const registrationData = {
    network: network,
    tokenId: result.tokenId,
    controller: result.controller,
    walletAddress: identityService.walletAddress,
    metadataURI: metadataURI,
    ipfsHash: ipfsHash,
    ipfsGatewayUrl: gatewayUrl,
    txHash: result.txHash,
    blockNumber: result.blockNumber,
    gasUsed: result.gasUsed,
    registeredAt: new Date().toISOString(),
    explorerUrl: `${identityService.network.explorer}/tx/${result.txHash}`,
    agentUrl: `https://8004scan.io/agent/${result.tokenId}`
  };

  await dataStore.saveERC8004Identity(network, registrationData);

  // Step 9: Summary
  log('\n=== REGISTRATION COMPLETE ===');
  log(`Token ID: ${result.tokenId}`);
  log(`Network: ${network}`);
  log(`Transaction: ${result.txHash}`);
  log(`BaseScan: ${registrationData.explorerUrl}`);
  log(`8004scan: ${registrationData.agentUrl}`);
  log(`IPFS: ${gatewayUrl}`);
  log(`\nIMPORTANT: Update your .env file:`);
  log(`  KINETIX_ERC8004_TOKEN_ID=${result.tokenId}`);
  log(`  KINETIX_METADATA_IPFS_HASH=${ipfsHash}`);

  return registrationData;
}

main()
  .then(() => {
    log('\nScript completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    log('Registration failed: ' + error.message);
    console.error(error);

    if (error.code === 'INSUFFICIENT_FUNDS') {
      log('Tip: Your wallet needs more ETH for gas.');
      log('For Base Sepolia testnet ETH: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet');
    }
    process.exit(1);
  });
