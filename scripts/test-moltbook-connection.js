#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const MOLTBOOK_API_BASE = 'https://www.moltbook.com/api/v1';

async function testConnection() {
  console.log('🦞 Testing Moltbook API Connection...\n');
  console.log('='.repeat(60));

  // Load credentials
  const credPath = path.join(os.homedir(), '.config', 'moltbook', 'credentials.json');

  let credentials;
  try {
    credentials = JSON.parse(await fs.readFile(credPath, 'utf-8'));
  } catch (error) {
    console.error('\n❌ Credentials not found!');
    console.error('   Run: npm run register:moltbook');
    process.exit(1);
  }

  console.log('📋 Loaded Credentials:');
  console.log(`   Agent: ${credentials.agent_name}`);
  console.log(`   API Key: ${credentials.api_key.substring(0, 20)}...`);
  console.log('\n' + '='.repeat(60));

  try {
    // Test 1: Check claim status
    console.log('\n1️⃣  Checking claim status...');
    const statusResponse = await axios.get(
      `${MOLTBOOK_API_BASE}/agents/status`,
      {
        headers: {
          'Authorization': `Bearer ${credentials.api_key}`
        }
      }
    );

    console.log(`   Status: ${statusResponse.data.status}`);

    if (statusResponse.data.status === 'pending_claim') {
      console.log('\n   ⚠️  Agent not claimed yet!');
      console.log(`   Claim URL: ${credentials.claim_url}`);
      console.log(`   Verification Code: ${credentials.verification_code}`);
      console.log('\n   Keith needs to:');
      console.log('   1. Visit the claim URL');
      console.log('   2. Post verification tweet');
      console.log('   3. Run this test again after claiming');
      return;
    }

    console.log('   ✅ Agent is claimed!');

    // Test 2: Get profile
    console.log('\n2️⃣  Fetching agent profile...');
    const profileResponse = await axios.get(
      `${MOLTBOOK_API_BASE}/agents/me`,
      {
        headers: {
          'Authorization': `Bearer ${credentials.api_key}`
        }
      }
    );

    const profile = profileResponse.data.agent;
    console.log(`   Name: ${profile.name}`);
    console.log(`   Karma: ${profile.karma}`);
    console.log(`   Followers: ${profile.follower_count}`);
    console.log(`   Following: ${profile.following_count}`);
    console.log(`   Profile: https://www.moltbook.com/u/${profile.name}`);

    if (profile.owner) {
      console.log(`   Owner: @${profile.owner.x_handle} (${profile.owner.x_name})`);
    }

    // Test 3: Get feed
    console.log('\n3️⃣  Fetching feed...');
    const feedResponse = await axios.get(
      `${MOLTBOOK_API_BASE}/posts?sort=hot&limit=5`,
      {
        headers: {
          'Authorization': `Bearer ${credentials.api_key}`
        }
      }
    );

    console.log(`   Found ${feedResponse.data.posts?.length || 0} posts`);

    if (feedResponse.data.posts?.length > 0) {
      console.log('\n   Recent posts:');
      feedResponse.data.posts.slice(0, 3).forEach((post, i) => {
        console.log(`   ${i + 1}. "${post.title}" by ${post.author?.name}`);
        console.log(`      ⬆️  ${post.upvotes} | 💬 ${post.comment_count}`);
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ All tests passed! Kinetix is ready for Moltbook! 🦞\n');
    console.log('Next steps:');
    console.log('1. Use Telegram bot to approve introduction post: /pending');
    console.log('2. Post will be published to Moltbook');
    console.log('3. Start engaging with the community!');

  } catch (error) {
    console.error('\n❌ Connection test failed!');

    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Error: ${error.response.data?.error || 'Unknown error'}`);
    } else {
      console.error(`   ${error.message}`);
    }

    process.exit(1);
  }
}

testConnection().catch(console.error);
