#!/usr/bin/env node

/**
 * Test script for manual reputation submission
 *
 * Usage:
 *   node scripts/test-reputation-submission.js <receipt_id> [network]
 *
 * Examples:
 *   node scripts/test-reputation-submission.js rcpt_kx_abc123 sepolia
 *   node scripts/test-reputation-submission.js rcpt_kx_abc123 mainnet
 *
 * Defaults to 'mainnet' if network not specified.
 */

require('dotenv').config();
const dataStore = require('../services/data-store');
const ipfsManager = require('../utils/ipfs-manager');
const reputationService = require('../utils/erc8004-reputation');

async function main() {
  const receiptId = process.argv[2];
  const network = process.argv[3] || 'mainnet';

  if (!receiptId) {
    console.error('\nUsage: node scripts/test-reputation-submission.js <receipt_id> [network]');
    console.error('Example: node scripts/test-reputation-submission.js rcpt_kx_abc123 sepolia\n');
    console.error('Network options: sepolia, mainnet (default: mainnet)\n');
    process.exit(1);
  }

  if (!['sepolia', 'mainnet'].includes(network)) {
    console.error(`\nInvalid network: ${network}`);
    console.error('Valid options: sepolia, mainnet\n');
    process.exit(1);
  }

  console.log('\n=== Testing Reputation Submission ===\n');
  console.log(`Receipt ID: ${receiptId}`);
  console.log(`Network: base_${network}\n`);

  // Step 1: Load attestation receipt
  console.log('Step 1: Loading attestation receipt...');
  const receipt = await dataStore.loadAttestation(receiptId);

  if (!receipt) {
    throw new Error(`Receipt not found: ${receiptId}`);
  }

  console.log('✓ Receipt loaded');
  console.log('  Recipient:', receipt.recipient.agent_id);
  console.log('  Verification Type:', receipt.commitment.verification_type);
  console.log('  Overall Score:', receipt.verification_result.overall_score);
  console.log('  Status:', receipt.verification_result.status);
  console.log('');

  // Step 2: Check if already submitted
  const existingSubmission = await dataStore.loadReputationSubmission(receiptId);
  if (existingSubmission?.status === 'success') {
    console.log('⚠️  This receipt has already been successfully submitted!');
    console.log('  Network:', existingSubmission.network);
    console.log('  Transaction:', existingSubmission.transaction_hash);
    console.log('  Feedback Index:', existingSubmission.feedback_index);
    console.log('  IPFS URI:', existingSubmission.ipfs_uri);
    console.log('');
    console.log('Do you want to submit again anyway? (This will create a duplicate on-chain entry)');
    console.log('Press Ctrl+C to cancel, or continue to proceed.\n');
  }

  // Step 3: Upload to IPFS (or use existing)
  let ipfsHash, gatewayUrl;

  if (receipt.reputation_context?.ipfs_uri) {
    // Extract hash from existing URI
    ipfsHash = receipt.reputation_context.ipfs_uri.replace('ipfs://', '');
    gatewayUrl = `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;
    console.log('Step 2: Using existing IPFS upload');
    console.log('  IPFS Hash:', ipfsHash);
    console.log('  Gateway URL:', gatewayUrl);
    console.log('');
  } else {
    console.log('Step 2: Uploading to IPFS...');
    const uploadResult = await ipfsManager.uploadJSON(receipt, {
      name: `attestation-${receiptId}`
    });
    ipfsHash = uploadResult.ipfsHash;
    gatewayUrl = uploadResult.gatewayUrl;

    console.log('✓ Uploaded to IPFS');
    console.log('  IPFS Hash:', ipfsHash);
    console.log('  Gateway URL:', gatewayUrl);
    console.log('');

    // Update receipt with IPFS URI
    if (!receipt.reputation_context) {
      receipt.reputation_context = {};
    }
    receipt.reputation_context.ipfs_uri = `ipfs://${ipfsHash}`;
    await dataStore.saveAttestation(receipt);
  }

  // Step 4: Estimate gas
  console.log('Step 3: Estimating gas...');
  await reputationService.initialize(`base_${network}`);
  const gasEstimate = await reputationService.estimateSubmissionGas(receipt, ipfsHash);

  console.log('✓ Gas estimated');
  console.log('  Estimated Gas:', gasEstimate.gasLimit.toString());
  console.log('  Gas Price:', gasEstimate.gasPrice ? gasEstimate.gasPrice.toString() : 'N/A');
  console.log('');

  // Step 5: Submit to Reputation Registry
  if (network === 'mainnet') {
    console.log('⚠️  WARNING: About to submit to BASE MAINNET');
    console.log('This will use real ETH for gas fees.');
    console.log('');
    console.log('Waiting 10 seconds for safety... (Ctrl+C to cancel)');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  console.log('Step 4: Submitting to Reputation Registry...');
  const result = await reputationService.submitAttestation(receipt, ipfsHash);

  console.log('✓ Submitted successfully!');
  console.log('  Transaction Hash:', result.txHash);
  console.log('  Block Number:', result.blockNumber);
  console.log('  Feedback Index:', result.feedbackIndex);
  console.log('');

  // Step 6: Update receipt with on-chain data
  receipt.reputation_context.submission_index = result.feedbackIndex;
  receipt.reputation_context.submitted_at = new Date().toISOString();
  receipt.metadata.onchain_status = 'submitted';
  await dataStore.saveAttestation(receipt);

  // Step 7: Track submission
  await dataStore.saveReputationSubmission(receiptId, {
    status: 'success',
    network: `base_${network}`,
    transaction_hash: result.txHash,
    block_number: result.blockNumber,
    feedback_index: result.feedbackIndex,
    ipfs_hash: ipfsHash,
    ipfs_uri: `ipfs://${ipfsHash}`,
    gateway_url: gatewayUrl,
    submitted_at: new Date().toISOString()
  });

  console.log('=== Submission Complete ===\n');
  console.log('Receipt ID:', receiptId);
  console.log('Network:', `base_${network}`);
  console.log('Transaction:', result.txHash);
  console.log('Feedback Index:', result.feedbackIndex);
  console.log('IPFS URI:', `ipfs://${ipfsHash}`);
  console.log('');

  if (network === 'mainnet') {
    console.log('View on BaseScan:');
    console.log(`https://basescan.org/tx/${result.txHash}`);
  } else {
    console.log('View on BaseScan (Sepolia):');
    console.log(`https://sepolia.basescan.org/tx/${result.txHash}`);
  }
  console.log('');

  console.log('✓ First on-chain reputation submission complete!');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nError submitting reputation:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  });
