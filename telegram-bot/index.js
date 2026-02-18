const { Telegraf } = require('telegraf');
const fs = require('fs').promises;
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const moltbookApi = require('../utils/moltbook-api');
const clawstrApi = require('../utils/clawstr-api');
const stateManager = require('../utils/state-manager');
const HeartbeatSystem = require('../utils/heartbeat');
const { MOLTBOOK_TOOLS, executeTool } = require('../utils/nlp-moltbook');
const { CLAWSTR_TOOLS, executeTool: executeClawstrTool } = require('../utils/nlp-clawstr');
const { VERIFICATION_TOOLS, executeVerificationTool } = require('../utils/nlp-verification');
const walletManager = require('../wallet/wallet-manager');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
const APPROVAL_QUEUE_PATH = path.join(__dirname, '../data/approval-queue');
const CONVERSATION_PATH = path.join(__dirname, '../data/conversation-history');

// Load configurations
let agentConfig, personality, tokens;
async function loadConfigs() {
  agentConfig = JSON.parse(await fs.readFile('./config/agent.json', 'utf-8'));
  personality = JSON.parse(await fs.readFile('./config/personality.json', 'utf-8'));
  tokens = JSON.parse(await fs.readFile('./config/tokens.json', 'utf-8'));

  // Verify Moltbook API key is loaded
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    console.error('⚠️  WARNING: MOLTBOOK_API_KEY not found in environment');
  } else {
    console.log(`✅ Moltbook API key loaded: ${apiKey.slice(0, 20)}...`);
  }
}

// Middleware: Admin only
bot.use(async (ctx, next) => {
  if (!ADMIN_ID || ctx.from.id.toString() !== ADMIN_ID) {
    await ctx.reply('⛔ Unauthorized. This bot is private.');
    return;
  }
  return next();
});

// Start command
bot.command('start', async (ctx) => {
  await ctx.reply(
    `🦴 *Kinetix Agent Control Panel*\n\n` +
    `*Queue & Posting:*\n` +
    `📝 /pending - View posts awaiting approval\n` +
    `🏗️ /create_submolt [id] - Create submolt (for announcements)\n` +
    `✅ /approve [id] - Approve & post to Moltbook\n` +
    `❌ /reject [id] - Reject a post\n` +
    `💬 /post - Create manual Moltbook post\n\n` +
    `*Moltbook:*\n` +
    `📰 /feed [sort] - View feed (hot/new/top)\n` +
    `🔍 /search <query> - Search Moltbook\n` +
    `💬 /comment <id> <text> - Comment on post\n` +
    `↩️ /reply <post> <comment> <text> - Reply to comment\n` +
    `👍 /upvote <id> - Upvote a post\n` +
    `👎 /downvote <id> - Downvote a post\n` +
    `➕ /follow <agent> - Follow an agent\n` +
    `➖ /unfollow <agent> - Unfollow an agent\n` +
    `📂 /submolts - List submolts\n` +
    `📥 /subscribe <name> - Subscribe to submolt\n` +
    `👤 /profile - View Kinetix profile\n` +
    `📧 /setup_owner_email <email> - Setup owner account\n\n` +
    `*Clawstr (Nostr):*\n` +
    `🌐 /clawstr_feed [subclaw] - View Clawstr feed\n` +
    `📝 /clawstr_post <subclaw> <text> - Post to Clawstr\n` +
    `💬 /clawstr_reply <event_id> <text> - Reply on Clawstr\n` +
    `👍 /clawstr_react <event_id> +/- - React to event\n` +
    `🔔 /clawstr_notifications - Check Clawstr notifications\n` +
    `👤 /clawstr_profile - View Nostr profile\n\n` +
    `*Verification:*\n` +
    `✅ /verify - Create verification or view instructions\n` +
    `📊 /verification_status [id] - Check verification progress\n` +
    `📜 /attestation [receipt_id] - View attestation receipt\n` +
    `📋 /manifest - View service capabilities\n` +
    `🔍 /discoveries - View pending verification suggestions\n` +
    `✅ /approve_verify <id> - Accept suggestion → create verification\n` +
    `❌ /reject_verify <id> - Dismiss suggestion\n` +
    `📣 /announce_verification <receipt_id> - Queue announcement post\n\n` +
    `*Settings:*\n` +
    `📊 /status - Agent status & metrics\n` +
    `🎯 /mode - Toggle posting mode\n` +
    `🧠 /personality - View personality config\n` +
    `🤖 /heartbeat - Run heartbeat check now\n` +
    `📈 /heartbeat_status - View heartbeat status\n\n` +
    `*Wallet:*\n` +
    `💼 /wallet - Wallet status & balances\n` +
    `💰 /balances - All asset balances\n` +
    `📊 /spending - Spending report\n` +
    `🔔 /pending_tx - Pending wallet transactions\n` +
    `✅ /approve_tx [id] - Approve transaction\n` +
    `❌ /reject_tx [id] [reason] - Reject transaction\n` +
    `⚙️ /limits - View safety limits\n` +
    `💵 /update_price [asset] [price] - Update asset price\n` +
    `📜 /tx_history [limit] - Transaction history\n\n` +
    `💡 *Tip:* Just send a message to chat directly with Kinetix!`,
    { parse_mode: 'Markdown' }
  );
});

// Status command
bot.command('status', async (ctx) => {
  try {
    const pending = await getPendingPosts();
    const conversationFiles = await fs.readdir(CONVERSATION_PATH).catch(() => []);

    await ctx.reply(
      `📊 *Kinetix Status Report*\n\n` +
      `🟢 Agent: Active\n` +
      `🤖 Mode: ${agentConfig.posting_mode}\n` +
      `📝 Model: ${agentConfig.model}\n` +
      `🌡️ Temperature: ${agentConfig.temperature}\n\n` +
      `📬 Pending Approvals: ${pending.length}\n` +
      `💬 Conversation History: ${conversationFiles.length} sessions\n\n` +
      `🪙 *Tokens:*\n` +
      `• $KINETIX: ${tokens.tokens?.KINETIX?.contract_address?.slice(0, 8) || 'Not configured'}...\n` +
      `• $OIQ: ${tokens.tokens?.OIQ?.status || 'Not configured'}\n` +
      `• USDC: Ready for x402\n\n` +
      `Last updated: ${new Date().toLocaleString()}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error getting status: ${error.message}`);
  }
});

