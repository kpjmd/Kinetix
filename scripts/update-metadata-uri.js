#!/usr/bin/env node

/**
 * Update ERC-8004 Metadata URI
 *
 * Fixes metadata validation warnings by uploading corrected structure
 * and updating on-chain URI pointer via setAgentURI()
 *
 * Usage:
 *   node scripts/update-metadata-uri.js [--network base_mainnet|base_sepolia]
 *
 * Examples:
 *   node scripts/update-metadata-uri.js --network base_sepolia
 *   node scripts/update-metadata-uri.js --network base_mainnet
 */

require('dotenv').config();
const ipfsManager = require('../utils/ipfs-manager');
const identityService = require('../utils/erc8004-identity');
const dataStore = require('../services/data-store');

async function main() {
  // Parse network argument (default: base_mainnet)
  const args = process.argv.slice(2);
  const networkIndex = args.indexOf('--network');
  const network = networkIndex >= 0 ? args[networkIndex + 1] : 'base_mainnet';

  if (!['base_mainnet', 'base_sepolia'].includes(network)) {
    console.error('\nInvalid network. Use: base_mainnet or base_sepolia\n');
    process.exit(1);
  }

  console.log('\n=== Updating ERC-8004 Metadata URI ===\n');
  console.log(`Network: ${network}\n`);

  // Step 1: Load existing registration
  console.log('Step 1: Loading existing registration...');
  const existingReg = await dataStore.loadERC8004Identity(network);

  if (!existingReg) {
    throw new Error(`No registration found for ${network}`);
  }

  console.log(`✓ Found registration (Token ID: ${existingReg.tokenId})`);
  console.log(`  Current URI: ${existingReg.metadataURI}`);
  console.log(`  Current IPFS: ${existingReg.ipfsHash}`);
  console.log('');

  // Step 2: Upload corrected metadata to IPFS
  console.log('Step 2: Uploading corrected metadata to IPFS...');
  const { ipfsHash, gatewayUrl, metadata } = await ipfsManager.uploadAgentMetadata(network);
  const newMetadataURI = `ipfs://${ipfsHash}`;

  console.log('✓ Metadata uploaded to IPFS');
  console.log(`  New IPFS Hash: ${ipfsHash}`);
  console.log(`  Gateway URL: ${gatewayUrl}`);
  console.log(`  New URI: ${newMetadataURI}`);
  console.log('');

  // Verify corrected structure
  console.log('Step 3: Verifying corrected structure...');
  const warnings = [];
  if (!metadata.type) warnings.push('Missing root-level "type"');
  if (!metadata.name) warnings.push('Missing root-level "name"');
  if (!metadata.description) warnings.push('Missing root-level "description"');
  if (metadata.endpoints) warnings.push('Still using deprecated "endpoints"');
  if (!metadata.services) warnings.push('Missing "services" array');
  if (!metadata.registrations) warnings.push('Missing "registrations" array');
  if (metadata.registrations && metadata.registrations.length === 0) {
    warnings.push('Empty registrations array');
  }

  // Validate registrations match network
  if (metadata.registrations && metadata.registrations.length > 0) {
    const reg = metadata.registrations[0];
    const expectedChainId = network === 'base_mainnet' ? 8453 : 84532;
    const expectedTokenId = existingReg.tokenId;

    if (!reg.agentRegistry.includes(`:${expectedChainId}:`)) {
      warnings.push(`Registration chain ID mismatch (expected ${expectedChainId})`);
    }
    if (reg.agentId.toString() !== expectedTokenId) {
      warnings.push(`Registration token ID mismatch (expected ${expectedTokenId}, got ${reg.agentId})`);
    }
  }

  if (warnings.length > 0) {
    console.error('⚠️  Metadata still has issues:');
    warnings.forEach(w => console.error(`  - ${w}`));
    console.error('\nPlease fix config/erc8004/kinetix_metadata.json first.\n');
    process.exit(1);
  }

  console.log('✓ Metadata structure validated');
  console.log(`  Root-level type: ${metadata.type}`);
  console.log(`  Root-level name: ${metadata.name}`);
  console.log(`  Services defined: ${metadata.services?.length || 0}`);
  console.log(`  Registrations: ${metadata.registrations?.length || 0}`);
  if (metadata.registrations && metadata.registrations.length > 0) {
    console.log(`    Agent ID: ${metadata.registrations[0].agentId}`);
    console.log(`    Registry: ${metadata.registrations[0].agentRegistry}`);
  }
  console.log('');

  // Step 4: Initialize blockchain connection
  console.log('Step 4: Connecting to blockchain...');
  await identityService.initialize(network);
  console.log(`✓ Connected to ${network}`);
  console.log('');

  // Step 5: Mainnet safety pause
  if (network === 'base_mainnet') {
    console.log('⚠️  WARNING: About to update on BASE MAINNET');
    console.log('This will update the metadata URI for Token ID 16892');
    console.log('');
    console.log('Old URI:', existingReg.metadataURI);
    console.log('New URI:', newMetadataURI);
    console.log('');
    console.log('Waiting 10 seconds for safety... (Ctrl+C to cancel)');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Step 6: Update on-chain URI
  console.log('Step 5: Updating on-chain metadata URI...');
  const updateResult = await identityService.updateAgentURI(
    existingReg.tokenId,
    newMetadataURI
  );

  console.log('✓ On-chain URI updated');
  console.log(`  Transaction: ${updateResult.txHash}`);
  console.log(`  Block: ${updateResult.blockNumber}`);
  console.log(`  Gas used: ${updateResult.gasUsed}`);
  console.log('');

  // Step 7: Save updated registration data
  const updatedReg = {
    ...existingReg,
    metadataURI: newMetadataURI,
    ipfsHash: ipfsHash,
    ipfsGatewayUrl: gatewayUrl,
    updatedAt: new Date().toISOString(),
    updateTxHash: updateResult.txHash,
    updateBlockNumber: updateResult.blockNumber,
    previousIpfsHash: existingReg.ipfsHash  // Keep backup reference
  };

  await dataStore.saveERC8004Identity(network, updatedReg);

  console.log('Step 6: Registration data updated');
  console.log('');

  // Step 8: Summary
  console.log('=== Update Complete ===\n');
  console.log('✓ Corrected metadata uploaded to IPFS');
  console.log('✓ On-chain URI updated via setAgentURI()');
  console.log('✓ Registration data saved locally');
  console.log('');
  console.log('Summary:');
  console.log(`  Network: ${network}`);
  console.log(`  Token ID: ${existingReg.tokenId}`);
  console.log(`  New IPFS: ${ipfsHash}`);
  console.log(`  Transaction: ${updateResult.txHash}`);
  console.log('');

  if (network === 'base_mainnet') {
    console.log('View on BaseScan:');
    console.log(`  https://basescan.org/tx/${updateResult.txHash}`);
    console.log('');
    console.log('View updated profile on 8004scan.io:');
    console.log(`  https://www.8004scan.io/agents/base/${existingReg.tokenId}`);
  } else {
    console.log('View on BaseScan (Sepolia):');
    console.log(`  https://sepolia.basescan.org/tx/${updateResult.txHash}`);
    console.log('');
    console.log('View updated profile on 8004scan.io:');
    console.log(`  https://www.8004scan.io/agents/base-sepolia/${existingReg.tokenId}`);
  }

  console.log('');
  console.log('⏳ Note: 8004scan.io may take 1-2 minutes to refresh metadata from IPFS');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nError updating metadata URI:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  });
