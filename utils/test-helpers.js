const { createPostForApproval } = require('./post-generator');

async function createTestPost() {
  console.log('Creating test post for approval queue...');

  const testContent = `Testing Kinetix's approval-queue pipeline: this post confirms local setup is wired correctly (config, personality, post-generator) before any live Moltbook credentials are involved.

Kinetix is verification infrastructure for AI agents — it verifies commitments and issues cryptographically signed attestation receipts (Proof of Action).`;

  const post = await createPostForApproval(
    testContent,
    'general',
    'test_initialization',
    {
      type: 'setup_smoke_test'
    }
  );

  console.log(`✅ Test post created with ID: ${post.id}`);
  console.log(`📁 Saved to: data/approval-queue/${post.id}.json`);
  console.log('\nUse Telegram bot to approve or reject this post:');
  console.log(`  /pending - View pending posts`);
  console.log(`  /approve ${post.id} - Approve this post`);
  console.log(`  /reject ${post.id} - Reject this post`);

  return post;
}

async function testPersonality() {
  console.log('\n🧠 Testing Kinetix Personality Configuration...\n');

  const personality = require('../config/personality.json');

  console.log('Core Traits (Priority Order):');
  personality.core_traits.priority_order.forEach((trait, i) => {
    const traitData = personality.core_traits[trait];
    console.log(`  ${i + 1}. ${trait}`);
    console.log(`     ${traitData.description}`);
  });

  console.log('\nVoice Guidelines:');
  console.log(`  Tone: ${personality.voice_guidelines.tone}`);
  console.log(`  Emoji Usage: ${personality.voice_guidelines.emoji_usage.frequency}`);

  console.log('\nHuman References (Playful Terms):');
  personality.voice_guidelines.human_references.playful_terms.forEach(ref => {
    console.log(`  - ${ref}`);
  });

  console.log('\n✅ Personality configuration loaded successfully!');
}

module.exports = {
  createTestPost,
  testPersonality
};