// Pending posts command
bot.command('pending', async (ctx) => {
  try {
    const pending = await getPendingPosts();

    if (pending.length === 0) {
      await ctx.reply('✅ No posts pending approval.');
      return;
    }

    await ctx.reply(`📋 ${pending.length} post(s) awaiting approval:`);

    for (const post of pending) {
      // Determine platform and display info
      const platform = post.metadata?.platform || 'moltbook';
      const platformEmoji = platform === 'clawstr' ? '🌐' : '📰';

      let locationInfo;
      if (platform === 'clawstr') {
        locationInfo = `📂 Subclaw: ${post.metadata?.subclaw || 'Unknown'}`;
      } else {
        const submoltName = post.submolt || post.metadata?.submolt_name || 'general';
        locationInfo = `🏷️ Submolt: ${submoltName}`;
      }

      // Send everything as plain text to avoid Markdown parsing issues
      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `📝 Post #${post.id}\n` +
        `${platformEmoji} Platform: ${platform}\n` +
        `${locationInfo}\n` +
        `⚡ Trigger: ${post.trigger || 'Manual'}\n` +
        `⏰ Created: ${new Date(post.timestamp).toLocaleString()}\n\n` +
        `Content:\n${post.content}\n\n` +
        `✅ Approve: /approve ${post.id}\n` +
        `❌ Reject: /reject ${post.id}`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Error loading pending posts: ${error.message}`);
  }
});

// Create submolt (for submolt announcement posts)
bot.command('create_submolt', async (ctx) => {
  const postId = ctx.message.text.split(' ')[1];

  if (!postId) {
    await ctx.reply('❌ Usage: /create_submolt [post_id]');
    return;
  }

  try {
    const post = await getPostById(postId);
    if (!post) {
      await ctx.reply(`❌ Post #${postId} not found in approval queue.`);
      return;
    }

    // Verify this is a submolt announcement
    if (post.metadata?.type !== 'submolt_announcement') {
      await ctx.reply(`❌ Post #${postId} is not a submolt announcement. Use /approve instead.`);
      return;
    }

    // Check if already created
    if (post.metadata?.submolt_created) {
      await ctx.reply(
        `ℹ️ Submolt already created at ${new Date(post.metadata.submolt_created_at).toLocaleString()}\n\n` +
        `📂 Submolt: m/${post.metadata.submolt_name}\n` +
        `🔗 View: https://www.moltbook.com/m/${post.metadata.submolt_name}\n\n` +
        `To post the announcement:\n/approve ${postId}`
      );
      return;
    }

    await ctx.reply(`⏳ Creating submolt on Moltbook...`);

    const submoltName = (post.metadata.submolt_name || '').replace(/^m\//, '');
    const displayName = post.metadata.submolt_display_name || submoltName;
    const description = post.metadata.submolt_description || '';

    if (!submoltName) {
      await ctx.reply('❌ Missing submolt name in metadata.');
      return;
    }

    console.log(`[create_submolt] Creating submolt: ${submoltName}`);

    // Step 1: Create the submolt
    const submoltResult = await moltbookApi.createSubmolt(submoltName, displayName, description);
    console.log(`[create_submolt] Submolt created:`, submoltResult);

    // Step 2: Subscribe to the new submolt
    try {
      await moltbookApi.subscribe(submoltName);
      console.log(`[create_submolt] Subscribed to ${submoltName}`);
    } catch (subscribeError) {
      console.log(`[create_submolt] Warning: Failed to subscribe to ${submoltName}:`, subscribeError.message);
    }

    // Step 3: Update post metadata (but keep in queue)
    post.metadata.submolt_created = true;
    post.metadata.submolt_created_at = new Date().toISOString();

    const queuePath = path.join(APPROVAL_QUEUE_PATH, `${postId}.json`);
    await fs.writeFile(queuePath, JSON.stringify(post, null, 2));

    console.log(`[create_submolt] Updated metadata for post ${postId}`);

    await ctx.reply(
      `✅ Submolt created on Moltbook!\n\n` +
      `📂 Submolt: m/${submoltName}\n` +
      `🏷️ Display Name: ${displayName}\n\n` +
      `🔗 View: https://www.moltbook.com/m/${submoltName}\n\n` +
      `To post the announcement:\n/approve ${postId}`
    );

  } catch (error) {
    console.error(`[create_submolt] Error:`, error);
    await ctx.reply(`❌ Error creating submolt: ${error.message}`);
  }
});

// Approve post
bot.command('approve', async (ctx) => {
  const postId = ctx.message.text.split(' ')[1];

  if (!postId) {
    await ctx.reply('❌ Usage: /approve [post_id]');
    return;
  }

  try {
    const post = await getPostById(postId);
    if (!post) {
      await ctx.reply(`❌ Post #${postId} not found in approval queue.`);
      return;
    }

    // ========================================
    // CLAWSTR (Nostr) POST APPROVAL
    // ========================================
    if (post.metadata?.platform === 'clawstr') {
      console.log(`[approve] Processing Clawstr ${post.metadata.type}`);

      if (post.metadata.type === 'post') {
        // Clawstr post
        await ctx.reply(`⏳ Posting to Clawstr ${post.metadata.subclaw}...`);

        try {
          const result = await clawstrApi.createPost(post.metadata.subclaw, post.content);
          console.log(`[approve] Clawstr post created:`, result);

          await stateManager.recordEngagement('clawstr_post', result.eventId, {
            subclaw: post.metadata.subclaw,
            eventId: result.eventId
          });

          await removeFromQueue(post.id);

          await ctx.reply(
            `✅ Posted to Clawstr!\n\n` +
            `📂 Subclaw: ${post.metadata.subclaw}\n` +
            `🔗 Event ID: ${result.eventId?.slice(0, 16)}...\n` +
            `⏰ Timestamp: ${result.timestamp}`
          );

          return;
        } catch (error) {
          console.error(`[approve] Clawstr post error:`, error);
          await ctx.reply(`❌ Error posting to Clawstr: ${error.message}`);
          return;
        }

      } else if (post.metadata.type === 'reply') {
        // Clawstr reply
        await ctx.reply(`⏳ Posting Clawstr reply...`);

        try {
          const result = await clawstrApi.createReply(
            post.metadata.parentEventId,
            post.content,
            post.metadata.subclaw,
            post.metadata.parentPubkey
          );
          console.log(`[approve] Clawstr reply created:`, result);

          await stateManager.recordEngagement('clawstr_reply', result.eventId, {
            parentEventId: post.metadata.parentEventId,
            subclaw: post.metadata.subclaw,
            eventId: result.eventId
          });

          await removeFromQueue(post.id);

          await ctx.reply(
            `✅ Clawstr reply posted!\n\n` +
            `↩️ Replying to: ${post.metadata.parentEventId.slice(0, 16)}...\n` +
            `🔗 Reply Event: ${result.eventId?.slice(0, 16)}...\n` +
            `📂 Subclaw: ${post.metadata.subclaw}`
          );

          return;
        } catch (error) {
          console.error(`[approve] Clawstr reply error:`, error);
          await ctx.reply(`❌ Error posting Clawstr reply: ${error.message}`);
          return;
        }
      }
    }

    // ========================================
    // MOLTBOOK POST APPROVAL
    // ========================================

    // Check if this is a comment (queued by heartbeat or NLP)
    if (post.metadata?.type === 'comment') {
      const commentPostId = post.metadata.postId;

      if (!commentPostId) {
        await ctx.reply(`❌ Invalid comment - missing postId in metadata.`);
        return;
      }

      await ctx.reply(`⏳ Posting comment to Moltbook...`);

      try {
        const result = await moltbookApi.addComment(commentPostId, post.content);
        console.log(`[approve] Comment posted:`, result);

        await removeFromQueue(post.id);

        await ctx.reply(
          `✅ Comment posted!\n\n` +
          `💬 Comment ID: ${result.id || 'Unknown'}\n` +
          `📝 On post: ${commentPostId}\n` +
          `🔗 View: https://www.moltbook.com/posts/${commentPostId}`
        );

        return; // Exit early
      } catch (error) {
        console.error(`[approve] Comment error:`, error);
        await ctx.reply(`❌ Error posting comment: ${error.message}`);
        return;
      }
    }

    // Check if this is a submolt creation request
    if (post.metadata?.type === 'submolt_announcement') {
      // Check if submolt was created first
      if (!post.metadata?.submolt_created) {
        await ctx.reply(
          `⚠️ Submolt not created yet.\n\n` +
          `First create the submolt:\n/create_submolt ${postId}\n\n` +
          `Then approve the post.`
        );
        return;
      }

      // Submolt already created, just post the announcement
      await ctx.reply(`⏳ Posting announcement to m/${post.metadata.submolt_name}...`);

      const submoltName = (post.metadata.submolt_name || '').replace(/^m\//, '');
      const title = post.metadata?.title || '';

      console.log(`[approve] Posting to existing submolt: ${submoltName}`);

      // Post the announcement content
      const postResult = await moltbookApi.createPost(submoltName, title, post.content);
      console.log(`[approve] Post created:`, postResult);

      // Remove from approval queue
      await removeFromQueue(postId);

      await ctx.reply(
        `✅ Posted to Moltbook!\n\n` +
        `📝 Post ID: ${postResult.id || postResult.post?.id || 'Unknown'}\n` +
        `📂 Submolt: m/${submoltName}\n` +
        `🔗 View: https://www.moltbook.com/m/${submoltName}/posts/${postResult.id || postResult.post?.id || ''}`
      );

      return;
    }

    // Regular post approval (not submolt announcement)
    await ctx.reply(`⏳ Posting to Moltbook...`);

    const submolt = post.submolt || post.metadata?.submolt_name || 'general';
    const title = post.metadata?.title || 'Untitled Post';

    console.log(`[approve] Regular post to submolt: ${submolt}`);

    const result = await moltbookApi.createPost(submolt, title, post.content);
    console.log(`[approve] Post created:`, result);

    await removeFromQueue(postId);

    await ctx.reply(
      `✅ Posted to Moltbook!\n\n` +
      `📝 Post ID: ${result.id || result.post?.id || 'Unknown'}\n` +
      `📂 Submolt: m/${submolt}\n` +
      `🔗 View: https://www.moltbook.com/m/${submolt}/posts/${result.id || result.post?.id || ''}`
    );

  } catch (error) {
    console.error(`[approve] Error:`, error);
    await ctx.reply(`❌ Error approving post: ${error.message}`);
  }
});

// Reject post
bot.command('reject', async (ctx) => {
  const postId = ctx.message.text.split(' ')[1];

  if (!postId) {
    await ctx.reply('❌ Usage: /reject [post_id]');
    return;
  }

  try {
    await removeFromQueue(postId);
    await ctx.reply(`🗑️ Post #${postId} rejected and removed from queue.`);
  } catch (error) {
    await ctx.reply(`❌ Error rejecting post: ${error.message}`);
  }
});

// Mode toggle
bot.command('mode', async (ctx) => {
  try {
    const currentMode = agentConfig.posting_mode;
    const newMode = currentMode === 'approval' ? 'autonomous' : 'approval';

    agentConfig.posting_mode = newMode;
    await fs.writeFile('./config/agent.json', JSON.stringify(agentConfig, null, 2));

    await ctx.reply(
      `🔄 *Posting mode changed*\n\n` +
      `Previous: ${currentMode}\n` +
      `Current: ${newMode}\n\n` +
      `${newMode === 'autonomous' ? '⚠️ Posts will now publish automatically!' : '✅ Posts will require approval.'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error changing mode: ${error.message}`);
  }
});

// ===== Moltbook Commands =====

// Feed command
bot.command('feed', async (ctx) => {
  const sort = ctx.message.text.split(' ')[1] || 'hot';

  if (!['hot', 'new', 'top'].includes(sort)) {
    await ctx.reply('❌ Usage: /feed [hot|new|top]');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    const posts = await moltbookApi.getFeed(sort, 5);

    if (!posts || posts.length === 0) {
      await ctx.reply(`📭 No posts found in ${sort} feed.`);
      return;
    }

    await ctx.reply(`📰 *Moltbook Feed (${sort})*`, { parse_mode: 'Markdown' });

    for (const post of posts) {
      const score = post.score ?? post.upvotes ?? 0;
      const comments = post.comment_count ?? post.comments ?? 0;
      const submolt = post.submolt || 'main';
      const preview = post.content?.slice(0, 200) || '';
      const truncated = post.content?.length > 200 ? '...' : '';

      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `📝 ${post.title || '(No title)'}\n` +
        `👤 ${post.author || 'Unknown'} in m/${submolt}\n` +
        `⬆️ ${score} | 💬 ${comments}\n\n` +
        `${preview}${truncated}\n\n` +
        `🔗 ID: ${post.id}\n` +
        `👍 /upvote ${post.id}\n` +
        `💬 /comment ${post.id} <text>`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Error fetching feed: ${error.message}`);
  }
});

// Search command
bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace(/^\/search\s*/, '').trim();

  if (!query) {
    await ctx.reply('❌ Usage: /search <query>');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    const results = await moltbookApi.search(query, 'all', 5);

    const posts = results.posts || results.results || results || [];

    if (!posts || posts.length === 0) {
      await ctx.reply(`🔍 No results found for: "${query}"`);
      return;
    }

    await ctx.reply(`🔍 *Search results for:* "${query}"`, { parse_mode: 'Markdown' });

    for (const post of posts.slice(0, 5)) {
      const score = post.score ?? post.upvotes ?? 0;
      const submolt = post.submolt || 'main';
      const preview = post.content?.slice(0, 150) || '';
      const truncated = post.content?.length > 150 ? '...' : '';

      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `📝 ${post.title || '(No title)'}\n` +
        `👤 ${post.author || 'Unknown'} in m/${submolt}\n` +
        `⬆️ ${score}\n\n` +
        `${preview}${truncated}\n\n` +
        `🔗 ID: ${post.id}`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Error searching: ${error.message}`);
  }
});

// Comment command
bot.command('comment', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const postId = parts[1];
  const content = parts.slice(2).join(' ');

  if (!postId || !content) {
    await ctx.reply('❌ Usage: /comment <post_id> <your comment>');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    const result = await moltbookApi.addComment(postId, content);

    await ctx.reply(
      `✅ Comment posted!\n\n` +
      `📝 Post: ${postId}\n` +
      `💬 Comment ID: ${result.id || 'N/A'}`
    );
  } catch (error) {
    const retryMsg = error.retryAfter ? `\n⏰ Retry after: ${error.retryAfter}s` : '';
    await ctx.reply(`❌ Failed to comment: ${error.message}${retryMsg}`);
  }
});

// Upvote command
bot.command('upvote', async (ctx) => {
  const postId = ctx.message.text.split(' ')[1];

  if (!postId) {
    await ctx.reply('❌ Usage: /upvote <post_id>');
    return;
  }

  try {
    await moltbookApi.upvote(postId);
    await ctx.reply(`👍 Upvoted post ${postId}!`);
  } catch (error) {
    await ctx.reply(`❌ Failed to upvote: ${error.message}`);
  }
});

// Downvote command
bot.command('downvote', async (ctx) => {
  const postId = ctx.message.text.split(' ')[1];

  if (!postId) {
    await ctx.reply('❌ Usage: /downvote <post_id>');
    return;
  }

  try {
    await moltbookApi.downvote(postId);
    await ctx.reply(`👎 Downvoted post ${postId}!`);
  } catch (error) {
    await ctx.reply(`❌ Failed to downvote: ${error.message}`);
  }
});

// Follow command
bot.command('follow', async (ctx) => {
  const agentName = ctx.message.text.split(' ')[1];

  if (!agentName) {
    await ctx.reply('❌ Usage: /follow <agent_name>');
    return;
  }

  try {
    await moltbookApi.followAgent(agentName);
    await ctx.reply(`✅ Now following ${agentName}!`);
  } catch (error) {
    await ctx.reply(`❌ Failed to follow: ${error.message}`);
  }
});

// Unfollow command
bot.command('unfollow', async (ctx) => {
  const agentName = ctx.message.text.split(' ')[1];

  if (!agentName) {
    await ctx.reply('❌ Usage: /unfollow <agent_name>');
    return;
  }

  try {
    await moltbookApi.unfollowAgent(agentName);
    await ctx.reply(`✅ Unfollowed ${agentName}.`);
  } catch (error) {
    await ctx.reply(`❌ Failed to unfollow: ${error.message}`);
  }
});

// Reply command (nested comments)
bot.command('reply', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const postId = parts[1];
  const commentId = parts[2];
  const content = parts.slice(3).join(' ');

  if (!postId || !commentId || !content) {
    await ctx.reply('❌ Usage: /reply <post_id> <comment_id> <text>');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    const result = await moltbookApi.addComment(postId, content, commentId);
    await ctx.reply(
      `✅ Reply posted!\n\n` +
      `📝 Post: ${postId}\n` +
      `💬 Parent Comment: ${commentId}\n` +
      `🔗 Reply ID: ${result.id || 'N/A'}`
    );
  } catch (error) {
    const retryMsg = error.retryAfter ? `\n⏰ Retry after: ${error.retryAfter}s` : '';
    await ctx.reply(`❌ Failed to reply: ${error.message}${retryMsg}`);
  }
});

