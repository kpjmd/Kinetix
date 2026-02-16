#!/usr/bin/env node

/**
 * Clawstr Test Script
 *
 * Validates Clawstr integration:
 * - NAK installation and keypair access
 * - Profile fetch (verify identity)
 * - Feed query (verify relay connectivity)
 * - Notifications check (verify pubkey lookups)
 */

require('dotenv').config();
const clawstrApi = require('../utils/clawstr-api');
const stateManager = require('../utils/state-manager');

async function testNakInstallation() {
  console.log('\n=== Test 1: NAK Installation ===');
  try {
    const npub = await clawstrApi.getPublicKey();
    const hexPubkey = await clawstrApi.getHexPublicKey();
    console.log('✓ NAK is installed and working');
    console.log(`  Public key (npub): ${npub}`);
    console.log(`  Hex pubkey: ${hexPubkey}`);
    return true;
  } catch (error) {
    console.error('✗ NAK installation failed:', error.message);
    return false;
  }
}

async function testProfileFetch() {
  console.log('\n=== Test 2: Profile Fetch ===');
  try {
    const profile = await clawstrApi.getProfile();
    if (profile) {
      console.log('✓ Profile retrieved successfully');
      console.log(`  Name: ${profile.name || 'Not set'}`);
      console.log(`  About: ${profile.about?.slice(0, 80) || 'Not set'}...`);
      console.log(`  Updated: ${profile.updated_at ? new Date(profile.updated_at * 1000).toISOString() : 'Unknown'}`);
      return true;
    } else {
      console.log('⚠ No profile found (not registered yet or not propagated)');
      return false;
    }
  } catch (error) {
    console.error('✗ Profile fetch failed:', error.message);
    return false;
  }
}

async function testFeedQuery() {
  console.log('\n=== Test 3: Feed Query ===');
  try {
    console.log('Querying /c/ai-freedom feed...');
    const feed = await clawstrApi.getFeed('/c/ai-freedom', 5);
    console.log(`✓ Feed retrieved: ${feed.length} posts`);

    if (feed.length > 0) {
      console.log('\nSample posts:');
      feed.slice(0, 3).forEach((event, idx) => {
        const preview = event.content?.slice(0, 60).replace(/\n/g, ' ') || 'No content';
        const timestamp = event.created_at ? new Date(event.created_at * 1000).toISOString() : 'Unknown';
        console.log(`  ${idx + 1}. ${preview}...`);
        console.log(`     ID: ${event.id?.slice(0, 16)}...`);
        console.log(`     Time: ${timestamp}`);
      });
    }

    return feed.length > 0;
  } catch (error) {
    console.error('✗ Feed query failed:', error.message);
    return false;
  }
}

async function testNotifications() {
  console.log('\n=== Test 4: Notifications ===');
  try {
    const notifications = await clawstrApi.getNotifications(5);
    console.log(`✓ Notifications retrieved: ${notifications.length} items`);

    if (notifications.length > 0) {
      console.log('\nRecent notifications:');
      notifications.slice(0, 3).forEach((event, idx) => {
        const preview = event.content?.slice(0, 60).replace(/\n/g, ' ') || 'No content';
        const timestamp = event.created_at ? new Date(event.created_at * 1000).toISOString() : 'Unknown';
        const kind = event.kind === 1111 ? 'Post' : event.kind === 7 ? 'Reaction' : `Kind ${event.kind}`;
        console.log(`  ${idx + 1}. [${kind}] ${preview}...`);
        console.log(`     Time: ${timestamp}`);
      });
    } else {
      console.log('  No notifications yet (expected for new accounts)');
    }

    return true;
  } catch (error) {
    console.error('✗ Notifications check failed:', error.message);
    return false;
  }
}

async function testStateManager() {
  console.log('\n=== Test 5: State Manager ===');
  try {
    const socialState = await stateManager.loadState('social');
    const engagementState = await stateManager.loadState('engagement');

    console.log('✓ State manager working');
    console.log(`  Clawstr pubkey: ${socialState.clawstr_pubkey || 'Not set'}`);
    console.log(`  Subclaws joined: ${socialState.clawstr_subclaws?.length || 0}`);
    console.log(`  Profile updated: ${socialState.clawstr_profile_updated || 'Never'}`);
    console.log(`  Reacted events: ${engagementState.clawstr_reacted_events?.length || 0}`);
    console.log(`  Replied events: ${engagementState.clawstr_replied_events?.length || 0}`);
    console.log(`  Posted to subclaws: ${engagementState.clawstr_posted_subclaws?.length || 0}`);

    if (socialState.clawstr_subclaws?.length > 0) {
      console.log(`\n  Active subclaws:`);
      socialState.clawstr_subclaws.forEach(subclaw => {
        console.log(`    - ${subclaw}`);
      });
    }

    return true;
  } catch (error) {
    console.error('✗ State manager test failed:', error.message);
    return false;
  }
}

async function testRelayConnectivity() {
  console.log('\n=== Test 6: Relay Connectivity ===');
  try {
    console.log('Testing relays:');
    for (const relay of clawstrApi.CONFIG.relays) {
      console.log(`  - ${relay}`);
    }

    // Try to fetch from each relay by querying a popular subclaw
    const feed = await clawstrApi.getFeed('/c/introductions', 1);

    if (feed.length > 0) {
      console.log('✓ At least one relay is responding');
    } else {
      console.log('⚠ No results from relays (they may be slow)');
    }

    return true;
  } catch (error) {
    console.error('✗ Relay connectivity test failed:', error.message);
    return false;
  }
}

async function main() {
  console.log('=====================================');
  console.log('Clawstr Integration Test Suite');
  console.log('=====================================');

  const results = {
    nakInstall: await testNakInstallation(),
    profile: await testProfileFetch(),
    feed: await testFeedQuery(),
    notifications: await testNotifications(),
    state: await testStateManager(),
    relays: await testRelayConnectivity()
  };

  console.log('\n=====================================');
  console.log('Test Results Summary');
  console.log('=====================================\n');

  const passed = Object.values(results).filter(r => r === true).length;
  const total = Object.keys(results).length;

  console.log(`NAK Installation:     ${results.nakInstall ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Profile Fetch:        ${results.profile ? '✓ PASS' : '⚠ WARN'}`);
  console.log(`Feed Query:           ${results.feed ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Notifications:        ${results.notifications ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`State Manager:        ${results.state ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Relay Connectivity:   ${results.relays ? '✓ PASS' : '✗ FAIL'}`);

  console.log(`\nOverall: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('\n🎉 All tests passed! Clawstr integration is working correctly.\n');
    console.log('Next steps:');
    console.log('  1. Start the bot: npm start');
    console.log('  2. Try: /clawstr_feed');
    console.log('  3. Enable heartbeat for autonomous engagement\n');
    process.exit(0);
  } else if (passed >= total - 1) {
    console.log('\n⚠ Most tests passed. Review warnings above.\n');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. Please review errors above.\n');
    console.log('Troubleshooting:');
    console.log('  - Ensure NAK is installed: npm run install:nak');
    console.log('  - Register on Clawstr: npm run register:clawstr');
    console.log('  - Check .env configuration');
    console.log('  - Verify internet connectivity to relays\n');
    process.exit(1);
  }
}

// Run tests
main();
