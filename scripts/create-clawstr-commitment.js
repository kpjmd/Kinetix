#!/usr/bin/env node

/**
 * Create a Clawstr consistency commitment for Kinetix
 *
 * This creates a 3-day commitment for Kinetix to post daily on /c/ai-freedom
 */

require('dotenv').config();
const verificationService = require('../services/verification-service');

async function main() {
  console.log('\n=== Creating Kinetix Clawstr Commitment ===\n');

  const commitment = {
    agent_id: 'Kinetix',
    description: 'Engage on Clawstr (/c/ai-freedom) at least once daily for 3 consecutive days',
    verification_type: 'consistency',
    criteria: {
      platform: 'clawstr',
      frequency: 'daily',
      duration_days: 3,
      minimum_actions: 1,
      action_types: ['post'],
      content_requirements: {
        min_length: 50
      }
    },
    pubkey: 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5',
    platform_profiles: {
      clawstr: 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5'
    }
  };

  console.log('Creating commitment with criteria:');
  console.log(JSON.stringify(commitment.criteria, null, 2));
  console.log('');

  const result = await verificationService.createVerification(commitment);

  console.log('\n✓ Commitment created successfully!\n');
  console.log('Commitment ID:', result.verification_id);
  console.log('Status:', result.status);
  console.log('Start Date:', result.start_date);
  console.log('End Date:', result.expected_completion);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Post on Clawstr /c/ai-freedom daily for 3 days');
  console.log('  2. Run: node scripts/collect-clawstr-evidence.js <commitment_id>');
  console.log('     (Run after each post to collect evidence)');
  console.log('  3. After 3 days, run: node scripts/complete-clawstr-verification.js <commitment_id>');
  console.log('');
  console.log(`Save this commitment ID: ${result.verification_id}`);
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nError creating commitment:');
    console.error(error.message);
    process.exit(1);
  });
