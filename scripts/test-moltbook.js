#!/usr/bin/env node

const { createIntroductionPost, createSubmoltPost } = require('../utils/moltbook-helpers');

async function main() {
  console.log('🦴 Kinetix Moltbook Integration Test\n');
  console.log('='.repeat(60));

  console.log('\n📝 Creating Introduction Post...\n');
  const intro = await createIntroductionPost();
  console.log(`✅ Created: ${intro.id}`);
  console.log(`   File: data/approval-queue/${intro.id}.json`);

  console.log('\n📝 Creating Submolt Announcement...\n');
  const submolt = await createSubmoltPost();
  console.log(`✅ Created: ${submolt.id}`);
  console.log(`   File: data/approval-queue/${submolt.id}.json`);

  console.log('\n' + '='.repeat(60));
  console.log('\n✅ Test complete!\n');

  console.log('Queued Posts:');
  console.log(`  1. Introduction (ID: ${intro.id}) → general`);
  console.log(`  2. Submolt Announcement (ID: ${submolt.id}) → general`);

  console.log('\n📱 Next steps:\n');
  console.log('1. Check the installed Moltbook skill in skills/moltbook-interact/');
  console.log('2. Review SKILL.md for authentication requirements');
  console.log('3. Add your Moltbook API credentials:');
  console.log('   mkdir -p ~/.config/moltbook');
  console.log('   echo \'{"api_key":"YOUR_KEY","agent_name":"Kinetix"}\' > ~/.config/moltbook/credentials.json');
  console.log('   chmod 600 ~/.config/moltbook/credentials.json');
  console.log('\n4. Use Telegram bot to approve these posts:');
  console.log(`   /pending - See all pending posts`);
  console.log(`   /approve ${intro.id} - Approve introduction`);
  console.log(`   /approve ${submolt.id} - Approve submolt announcement`);
  console.log('\n💡 Tip: Posts are queued for approval. They will be posted to Moltbook');
  console.log('   after you approve them via the Telegram bot.\n');
}

main().catch(console.error);
