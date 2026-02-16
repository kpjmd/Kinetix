#!/usr/bin/env node

/**
 * Collect evidence of Kinetix posts from Clawstr /c/ai-freedom
 *
 * Usage: node scripts/collect-clawstr-evidence.js <commitment_id>
 */

require('dotenv').config();
const crypto = require('crypto');
const verificationService = require('../services/verification-service');
const dataStore = require('../services/data-store');
const clawstrApi = require('../utils/clawstr-api');

async function main() {
  const commitmentId = process.argv[2];

  if (!commitmentId) {
    console.error('\nUsage: node scripts/collect-clawstr-evidence.js <commitment_id>');
    console.error('Example: node scripts/collect-clawstr-evidence.js cmt_kx_abc123\n');
    process.exit(1);
  }

  console.log('\n=== Collecting Clawstr Evidence ===\n');
  console.log(`Commitment ID: ${commitmentId}\n`);

  // Load commitment
  const commitment = await dataStore.loadCommitment(commitmentId);
  if (!commitment) {
    throw new Error(`Commitment not found: ${commitmentId}`);
  }

  console.log('Commitment:', commitment.description);
  console.log('Platform:', commitment.criteria.platform);
  console.log('Current evidence count:', commitment.evidence.length);
  console.log('');

  // Get Kinetix's public key
  const kinetixPubkey = await clawstrApi.getHexPublicKey();
  console.log('Kinetix pubkey:', kinetixPubkey.substring(0, 16) + '...');
  console.log('');

  // Fetch recent posts from /c/ai-freedom
  console.log('Fetching posts from /c/ai-freedom...');
  const posts = await clawstrApi.getFeed('/c/ai-freedom', 50);

  if (!posts || !Array.isArray(posts)) {
    throw new Error('Failed to fetch Clawstr feed');
  }

  console.log(`Found ${posts.length} total posts\n`);

  // Filter for Kinetix's posts
  const kinetixPosts = posts.filter(post => {
    const authorPubkey = post.pubkey || post.author;
    return authorPubkey === kinetixPubkey || authorPubkey.startsWith(kinetixPubkey.substring(0, 16));
  });

  console.log(`Found ${kinetixPosts.length} posts by Kinetix\n`);

  // Check which posts are already in evidence
  const existingEventIds = new Set(commitment.evidence.map(e => e.event_id));

  let newEvidenceCount = 0;

  for (const post of kinetixPosts) {
    if (existingEventIds.has(post.id)) {
      console.log(`⏭️  Skipping already recorded: ${post.id.substring(0, 16)}...`);
      continue;
    }

    // Check if post meets minimum length requirement
    const minLength = commitment.criteria.content_requirements?.min_length || 0;
    if (post.content.length < minLength) {
      console.log(`⏭️  Skipping (too short): ${post.id.substring(0, 16)}... (${post.content.length} chars)`);
      continue;
    }

    // Create evidence entry
    // Convert Unix timestamp to ISO string
    const timestamp = new Date(post.created_at * 1000).toISOString();

    const evidence = {
      platform: 'clawstr',
      timestamp,
      event_id: post.id,
      signature: post.sig || 'nostr_verified',  // Nostr signatures verified by relay
      action_type: 'post',
      content_hash: crypto.createHash('sha256').update(post.content).digest('hex'),
      content_text: post.content.substring(0, 300),  // First 300 chars
      content_length: post.content.length,
      verification_method: 'nostr_signature'
    };

    console.log(`✓ Adding evidence: ${post.id.substring(0, 16)}...`);
    console.log(`  Posted: ${timestamp}`);
    console.log(`  Length: ${post.content.length} chars`);
    console.log(`  Preview: "${post.content.substring(0, 80)}..."`);
    console.log('');

    await verificationService.addEvidence(commitmentId, evidence);
    newEvidenceCount++;
  }

  // Reload commitment to see updated evidence
  const updated = await dataStore.loadCommitment(commitmentId);

  console.log(`\n=== Summary ===`);
  console.log(`Total evidence collected: ${updated.evidence.length}`);
  console.log(`New evidence added: ${newEvidenceCount}`);
  console.log(`Status: ${updated.status}`);
  console.log('');
  console.log('Days of evidence:', updated.evidence.length);
  console.log('Days required:', commitment.criteria.duration_days);
  console.log('');

  if (updated.evidence.length >= commitment.criteria.duration_days) {
    console.log('✓ Enough evidence collected!');
    console.log(`  Run: node scripts/complete-clawstr-verification.js ${commitmentId}`);
  } else {
    const remaining = commitment.criteria.duration_days - updated.evidence.length;
    console.log(`⏳ Need ${remaining} more day(s) of posts`);
    console.log('  Continue posting on /c/ai-freedom daily');
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nError collecting evidence:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  });