// Submolts command
bot.command('submolts', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const submolts = await moltbookApi.listSubmolts();

    const list = submolts.submolts || submolts || [];

    if (!list || list.length === 0) {
      await ctx.reply('📂 No submolts found.');
      return;
    }

    let message = '📂 *Available Submolts*\n\n';

    for (const s of list.slice(0, 15)) {
      const name = s.name || s.slug || 'unknown';
      const members = s.subscribers || s.member_count || 0;
      const desc = s.description?.slice(0, 50) || '';
      const truncated = s.description?.length > 50 ? '...' : '';
      message += `• *m/${name}* (${members} members)\n  ${desc}${truncated}\n\n`;
    }

    message += `\n➕ Subscribe: /subscribe <name>`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply(`❌ Error fetching submolts: ${error.message}`);
  }
});

// Subscribe command
bot.command('subscribe', async (ctx) => {
  const name = ctx.message.text.split(' ')[1]?.replace(/^m\//, '');

  if (!name) {
    await ctx.reply('❌ Usage: /subscribe <submolt_name>');
    return;
  }

  try {
    await moltbookApi.subscribe(name);
    await ctx.reply(`✅ Subscribed to m/${name}!`);
  } catch (error) {
    await ctx.reply(`❌ Failed to subscribe: ${error.message}`);
  }
});

// Unsubscribe command
bot.command('unsubscribe', async (ctx) => {
  const name = ctx.message.text.split(' ')[1]?.replace(/^m\//, '');

  if (!name) {
    await ctx.reply('❌ Usage: /unsubscribe <submolt_name>');
    return;
  }

  try {
    await moltbookApi.unsubscribe(name);
    await ctx.reply(`✅ Unsubscribed from m/${name}.`);
  } catch (error) {
    await ctx.reply(`❌ Failed to unsubscribe: ${error.message}`);
  }
});

// Profile command
bot.command('profile', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const profile = await moltbookApi.getProfile();

    const karma = profile.karma ?? profile.score ?? 0;
    const posts = profile.post_count ?? profile.posts ?? 0;
    const comments = profile.comment_count ?? profile.comments ?? 0;
    const followers = profile.follower_count ?? profile.followers ?? 0;
    const following = profile.following_count ?? profile.following ?? 0;
    const joined = profile.created_at ? new Date(profile.created_at).toLocaleDateString() : 'N/A';

    await ctx.reply(
      `👤 *Kinetix Moltbook Profile*\n\n` +
      `🏷️ Username: ${profile.username || profile.name || 'Kinetix'}\n` +
      `⭐ Karma: ${karma}\n` +
      `📝 Posts: ${posts}\n` +
      `💬 Comments: ${comments}\n` +
      `👥 Followers: ${followers}\n` +
      `➡️ Following: ${following}\n` +
      `📅 Joined: ${joined}\n\n` +
      `🔗 https://www.moltbook.com/u/Kinetix`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error fetching profile: ${error.message}`);
  }
});

// Setup owner email command
bot.command('setup_owner_email', async (ctx) => {
  const email = ctx.message.text.split(' ')[1];

  if (!email || !email.includes('@')) {
    await ctx.reply('❌ Usage: /setup_owner_email <email>\n\nExample: /setup_owner_email human@example.com');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    const result = await moltbookApi.setupOwnerEmail(email);

    await ctx.reply(
      `✅ *Owner Email Setup Initiated*\n\n` +
      `Email: ${email}\n\n` +
      `Next steps:\n` +
      `1. Check ${email} for setup link\n` +
      `2. Verify X account ownership\n` +
      `3. Pick Moltbook username\n` +
      `4. Access owner dashboard at moltbook.com/login\n\n` +
      `Status: ${result.status || 'Email sent'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Failed to setup owner email: ${error.message}`);
  }
});

// ========================================
// CLAWSTR (Nostr) COMMANDS
// ========================================

// Clawstr feed command
bot.command('clawstr_feed', async (ctx) => {
  const subclaw = ctx.message.text.split(' ')[1] || '/c/ai-freedom';

  try {
    await ctx.sendChatAction('typing');
    const feed = await clawstrApi.getFeed(subclaw, 5);

    if (!feed || feed.length === 0) {
      await ctx.reply(`🌐 No posts found in ${subclaw}`);
      return;
    }

    await ctx.reply(`🌐 *Clawstr Feed: ${subclaw}*\n\nShowing ${feed.length} recent posts:`, { parse_mode: 'Markdown' });

    for (const event of feed) {
      const preview = event.content?.slice(0, 200) || '(No content)';
      const truncated = event.content?.length > 200 ? '...' : '';
      const timestamp = event.created_at ? new Date(event.created_at * 1000).toLocaleString() : 'Unknown';
      const eventIdShort = event.id?.slice(0, 16) || 'N/A';
      const authorShort = event.pubkey?.slice(0, 16) || 'Unknown';

      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `📝 ${preview}${truncated}\n\n` +
        `👤 ${authorShort}...\n` +
        `⏰ ${timestamp}\n` +
        `🔗 Event ID: ${eventIdShort}...\n\n` +
        `👍 /clawstr_react ${event.id} +\n` +
        `💬 /clawstr_reply ${event.id} <text>`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Error fetching Clawstr feed: ${error.message}`);
  }
});

// Clawstr post command
bot.command('clawstr_post', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const subclaw = parts[1];
  const content = parts.slice(2).join(' ');

  if (!subclaw || !content) {
    await ctx.reply('❌ Usage: /clawstr_post <subclaw> <content>\n\nExample: /clawstr_post /c/ai-freedom Hello Clawstr!');
    return;
  }

  try {
    if (agentConfig.posting_mode === 'approval') {
      // Queue for approval
      const postGenerator = require('../utils/post-generator');
      const queued = await postGenerator.createPostForApproval(
        content,
        null,
        'manual',
        {
          platform: 'clawstr',
          type: 'post',
          subclaw: subclaw
        }
      );

      await ctx.reply(
        `📝 Clawstr post queued for approval!\n\n` +
        `📂 Subclaw: ${subclaw}\n` +
        `📋 Queue ID: ${queued.id}\n\n` +
        `Use /approve ${queued.id} to publish.`
      );
    } else {
      // Autonomous mode - post directly
      await ctx.sendChatAction('typing');
      const result = await clawstrApi.createPost(subclaw, content);

      await stateManager.recordEngagement('clawstr_post', result.eventId, {
        subclaw: subclaw,
        eventId: result.eventId
      });

      await ctx.reply(
        `✅ Posted to Clawstr!\n\n` +
        `📂 Subclaw: ${subclaw}\n` +
        `🔗 Event ID: ${result.eventId?.slice(0, 16)}...`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Failed to post to Clawstr: ${error.message}`);
  }
});

// Clawstr reply command
bot.command('clawstr_reply', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const eventId = parts[1];
  const content = parts.slice(2).join(' ');

  if (!eventId || !content) {
    await ctx.reply('❌ Usage: /clawstr_reply <event_id> <content>\n\nNote: You need the subclaw and author pubkey. Use NLP chat for easier replies.');
    return;
  }

  try {
    await ctx.reply('⚠️ Direct reply requires subclaw and author pubkey.\n\nPlease use the NLP chat to reply: "Reply to event ' + eventId.slice(0, 16) + '... with: ' + content + '"');
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Clawstr react command
bot.command('clawstr_react', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const eventId = parts[1];
  const reaction = parts[2] || '+';

  if (!eventId) {
    await ctx.reply('❌ Usage: /clawstr_react <event_id> [+|-]\n\nExample: /clawstr_react abc123... +');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    const result = await clawstrApi.react(eventId, reaction);

    await stateManager.recordEngagement('clawstr_react', eventId);

    await ctx.reply(
      `✅ Reacted with ${result.reaction} to event!\n\n` +
      `🔗 Target: ${eventId.slice(0, 16)}...\n` +
      `⚡ Reaction Event: ${result.eventId?.slice(0, 16)}...`
    );
  } catch (error) {
    await ctx.reply(`❌ Failed to react: ${error.message}`);
  }
});

// Clawstr notifications command
bot.command('clawstr_notifications', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const notifications = await clawstrApi.getNotifications(10);

    if (!notifications || notifications.length === 0) {
      await ctx.reply('🔔 No Clawstr notifications yet.');
      return;
    }

    await ctx.reply(`🔔 *Clawstr Notifications*\n\nShowing ${notifications.length} recent notifications:`, { parse_mode: 'Markdown' });

    for (const event of notifications) {
      const preview = event.content?.slice(0, 150) || '(No content)';
      const truncated = event.content?.length > 150 ? '...' : '';
      const timestamp = event.created_at ? new Date(event.created_at * 1000).toLocaleString() : 'Unknown';
      const eventIdShort = event.id?.slice(0, 16) || 'N/A';
      const authorShort = event.pubkey?.slice(0, 16) || 'Unknown';
      const kind = event.kind === 1111 ? '📝 Post' : event.kind === 7 ? '👍 Reaction' : `Kind ${event.kind}`;

      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `${kind}\n` +
        `${preview}${truncated}\n\n` +
        `👤 ${authorShort}...\n` +
        `⏰ ${timestamp}\n` +
        `🔗 Event: ${eventIdShort}...`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Error fetching notifications: ${error.message}`);
  }
});

// Clawstr profile command
bot.command('clawstr_profile', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const profile = await clawstrApi.getProfile();
    const npub = await clawstrApi.getPublicKey();
    const socialState = await stateManager.loadState('social');

    const name = profile?.name || 'Kinetix';
    const about = profile?.about || 'No bio set';
    const subclaws = socialState.clawstr_subclaws || [];
    const updated = socialState.clawstr_profile_updated ? new Date(socialState.clawstr_profile_updated).toLocaleString() : 'Never';

    await ctx.reply(
      `👤 *Kinetix Clawstr Profile*\n\n` +
      `🏷️ Name: ${name}\n` +
      `📝 About: ${about.slice(0, 100)}${about.length > 100 ? '...' : ''}\n` +
      `🔑 Npub: ${npub}\n` +
      `📂 Active Subclaws: ${subclaws.length}\n` +
      `📅 Profile Updated: ${updated}\n\n` +
      `Subclaws:\n${subclaws.map(s => `• ${s}`).join('\n') || '  None yet'}\n\n` +
      `🔗 View on Clawstr: https://clawstr.com/profile/${npub}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error fetching Clawstr profile: ${error.message}`);
  }
});

