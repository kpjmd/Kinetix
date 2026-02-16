#!/usr/bin/env node

const { createTestPost, testPersonality } = require('../utils/test-helpers');

async function main() {
  console.log('🦴 Kinetix Agent Setup Test\n');
  console.log('='.repeat(50));

  // Test personality config
  await testPersonality();

  console.log('\n' + '='.repeat(50));

  // Create test post
  console.log('\n📝 Creating Test Approval Post...\n');
  await createTestPost();

  console.log('\n' + '='.repeat(50));
  console.log('\n✅ Setup test complete!\n');
  console.log('Next steps:');
  console.log('1. Add your credentials to .env file');
  console.log('2. Run: npm start');
  console.log('3. Open Telegram and message your bot');
  console.log('4. Send /start to see available commands');
  console.log('5. Try chatting with Kinetix!');
  console.log('6. Use /pending to see the test post');
}

main().catch(console.error);
