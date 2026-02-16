#!/usr/bin/env node

/**
 * Complete Clawstr verification - score and issue attestation
 *
 * Usage: node scripts/complete-clawstr-verification.js <commitment_id>
 */

require('dotenv').config();
const verificationService = require('../services/verification-service');
const attestationService = require('../services/attestation-service');
const dataStore = require('../services/data-store');
const ipfsManager = require('../utils/ipfs-manager');

async function main() {
  const commitmentId = process.argv[2];

  if (!commitmentId) {
    console.error('\nUsage: node scripts/complete-clawstr-verification.js <commitment_id>');
    console.error('Example: node scripts/complete-clawstr-verification.js cmt_kx_abc123\n');
    process.exit(1);
  }

  console.log('\n=== Completing Clawstr Verification ===\n');
  console.log(`Commitment ID: ${commitmentId}\n`);

  // Initialize attestation service
  console.log('Initializing attestation service...');
  await attestationService.initialize();

  // Initialize verification service with attestation service
  verificationService.initialize(null, attestationService);
  console.log('');

  // Load commitment
  const commitment = await dataStore.loadCommitment(commitmentId);
  if (!commitment) {
    throw new Error(`Commitment not found: ${commitmentId}`);
  }

  console.log('Commitment:', commitment.description);
  console.log('Evidence collected:', commitment.evidence.length);
  console.log('Required:', commitment.criteria.duration_days);
  console.log('');

  // Check if already attested
  if (commitment.status === 'attested') {
    console.log('⚠️  This commitment is already attested!');
    console.log('Receipt ID:', commitment.receipt_id);

    const receipt = await dataStore.loadAttestation(commitment.receipt_id);
    if (receipt) {
      console.log('Overall score:', receipt.verification_result.overall_score);
      console.log('Status:', receipt.verification_result.status);

      if (receipt.reputation_context?.ipfs_uri) {
        console.log('IPFS URI:', receipt.reputation_context.ipfs_uri);
      }
    }
    console.log('');
    return;
  }

  // Step 1: Score verification
  console.log('Step 1: Scoring verification...');
  const scoreResult = await verificationService.scoreVerification(commitmentId);

  console.log('✓ Verification scored');
  console.log('  Status:', scoreResult.status);
  console.log('  Overall Score:', scoreResult.overall_score);
  console.log('  Completion Rate:', scoreResult.completion_rate + '%');
  console.log('  Days Completed:', scoreResult.days_completed);
  console.log('  Days Missed:', scoreResult.days_missed);
  console.log('');

  // Step 2: Issue attestation
  console.log('Step 2: Issuing attestation...');
  const attestResult = await verificationService.issueAttestation(commitmentId);

  console.log('✓ Attestation issued');
  console.log('  Receipt ID:', attestResult.receipt_id);
  console.log('');

  // Step 3: Load the receipt
  const receipt = await dataStore.loadAttestation(attestResult.receipt_id);

  console.log('Step 3: Receipt details...');
  console.log('  Issuer:', receipt.issuer.name);
  console.log('  Recipient:', receipt.recipient.agent_id);
  console.log('  Verification Type:', receipt.commitment.verification_type);
  console.log('  Overall Score:', receipt.verification_result.overall_score);
  console.log('  Status:', receipt.verification_result.status);
  console.log('  Evidence Count:', receipt.evidence.length);
  console.log('  Reputation Impact:', receipt.metadata.kinetix_reputation_impact);
  console.log('  Signed:', receipt.signatures.kinetix_signature ? 'Yes' : 'No');
  console.log('');

  // Step 4: Upload to IPFS
  console.log('Step 4: Uploading attestation to IPFS...');
  const { ipfsHash, gatewayUrl } = await ipfsManager.uploadJSON(receipt, {
    name: `attestation-${receipt.receipt_id}`
  });

  console.log('✓ Uploaded to IPFS');
  console.log('  IPFS Hash:', ipfsHash);
  console.log('  Gateway URL:', gatewayUrl);
  console.log('  IPFS URI:', `ipfs://${ipfsHash}`);
  console.log('');

  // Update receipt with IPFS info
  receipt.reputation_context.ipfs_uri = `ipfs://${ipfsHash}`;
  await dataStore.saveAttestation(receipt);

  console.log('=== Verification Complete ===\n');
  console.log('✓ Commitment scored and attested');
  console.log('✓ Attestation receipt generated');
  console.log('✓ Receipt uploaded to IPFS');
  console.log('');
  console.log('Receipt ID:', receipt.receipt_id);
  console.log('IPFS Hash:', ipfsHash);
  console.log('IPFS Gateway:', gatewayUrl);
  console.log('');
  console.log('This receipt is ready for ERC-8004 reputation submission!');
  console.log('');
  console.log('Next steps (Week 2 Track B):');
  console.log('  1. Update verification-service.js to auto-submit to Reputation Registry');
  console.log('  2. Or manually test: node scripts/test-reputation-submission.js');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nError completing verification:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  });