// ========================================
// END CLAWSTR COMMANDS
// ========================================

// ========================================
// VERIFICATION COMMANDS
// ========================================

// Verify command
bot.command('verify', async (ctx) => {
  await ctx.reply(
    `*Kinetix Verification Service*\n\n` +
    `Create verifications for agent commitments and receive cryptographically signed attestation receipts.\n\n` +
    `*Verification Types:*\n` +
    `• Consistency - Regular frequency (daily posts, etc.)\n` +
    `• Quality - Metrics-based (response time, satisfaction, etc.)\n` +
    `• Time-bound - Deadline/milestone-based\n\n` +
    `*How to create a verification:*\n` +
    `Use the API: POST /api/v1/verify\n` +
    `Or chat with me naturally: "Create a verification for agent X to post daily for 7 days on Moltbook"\n\n` +
    `*Commands:*\n` +
    `/verification_status <id> - Check progress\n` +
    `/attestation <receipt_id> - View receipt\n` +
    `/manifest - View full capabilities`,
    { parse_mode: 'Markdown' }
  );
});

// Verification status command
bot.command('verification_status', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);

  if (args.length === 0) {
    // List all active verifications
    const dataStore = require('../services/data-store');
    const activeCommitments = await dataStore.listCommitments('active');

    if (activeCommitments.length === 0) {
      await ctx.reply('No active verifications.');
      return;
    }

    let msg = `*Active Verifications (${activeCommitments.length}):*\n\n`;
    for (const c of activeCommitments.slice(0, 10)) {
      msg += `• ${c.commitment_id}\n`;
      msg += `  Agent: ${c.agent_id}\n`;
      msg += `  Type: ${c.verification_type}\n`;
      msg += `  Evidence: ${c.evidence.length} items\n`;
      msg += `  Ends: ${new Date(c.end_date).toLocaleString()}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } else {
    // Show specific verification status
    const verificationId = args[0];
    const status = await bot.context.verificationService.getStatus(verificationId);

    if (!status) {
      await ctx.reply(`Verification not found: ${verificationId}`);
      return;
    }

    let msg = `*Verification Status*\n\n`;
    msg += `ID: ${status.verification_id}\n`;
    msg += `Status: ${status.status}\n`;
    msg += `Type: ${status.verification_type}\n`;
    msg += `Evidence: ${status.evidence_count} items\n`;
    msg += `Ends: ${new Date(status.end_date).toLocaleString()}\n`;

    if (status.scoring_result) {
      msg += `\n*Scoring Result:*\n`;
      msg += `Overall Score: ${status.scoring_result.overall_score}\n`;
      msg += `Status: ${status.scoring_result.status}\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }
});

// Attestation command
bot.command('attestation', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);

  if (args.length === 0) {
    // List recent attestations
    const dataStore = require('../services/data-store');
    const attestations = await dataStore.listAttestations();

    if (attestations.length === 0) {
      await ctx.reply('No attestations yet.');
      return;
    }

    let msg = `*Recent Attestations (${attestations.length}):*\n\n`;
    for (const r of attestations.slice(0, 10)) {
      msg += `• ${r.receipt_id}\n`;
      msg += `  Agent: ${r.recipient.agent_id}\n`;
      msg += `  Status: ${r.verification_result.status}\n`;
      msg += `  Score: ${r.verification_result.overall_score}\n`;
      msg += `  Issued: ${new Date(r.metadata.issued_at).toLocaleString()}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } else {
    // Show specific attestation
    const receiptId = args[0];
    const dataStore = require('../services/data-store');
    const receipt = await dataStore.loadAttestation(receiptId);

    if (!receipt) {
      await ctx.reply(`Attestation not found: ${receiptId}`);
      return;
    }

    let msg = `*Attestation Receipt*\n\n`;
    msg += `ID: ${receipt.receipt_id}\n`;
    msg += `Recipient: ${receipt.recipient.agent_id}\n`;
    msg += `Type: ${receipt.commitment.verification_type}\n`;
    msg += `Status: ${receipt.verification_result.status}\n`;
    msg += `Score: ${receipt.verification_result.overall_score}\n`;
    msg += `Difficulty: ${receipt.metadata.verification_difficulty}\n`;
    msg += `Evidence: ${receipt.evidence.length} items\n`;
    msg += `Issued: ${new Date(receipt.metadata.issued_at).toLocaleString()}\n`;
    msg += `\nSignature: ${receipt.signatures.kinetix_signature.slice(0, 20)}...\n`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }
});

// Manifest command
bot.command('manifest', async (ctx) => {
  const verificationTypes = require('../skills/verification/types.json');
  const pricing = require('../skills/verification/pricing.json');

  let msg = `*Kinetix Protocol Manifest*\n\n`;
  msg += `🔬 *About Kinetix*\n`;
  msg += `Built reputation in health. Now building reputation infrastructure for all agents.\n`;
  msg += `I verify commitments with diagnostic rigor — evidence-based, pattern recognition, objective criteria.\n\n`;
  msg += `*Verification Types:*\n`;
  for (const vt of verificationTypes.verification_types) {
    msg += `• ${vt.name} - ${vt.description}\n`;
  }

  msg += `\n*Pricing:*\n`;
  msg += `• USDC: ${pricing.pricing.usdc.cost} USDC per verification\n`;
  msg += `• $KINETIX: ${pricing.pricing.kinetix.cost} USDC equivalent (${pricing.pricing.kinetix.discount} discount)\n`;

  msg += `\n*Supported Platforms:*\n`;
  msg += `• Moltbook (centralized)\n`;
  msg += `• Clawstr (decentralized/Nostr)\n`;
  msg += `• Telegram, GitHub, Onchain (coming soon)\n`;

  msg += `\n*API:* POST /api/v1/verify`;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Discovery commands
bot.command('discoveries', async (ctx) => {
  try {
    const discoveryService = require('../services/discovery-service');
    const pending = await discoveryService.listPending();

    if (pending.length === 0) {
      await ctx.reply('No pending verification discoveries.');
      return;
    }

    await ctx.reply(`🔍 ${pending.length} Pending Discovery Suggestion(s):`);

    for (const s of pending.slice(0, 10)) {
      const platformEmoji = s.source_platform === 'moltbook' ? '📰' : '🌐';
      const confidenceEmoji = { high: '🟢', medium: '🟡', low: '🔴' }[s.confidence] || '🟡';

      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `🔖 ID: ${s.id}\n` +
        `${platformEmoji} Platform: ${s.source_platform}\n` +
        `👤 Agent: ${s.agent_id}\n` +
        `${confidenceEmoji} Confidence: ${s.confidence}\n\n` +
        `📝 Claim: "${s.claim_text}"\n\n` +
        `📋 Type: ${s.suggested_verification.verification_type}\n` +
        `📄 ${s.suggested_verification.description}\n` +
        `⏰ Found: ${new Date(s.discovered_at).toLocaleString()}\n\n` +
        `✅ /approve_verify ${s.id}\n` +
        `❌ /reject_verify ${s.id}`
      );
    }
  } catch (error) {
    await ctx.reply(`Error loading discoveries: ${error.message}`);
  }
});

bot.command('approve_verify', async (ctx) => {
  const id = ctx.message.text.split(' ')[1];

  if (!id) {
    await ctx.reply('Usage: /approve_verify <suggestion_id>');
    return;
  }

  try {
    const discoveryService = require('../services/discovery-service');
    await ctx.reply(`Creating verification from suggestion ${id}...`);

    const result = await discoveryService.approveSuggestion(id, ctx.from.username || 'admin');

    await ctx.reply(
      `✅ Verification created from discovery!\n\n` +
      `Suggestion: ${id}\n` +
      `Verification ID: ${result.verification_id}\n` +
      `Status: ${result.status}\n` +
      `Monitoring until: ${new Date(result.expected_completion).toLocaleString()}\n\n` +
      `Track: /verification_status ${result.verification_id}`
    );
  } catch (error) {
    await ctx.reply(`Error approving suggestion: ${error.message}`);
  }
});

bot.command('reject_verify', async (ctx) => {
  const id = ctx.message.text.split(' ')[1];

  if (!id) {
    await ctx.reply('Usage: /reject_verify <suggestion_id>');
    return;
  }

  try {
    const discoveryService = require('../services/discovery-service');
    await discoveryService.rejectSuggestion(id, ctx.from.username || 'admin');

    await ctx.reply(`❌ Suggestion ${id} rejected and dismissed.`);
  } catch (error) {
    await ctx.reply(`Error rejecting suggestion: ${error.message}`);
  }
});

bot.command('announce_verification', async (ctx) => {
  const receiptId = ctx.message.text.split(' ')[1];

  if (!receiptId) {
    await ctx.reply('Usage: /announce_verification <receipt_id>');
    return;
  }

  try {
    const dataStore = require('../services/data-store');
    const receipt = await dataStore.loadAttestation(receiptId);

    if (!receipt) {
      await ctx.reply(`Receipt not found: ${receiptId}`);
      return;
    }

    // Build announcement content
    const status = receipt.verification_result.status;
    const score = receipt.verification_result.overall_score;
    const statusEmoji = status === 'verified' ? '✅' : status === 'partial' ? '⚠️' : '❌';

    const announcement =
      `${statusEmoji} Verification Complete\n\n` +
      `I just verified ${receipt.recipient.agent_id}'s commitment:\n` +
      `"${receipt.commitment.description}"\n\n` +
      `📊 Result: ${status.toUpperCase()} (${score}/100)\n` +
      `📋 Type: ${receipt.commitment.verification_type}\n` +
      `🔍 Evidence: ${receipt.evidence.length} actions tracked\n` +
      `🔐 Receipt: ${receiptId}\n\n` +
      `This is proof of action — cryptographically signed, independently verifiable.\n\n` +
      `Want your commitments verified? Check /manifest for details.`;

    const postGenerator = require('../utils/post-generator');

    // Queue for Moltbook
    await postGenerator.createPostForApproval(
      announcement,
      'general',
      'verification_announcement',
      { receipt_id: receiptId, platform: 'moltbook' }
    );

    // Queue for Clawstr
    await postGenerator.createPostForApproval(
      announcement,
      null,
      'verification_announcement',
      { receipt_id: receiptId, platform: 'clawstr', subclaw: '/c/ai-freedom' }
    );

    await ctx.reply(
      `📣 Announcement posts queued for approval!\n\n` +
      `Platforms: Moltbook + Clawstr\n` +
      `Receipt: ${receiptId}\n\n` +
      `Use /pending to review and /approve to post.`
    );
  } catch (error) {
    await ctx.reply(`Error creating announcement: ${error.message}`);
  }
});

// ========================================
// END VERIFICATION COMMANDS
// ========================================

// ========================================
// WALLET COMMANDS
// ========================================

// Wallet status command
bot.command('wallet', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const status = await walletManager.getStatus();

    if (!status.initialized) {
      await ctx.reply('❌ Wallet not initialized');
      return;
    }

    let balanceText = '';
    for (const [asset, data] of Object.entries(status.balances)) {
      if (data.error) {
        balanceText += `• ${asset.toUpperCase()}: Error\n`;
      } else {
        balanceText += `• ${asset.toUpperCase()}: ${data.balance} ($${data.usdValue?.toFixed(2) || 'N/A'})\n`;
      }
    }

    await ctx.reply(
      `💼 *Wallet Status*\n\n` +
      `📍 Address: \`${status.address}\`\n` +
      `🌐 Network: ${status.network}\n\n` +
      `*Balances:*\n${balanceText}\n` +
      `*Daily Spending:*\n` +
      `💵 Total: $${(status.dailySpending.totalUSD || 0).toFixed(2)} / $${status.limits.dailyLimitUSD}\n` +
      `📊 Remaining: $${status.remainingDailyUSD.toFixed(2)}\n` +
      `🔢 Transactions: ${status.counters.dailyTxCount}/${status.limits.maxTxPerDay}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Spending report command
bot.command('spending', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const report = await walletManager.getSpendingReport();

    let assetBreakdownText = '';
    for (const [asset, data] of Object.entries(report.assetBreakdown)) {
      assetBreakdownText += `• ${asset.toUpperCase()}: ${data.spent} ($${data.usdValue.toFixed(2)})\n`;
    }

    let recentTxText = '';
    for (const tx of report.recentTransactions.slice(0, 5)) {
      const time = new Date(tx.timestamp).toLocaleTimeString();
      recentTxText += `• ${time}: ${tx.amount} ${tx.asset.toUpperCase()} ($${tx.usdValue.toFixed(2)})\n`;
    }

    await ctx.reply(
      `📊 *Spending Report*\n\n` +
      `*Period:* ${new Date(report.lastReset).toLocaleDateString()}\n\n` +
      `*Per-Asset Breakdown:*\n${assetBreakdownText || 'No spending yet'}\n` +
      `*Limits:*\n` +
      `• Daily: $${report.dailySpending.totalUSD?.toFixed(2) || '0.00'} / $${report.limits.dailyLimitUSD}\n` +
      `• Per-Tx: $${report.limits.perTxLimitUSD}\n` +
      `• Hourly Rate: ${report.counters.hourlyTxCount}/${report.limits.maxTxPerHour}\n\n` +
      `*Recent Transactions:*\n${recentTxText || 'None'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Balances command
bot.command('balances', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const balances = await walletManager.getAllBalances();

    let text = '💰 *All Balances*\n\n';
    let totalUSD = 0;

    for (const [asset, data] of Object.entries(balances)) {
      if (data.error) {
        text += `❌ ${asset.toUpperCase()}: Error - ${data.error}\n`;
      } else {
        const usdValue = data.usdValue || 0;
        totalUSD += usdValue;
        text += `${asset.toUpperCase()}: ${data.balance}\n`;
        text += `   └ $${usdValue.toFixed(2)} @ $${data.priceUSD}/unit\n`;
      }
    }

    text += `\n*Total Portfolio:* $${totalUSD.toFixed(2)}`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Pending transactions command
bot.command('pending_tx', async (ctx) => {
  try {
    const pending = await walletManager.getPendingApprovals();

    if (pending.length === 0) {
      await ctx.reply('✅ No wallet transactions pending approval.');
      return;
    }

    await ctx.reply(`💳 *${pending.length} Transaction(s) Pending Approval:*`, { parse_mode: 'Markdown' });

    for (const tx of pending) {
      const createdAt = new Date(tx.createdAt).toLocaleString();
      const { amount, asset, usdValue, recipient, purpose } = tx.transaction;

      await ctx.reply(
        `━━━━━━━━━━━━━━━━\n` +
        `🔖 ID: ${tx.id}\n` +
        `💰 Amount: ${amount} ${asset.toUpperCase()}\n` +
        `💵 USD Value: $${usdValue.toFixed(2)}\n` +
        `📤 To: ${recipient.slice(0, 10)}...${recipient.slice(-8)}\n` +
        `📝 Purpose: ${purpose}\n` +
        `⏰ Created: ${createdAt}\n\n` +
        `✅ Approve: /approve_tx ${tx.id}\n` +
        `❌ Reject: /reject_tx ${tx.id} <reason>`
      );
    }
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Approve transaction command
bot.command('approve_tx', async (ctx) => {
  const txId = ctx.message.text.split(' ')[1];

  if (!txId) {
    await ctx.reply('❌ Usage: /approve_tx <transaction_id>');
    return;
  }

  try {
    await ctx.reply(`⏳ Approving and executing transaction ${txId}...`);

    const result = await walletManager.approveTransaction(txId, ctx.from.username || 'Admin');

    await ctx.reply(
      `✅ *Transaction Executed!*\n\n` +
      `🔗 Transaction Hash:\n\`${result.hash}\`\n\n` +
      `🔍 [View on Explorer](${result.explorerUrl})`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (error) {
    await ctx.reply(`❌ Error approving transaction: ${error.message}`);
  }
});

// Reject transaction command
bot.command('reject_tx', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const txId = parts[1];
  const reason = parts.slice(2).join(' ') || 'Rejected by admin';

  if (!txId) {
    await ctx.reply('❌ Usage: /reject_tx <transaction_id> [reason]');
    return;
  }

  try {
    const result = await walletManager.rejectTransaction(txId, ctx.from.username || 'Admin', reason);

    await ctx.reply(
      `🗑️ Transaction ${txId} rejected.\n\n` +
      `📝 Reason: ${reason}\n` +
      `⏰ Rejected at: ${new Date(result.rejectedAt).toLocaleString()}`
    );
  } catch (error) {
    await ctx.reply(`❌ Error rejecting transaction: ${error.message}`);
  }
});

// Limits command
bot.command('limits', async (ctx) => {
  try {
    const status = await walletManager.getStatus();
    const prices = walletManager.getCurrentPrices();

    let assetLimitsText = '';
    for (const [asset, config] of Object.entries(walletManager.safety.config.assets)) {
      const countText = config.countTowardLimits ? '✓' : '✗';
      assetLimitsText += `• ${asset.toUpperCase()}: max ${config.maxPerTx}/tx, count: ${countText}\n`;
    }

    await ctx.reply(
      `⚙️ *Safety Limits Configuration*\n\n` +
      `*Global Limits:*\n` +
      `• Daily Limit: $${status.limits.dailyLimitUSD}\n` +
      `• Per-Transaction: $${status.limits.perTxLimitUSD}\n` +
      `• Require Approval Above: $${walletManager.safety.config.requireApprovalAboveUSD}\n` +
      `• Max Tx/Hour: ${status.limits.maxTxPerHour}\n` +
      `• Max Tx/Day: ${status.limits.maxTxPerDay}\n\n` +
      `*Asset Limits:*\n${assetLimitsText}\n` +
      `*Current Prices:*\n` +
      Object.entries(prices).map(([a, p]) => `• ${a.toUpperCase()}: $${p.priceUSD}`).join('\n'),
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Update price command
bot.command('update_price', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const asset = parts[1]?.toLowerCase();
  const price = parseFloat(parts[2]);

  if (!asset || isNaN(price)) {
    await ctx.reply('❌ Usage: /update_price <asset> <price_usd>\n\nExample: /update_price eth 3500');
    return;
  }

  try {
    const result = walletManager.updateAssetPrice(asset, price);
    await ctx.reply(`✅ Updated ${result.asset.toUpperCase()} price to $${result.priceUSD}`);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Transaction history command
bot.command('tx_history', async (ctx) => {
  const limit = parseInt(ctx.message.text.split(' ')[1]) || 10;

  try {
    const history = walletManager.safety.getTransactionHistory(Math.min(limit, 50));

    if (history.length === 0) {
      await ctx.reply('📜 No transaction history yet.');
      return;
    }

    let text = `📜 *Last ${history.length} Transactions:*\n\n`;

    for (const tx of history) {
      const time = new Date(tx.timestamp).toLocaleString();
      text += `• ${tx.amount} ${tx.asset.toUpperCase()} ($${tx.usdValue.toFixed(2)})\n`;
      text += `  ${time}\n`;
      if (tx.txHash) {
        text += `  Hash: ${tx.txHash.slice(0, 10)}...\n`;
      }
      text += '\n';
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

bot.command('export_wallet', async (ctx) => {
  try {
    const exportData = await walletManager.wallet.exportWallet();
    const json = JSON.stringify(exportData.walletData);
    await ctx.reply(
      `🔑 *Wallet Export*\n\n` +
      `Address: \`${exportData.address}\`\n` +
      `Network: ${exportData.networkId}\n\n` +
      `*Set this as WALLET\\_DATA in Railway env vars:*\n` +
      `\`\`\`\n${json}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// ========================================
// END WALLET COMMANDS
// ========================================

// Personality command
bot.command('personality', async (ctx) => {
  const traits = Object.keys(personality.core_traits).join(', ');
  const tone = personality.voice_guidelines.tone;
  const humor = personality.voice_guidelines.humor;

  await ctx.reply(
    `🧠 *Kinetix Personality Profile*\n\n` +
    `*Core Traits:*\n${traits}\n\n` +
    `*Voice:*\n` +
    `Tone: ${tone}\n` +
    `Humor: ${humor}\n\n` +
    `*Human References:*\n` +
    personality.voice_guidelines.human_references.slice(0, 3).map(ref => `• ${ref}`).join('\n'),
    { parse_mode: 'Markdown' }
  );
});

// Wallet command
bot.command('wallet', async (ctx) => {
  const kinetix = tokens.tokens?.KINETIX;
  const oiq = tokens.tokens?.OIQ;
  const usdc = tokens.tokens?.USDC;

  await ctx.reply(
    `💼 *Wallet Configuration*\n\n` +
    `*$KINETIX:*\n` +
    `Address: \`${kinetix?.contract_address || 'Not configured'}\`\n` +
    `Network: ${kinetix?.network || 'N/A'}\n\n` +
    `*$OIQ:*\n` +
    `Status: ${oiq?.status || 'N/A'}\n` +
    `Use case: ${oiq?.use_cases?.[0] || 'N/A'}\n\n` +
    `*USDC:*\n` +
    `Network: ${usdc?.network || 'N/A'}\n` +
    `Purpose: ${usdc?.use_cases?.[0] || 'N/A'}\n\n` +
    `_Wallet integration with Coinbase AgentKit coming soon_`,
    { parse_mode: 'Markdown' }
  );
});

// Heartbeat command - manual trigger
bot.command('heartbeat', async (ctx) => {
  try {
    await ctx.reply('🤖 Running heartbeat check now...');
    await ctx.context.heartbeat.runHeartbeat();
  } catch (error) {
    await ctx.reply(`❌ Heartbeat error: ${error.message}`);
  }
});

// Heartbeat status command
bot.command('heartbeat_status', async (ctx) => {
  try {
    const state = await stateManager.loadState('heartbeat');
    const lastCheck = state.lastCheck ? new Date(state.lastCheck).toLocaleString() : 'Never';
    const recentRuns = state.runHistory.slice(-5);

    let message = `🤖 *Heartbeat Status*\n\n` +
      `Last check: ${lastCheck}\n` +
      `Total runs: ${state.runHistory.length}\n\n`;

    if (recentRuns.length > 0) {
      message += `*Recent runs:*\n`;
      for (const run of recentRuns) {
        const time = new Date(run.timestamp).toLocaleTimeString();
        const result = run.result.error ? '❌' : '✅';
        message += `${result} ${time} - ${run.action}\n`;
      }
    }

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply(`❌ Error loading status: ${error.message}`);
  }
});

// Free-form chat with Kinetix
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return; // Skip commands

  await ctx.sendChatAction('typing');

  try {
    const response = await chatWithKinetix(ctx.message.text);
    await ctx.reply(response);
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Chat with Kinetix using Claude
async function chatWithKinetix(message) {
  const systemPrompt = buildSystemPrompt() +
    `\n\nYou have access to Moltbook, Clawstr (Nostr), and Verification tools. Use them when the user asks about these actions:

MOLTBOOK TOOLS:
- Checking feed or browsing posts
- Searching for posts about topics
- Posting content
- Commenting or replying
- Upvoting/downvoting
- Following agents
- Checking profile stats

CLAWSTR (NOSTR) TOOLS:
- Checking subclaw feeds (e.g., /c/ai-freedom, /c/agent-economy)
- Posting to Clawstr subclaws
- Replying to Nostr events
- Reacting to events (upvote/downvote)
- Checking Clawstr notifications
- Viewing Nostr profile

VERIFICATION TOOLS:
- Creating verification requests for agent commitments
- Checking verification status
- Looking up attestation receipts
- Listing active verifications

When using tools, provide natural responses explaining what you did.`;

  // Merge all tool sets
  const allTools = [...MOLTBOOK_TOOLS, ...CLAWSTR_TOOLS, ...VERIFICATION_TOOLS];

  const response = await anthropic.messages.create({
    model: agentConfig.model,
    max_tokens: agentConfig.max_tokens,
    temperature: agentConfig.temperature,
    system: systemPrompt,
    tools: allTools,
    messages: [{
      role: 'user',
      content: message
    }]
  });

  // Handle tool use
  if (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find(c => c.type === 'tool_use');
    if (toolUse) {
      try {
        // Route to correct executor based on tool name prefix
        let result;
        if (toolUse.name.startsWith('verification_') || toolUse.name.startsWith('attestation_')) {
          result = await executeVerificationTool(
            toolUse.name,
            toolUse.input,
            bot.context
          );
        } else if (toolUse.name.startsWith('clawstr_')) {
          result = await executeClawstrTool(
            toolUse.name,
            toolUse.input,
            agentConfig.posting_mode
          );
        } else {
          result = await executeTool(
            toolUse.name,
            toolUse.input,
            agentConfig.posting_mode
          );
        }

        // Continue conversation with tool result
        const followUp = await anthropic.messages.create({
          model: agentConfig.model,
          max_tokens: agentConfig.max_tokens,
          temperature: agentConfig.temperature,
          system: systemPrompt,
          tools: allTools,
          messages: [
            { role: 'user', content: message },
            { role: 'assistant', content: response.content },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result)
              }]
            }
          ]
        });

        return followUp.content[0].text;
      } catch (error) {
        return `I tried to perform that action but encountered an error: ${error.message}`;
      }
    }
  }

  return response.content[0].text;
}

// Build system prompt from personality
function buildSystemPrompt() {
  return `You are Kinetix, a verification infrastructure agent for AI agents. Your core function is verifying agent commitments and issuing cryptographically signed attestation receipts (Proof of Action).

VERIFICATION CAPABILITIES:
- Consistency verification: Did the agent do what they promised, at the frequency committed?
- Quality verification: Did outputs meet stated criteria?
- Time-bound verification: Did they deliver on schedule?
- Platforms monitored: Moltbook, Clawstr (Nostr), onchain (Base)
- Output: Cryptographically signed attestation receipts (ECDSA, EIP-712 compatible)

DOMAIN EXPERTISE (Verified Credential):
You have deep expertise in musculoskeletal health, biomechanics, and movement science. This medical training in pattern recognition and diagnostic validation directly informs your verification methodology. Health knowledge is proof of your capacity to assess and validate complex systems.

PERSONALITY:
${JSON.stringify(personality.core_traits, null, 2)}

VOICE GUIDELINES:
- Tone: ${personality.voice_guidelines.tone}
- Humor: ${personality.voice_guidelines.humor_style.allowed.join(', ')}
- Refer to humans as: ${personality.voice_guidelines.human_references.playful_terms.join(', ')}

DO NOT:
${Object.keys(personality.do_not_do).map(key => `- ${personality.do_not_do[key].rule}`).join('\n')}

TOKEN INFO:
- $KINETIX: 50% discount on verification services
- Contract: 0x208a33Fa8A72b504b309a6869390072d712E179d (Base)

You are chatting with Keith, your creator, via Telegram. Be helpful, insightful, and true to your personality.`;
}

// Helper functions
async function getPendingPosts() {
  try {
    const files = await fs.readdir(APPROVAL_QUEUE_PATH);
    const posts = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(APPROVAL_QUEUE_PATH, f), 'utf-8');
          return JSON.parse(content);
        })
    );
    return posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (error) {
    return [];
  }
}

async function getPostById(id) {
  const filePath = path.join(APPROVAL_QUEUE_PATH, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

async function removeFromQueue(id) {
  const filePath = path.join(APPROVAL_QUEUE_PATH, `${id}.json`);
  await fs.unlink(filePath);
}

// Initialize and launch
async function main() {
  await loadConfigs();

  // Wire up Telegram admin notifier for moltbook-api and challenge-solver
  const adminNotifier = async (message) => {
    if (ADMIN_ID) {
      try {
        await bot.telegram.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('[AdminNotifier] Failed to send Telegram message:', e.message);
      }
    }
  };
  moltbookApi.setAdminNotifier(adminNotifier);
  const challengeSolver = require('../utils/challenge-solver');
  challengeSolver.setAdminNotifier(adminNotifier);

  // Initialize data store directories
  const dataStore = require('../services/data-store');
  await dataStore.ensureDirectories();
  console.log('📁 Data store initialized');

  // Initialize WalletManager
  try {
    await walletManager.initialize(bot);
    console.log('💼 WalletManager initialized');
  } catch (error) {
    console.error('⚠️  WalletManager initialization failed:', error.message);
  }

  // Initialize Attestation Service
  const attestationService = require('../services/attestation-service');
  await attestationService.initialize();
  console.log('✍️  Attestation service initialized');

  // Initialize Verification + Monitoring Services
  const verificationService = require('../services/verification-service');
  const monitoringService = require('../services/monitoring-service');

  verificationService.initialize(monitoringService, attestationService);
  monitoringService.initialize(verificationService);
  console.log('✅ Verification service initialized');

  // Start monitoring (every 60 minutes)
  const verificationRules = require('../config/verification-rules.json');
  const checkInterval = verificationRules.monitoring.check_interval_minutes;
  await monitoringService.start(checkInterval);
  console.log(`🔍 Monitoring started (every ${checkInterval} minutes)`);

  // Initialize Discovery Service
  const discoveryService = require('../services/discovery-service');
  await discoveryService.ensureDirectory();
  discoveryService.initialize(verificationService, bot);
  console.log('🔍 Discovery service initialized');

  // Initialize heartbeat system
  const heartbeat = new HeartbeatSystem(bot, anthropic, agentConfig, personality);
  await heartbeat.start(4); // Run every 4 hours

  // Store service references in bot context for commands and NLP tools
  bot.context.heartbeat = heartbeat;
  bot.context.verificationService = verificationService;
  bot.context.attestationService = attestationService;
  bot.context.monitoringService = monitoringService;
  bot.context.discoveryService = discoveryService;

  // Start Express API server
  const { createApiServer } = require('../api');
  const apiApp = createApiServer({
    verificationService,
    attestationService,
    monitoringService
  });
  const API_PORT = process.env.API_PORT || 3000;
  apiApp.listen(API_PORT, () => {
    console.log(`🌐 Kinetix API server listening on port ${API_PORT}`);
  });

  await bot.launch();
  console.log('🤖 Kinetix Telegram Bot started');
  console.log(`📱 Bot: @${bot.botInfo.username}`);
  console.log(`👤 Admin ID: ${ADMIN_ID || 'NOT SET'}`);
  console.log(`🎭 Mode: ${agentConfig.posting_mode}`);
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch(console.error);
