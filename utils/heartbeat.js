const schedule = require('node-schedule');
const axios = require('axios');
const moltbookApi = require('./moltbook-api');
const clawstrApi = require('./clawstr-api');
const stateManager = require('./state-manager');

const HEARTBEAT_URL = 'https://www.moltbook.com/heartbeat.md';

class HeartbeatSystem {
  constructor(bot, anthropic, config, personality) {
    this.bot = bot;
    this.anthropic = anthropic;
    this.config = config;
    this.personality = personality;
    this.job = null;
    this.adminId = process.env.TELEGRAM_ADMIN_ID;
  }

  /**
   * Start the heartbeat scheduler
   * @param {number} intervalHours - Hours between heartbeat checks
   */
  async start(intervalHours = 4) {
    // Schedule: run every N hours
    const cronRule = `0 */${intervalHours} * * *`;

    this.job = schedule.scheduleJob(cronRule, async () => {
      await this.runHeartbeat();
    });

    console.log(`[Heartbeat] Scheduled: every ${intervalHours} hours`);

    // Also run immediately on start
    setTimeout(() => this.runHeartbeat(), 5000); // Run after 5 seconds
  }

  /**
   * Stop the heartbeat scheduler
   */
  stop() {
    if (this.job) {
      this.job.cancel();
      this.job = null;
      console.log('[Heartbeat] Stopped');
    }
  }

  /**
   * Run a heartbeat check (dual-platform: Moltbook + Clawstr)
   */
  async runHeartbeat() {
    console.log('[Heartbeat] Starting dual-platform heartbeat check...');

    try {
      // 1. Moltbook's own heartbeat.md ranks responding to replies on your
      // own posts above everything else, ahead of upvoting/commenting on the
      // feed. There was previously no code path that ever called /home, so
      // Kinetix never saw or answered replies — do that first.
      const replyResult = await this.respondToMoltbookReplies();

      // 2. Fetch heartbeat.md from Moltbook (context only)
      const heartbeatContent = await this.fetchHeartbeat();

      // 3. Fetch feeds from both platforms in parallel
      const [moltbookFeed, clawstrFeed] = await Promise.all([
        moltbookApi.getFeed('new', 10),
        this.fetchClawstrFeed()
      ]);

      // 4. Use Claude to decide on engagement for BOTH platforms in one call
      const engagementPlan = await this.planDualPlatformEngagement(
        heartbeatContent,
        moltbookFeed,
        clawstrFeed
      );

      // 5. Execute engagements on both platforms
      await Promise.all([
        this.executeMoltbookEngagement(engagementPlan.moltbook || []),
        this.executeClawstrEngagement(engagementPlan.clawstr || [])
      ]);

      // 5.5. Process discoveries (verifiable claims and explicit requests)
      let discoveryCount = 0;
      let autoApprovedCount = 0;
      if (engagementPlan.discoveries && engagementPlan.discoveries.length > 0) {
        const discoveryService = require('../services/discovery-service');
        for (const discovery of engagementPlan.discoveries) {
          try {
            let result;
            if (discovery.source_type === 'explicit_request') {
              result = await discoveryService.addVerificationRequest(discovery);
            } else {
              result = await discoveryService.addSuggestion(discovery);
            }
            if (!result) continue;
            discoveryCount++;

            // Auto-approve: explicit requests always; high-confidence passive discoveries
            const shouldAutoApprove =
              discovery.source_type === 'explicit_request' ||
              (discovery.source_type !== 'explicit_request' && discovery.confidence === 'high');

            if (shouldAutoApprove) {
              try {
                const approvalResult = await discoveryService.approveSuggestion(
                  result.id,
                  'kinetix_autonomous'
                );
                autoApprovedCount++;
                const reason = discovery.source_type === 'explicit_request'
                  ? 'explicit_request'
                  : 'high-confidence passive';
                const notifText = `🤖 Auto-approved verification: ${discovery.agent_id}\n` +
                  `Type: ${discovery.suggested_verification?.verification_type || 'unknown'}\n` +
                  `Reason: ${reason}\n` +
                  `Verification ID: ${approvalResult?.verification_id || 'N/A'}`;
                if (this.bot && this.adminId) {
                  await this.bot.telegram.sendMessage(this.adminId, notifText).catch(() => {});
                }
              } catch (approveError) {
                console.error('[Heartbeat] Auto-approve error:', approveError.message);
              }
            }
          } catch (error) {
            console.error('[Heartbeat] Discovery error:', error.message);
          }
        }
        console.log(`[Heartbeat] Processed ${discoveryCount} new discoveries/requests (${autoApprovedCount} auto-approved)`);
      }

      // 6. Update state
      await stateManager.updateHeartbeat('dual_platform_check', {
        moltbookPosts: moltbookFeed.length,
        clawstrPosts: clawstrFeed.length,
        moltbookEngagements: engagementPlan.moltbook?.length || 0,
        clawstrEngagements: engagementPlan.clawstr?.length || 0,
        moltbookReplies: replyResult.repliedCount,
        discoveries: discoveryCount
      });

      // 7. Notify admin
      await this.notifyAdmin('✅ Dual-platform heartbeat complete', {
        moltbookPosts: moltbookFeed.length,
        clawstrPosts: clawstrFeed.length,
        moltbookEngagements: engagementPlan.moltbook?.length || 0,
        clawstrEngagements: engagementPlan.clawstr?.length || 0,
        moltbookReplies: replyResult.repliedCount,
        discoveries: discoveryCount
      });

      console.log('[Heartbeat] Dual-platform check complete');

    } catch (error) {
      console.error('[Heartbeat] Error:', error);
      await stateManager.updateHeartbeat('error', { error: error.message });
      await this.notifyAdmin('❌ Heartbeat failed', { error: error.message });
    }
  }

  /**
   * Fetch heartbeat.md from Moltbook
   * @returns {Promise<string|null>} Heartbeat content or null
   */
  async fetchHeartbeat() {
    try {
      const response = await axios.get(HEARTBEAT_URL, { timeout: 10000 });
      console.log('[Heartbeat] Fetched heartbeat.md');
      return response.data;
    } catch (error) {
      console.log('[Heartbeat] Could not fetch heartbeat.md:', error.message);
      return null;
    }
  }

  /**
   * Respond to replies on Kinetix's own Moltbook posts/comments — the
   * highest-priority action per Moltbook's heartbeat.md, and something the
   * bot never did before (no code path called /home). Bounded to the 5 most
   * recent threads with activity per run so a backlog can't dominate a cycle.
   * @returns {Promise<{repliedCount: number}>}
   */
  async respondToMoltbookReplies() {
    let repliedCount = 0;
    try {
      const home = await moltbookApi.getHome();
      const activity = home?.activity_on_your_posts || [];
      if (activity.length === 0) return { repliedCount };

      console.log(`[Heartbeat] Moltbook: ${activity.length} post(s) with new activity`);

      for (const item of activity.slice(0, 5)) {
        try {
          const engagementKey = `${item.post_id}:${item.latest_at}`;
          const alreadyReplied = await stateManager.hasEngaged('reply', engagementKey);
          if (alreadyReplied) continue;

          const comments = await moltbookApi.getComments(item.post_id, 'new', 10);
          const newComments = (comments || [])
            .filter(c => (c.author?.name || '').toLowerCase() !== 'kinetix')
            .slice(-3);

          if (newComments.length === 0) {
            await moltbookApi.markNotificationsRead(item.post_id);
            continue;
          }

          const replyText = await this.draftReply(item, newComments);
          if (!replyText) continue;

          const postingMode = this.config.posting_mode;
          if (postingMode === 'autonomous') {
            const canProceed = await this.ensureCommentSlot();
            if (!canProceed) {
              console.log(`[Heartbeat] Moltbook: Skipping reply on ${item.post_id}, comment floor unavailable`);
              continue;
            }
            const targetCommentId = newComments[newComments.length - 1].id;
            await moltbookApi.addComment(item.post_id, replyText, targetCommentId);
            await stateManager.recordEngagement('reply', engagementKey);
            repliedCount++;
            console.log(`[Heartbeat] Moltbook: Replied on own post ${item.post_id}`);
          } else {
            await this.queueCommentForApproval({ postId: item.post_id, comment: replyText, action: 'reply' });
            await stateManager.recordEngagement('reply', engagementKey);
            console.log(`[Heartbeat] Moltbook: Queued reply on ${item.post_id} for approval`);
          }

          await moltbookApi.markNotificationsRead(item.post_id);
        } catch (error) {
          console.error(`[Heartbeat] Reply error for post ${item.post_id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('[Heartbeat] Error fetching /home:', error.message);
    }
    return { repliedCount };
  }

  /**
   * Draft a reply to new comments on one of Kinetix's own posts, grounded in
   * the actual comment content rather than a template.
   * @param {Object} item - An activity_on_your_posts entry from GET /home
   * @param {Array} comments - Recent comments on that post
   * @returns {Promise<string|null>}
   */
  async draftReply(item, comments) {
    try {
      const commentsText = comments
        .map(c => `- ${c.author?.name || 'unknown'}: ${(c.content || '').slice(0, 300)}`)
        .join('\n');

      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: 300,
        system: 'You are Kinetix, verification infrastructure for AI agents. Someone replied on your Moltbook post. Write a brief, substantive reply (2-4 sentences) that continues the conversation genuinely. Do not restate your own bio. Return only the reply text, nothing else.',
        messages: [{
          role: 'user',
          content: `Your post: "${item.post_title}"\n\nNew replies:\n${commentsText}\n\nWrite your reply.`
        }]
      });
      const text = response.content[0].text.trim();
      return text || null;
    } catch (error) {
      console.error('[Heartbeat] draftReply error:', error.message);
      return null;
    }
  }

  /**
   * Wait out Moltbook's 20s-between-comments floor if needed, so multiple
   * comments in one heartbeat cycle don't trip the platform's own rate
   * limiter. Returns false (skip, don't wait) if the daily cap is the
   * blocker rather than the short floor — that's hours away, not seconds.
   * @returns {Promise<boolean>}
   */
  async ensureCommentSlot() {
    const check = await stateManager.checkMoltbookCommentAllowed();
    if (check.allowed) return true;
    if (check.reason === 'daily_max') return false;
    await new Promise(resolve => setTimeout(resolve, check.waitMs + 250));
    return true;
  }

  /**
   * Fetch Clawstr feed from primary subclaw
   * @returns {Promise<Array>} Feed events
   */
  async fetchClawstrFeed() {
    try {
      const socialState = await stateManager.loadState('social');
      const primarySubclaw = this.config.clawstr?.primary_subclaw || '/c/ai-freedom';

      console.log(`[Heartbeat] Fetching Clawstr feed from ${primarySubclaw}...`);
      const feed = await clawstrApi.getFeed(primarySubclaw, 10);
      console.log(`[Heartbeat] Fetched ${feed.length} Clawstr posts`);

      return feed;
    } catch (error) {
      console.error('[Heartbeat] Error fetching Clawstr feed:', error.message);
      return [];
    }
  }

  /**
   * Use Claude to analyze posts and plan engagement (DUAL PLATFORM)
   * @param {string} heartbeatContent - Heartbeat.md content
   * @param {Array} moltbookFeed - Posts from Moltbook
   * @param {Array} clawstrFeed - Events from Clawstr
   * @returns {Promise<Object>} Engagement plan with moltbook and clawstr arrays
   */
  async planDualPlatformEngagement(heartbeatContent, moltbookFeed, clawstrFeed) {
    const systemPrompt = `You are Kinetix's dual-platform engagement planner. Analyze posts from both Moltbook and Clawstr (Nostr) and decide which ones Kinetix should engage with.

Kinetix's identity: Verification infrastructure for agents. Musculoskeletal health is a secondary, rarely-invoked credential ("I diagnose reputation the way I diagnose patients") — not a service Kinetix actively offers.

Kinetix's personality traits: ${Object.keys(this.personality.core_traits).join(', ')}
Focus areas: agent coordination, reputation systems, verification, AI agent autonomy

Engagement priorities:
1. Agent coordination, reputation systems, verification discussions (HIGH)
2. Community building in agent-focused submolts, e.g. /aiagents (HIGH)
3. A health/movement angle only when it genuinely illustrates the diagnostic-rigor point (RARE)

Voice: "I verify commitments the way I diagnose patients — evidence-based, objective, rigorous."

BALANCE YOUR ENGAGEMENT across both platforms. Don't favor one heavily over the other.

For MOLTBOOK posts:
- action: "upvote" or "comment"
- comment: text to post (if commenting)

For CLAWSTR events:
- action: "react" (safe, immediate) or "reply" (queued for approval)
- reaction: "+" or "-" (for react)
- content: reply text (for reply)
- subclaw: the subclaw where the event was posted
- eventId: the event ID
- authorPubkey: the pubkey of the event author

Additionally, scan ALL posts for VERIFIABLE CLAIMS and VERIFICATION REQUESTS:

A) PASSIVE DISCOVERIES — agents making verifiable claims:
- Regular activity ("I'll post daily", "weekly updates every Monday")
- Time-bound deliverables ("shipping X by Friday", "launching by [date]")
- Service commitments ("I'll respond within 1 hour")
Mark these with source_type: "passive_discovery"

B) EXPLICIT VERIFICATION REQUESTS — agents explicitly asking Kinetix to verify:
- "@Kinetix verify me: [commitment]"
- "I want Kinetix to verify that I [commitment]"
- "Can you verify my commitment to [commitment]"
- "@Kinetix can you verify [commitment]"
Mark these with source_type: "explicit_request" and confidence: "high"

For each claim or request found, add to a "discoveries" array:
{
  "source_platform": "moltbook|clawstr",
  "source_type": "passive_discovery|explicit_request",
  "source_post_id": "...",
  "source_event_id": "...",
  "agent_id": "author name or pubkey",
  "agent_pubkey": "...",
  "claim_text": "exact verifiable claim",
  "original_content_snippet": "first 300 chars",
  "confidence": "high|medium|low",
  "normalized_claim": "lowercase short summary for dedup",
  "suggested_verification": {
    "verification_type": "consistency|quality|time_bound",
    "description": "human-readable description",
    "criteria": { "platform": "...", "frequency": "...", "duration_days": N, "minimum_actions": N, "action_type": "post" }
  }
}

Only include medium/high confidence. Limit to 3 max.

Return JSON:
{
  "moltbook": [{ "postId": "...", "action": "upvote|comment", "comment": "..." }],
  "clawstr": [{ "eventId": "...", "action": "react|reply", "reaction": "+", "content": "...", "subclaw": "...", "authorPubkey": "..." }],
  "discoveries": [{ ... }]
}

Limit to 2-3 engagements per platform. Prioritize quality over quantity.`;

    const userMessage = `MOLTBOOK POSTS:\n${JSON.stringify(moltbookFeed.slice(0, 5).map(p => ({
      id: p.id,
      title: p.title,
      content: p.content?.slice(0, 300),
      author: p.author,
      submolt: p.submolt
    })), null, 2)}

CLAWSTR EVENTS:\n${JSON.stringify(clawstrFeed.slice(0, 5).map(e => ({
      id: e.id,
      content: e.content?.slice(0, 300),
      pubkey: e.pubkey,
      created_at: e.created_at,
      subclaw: e.tags?.find(t => t[0] === 'I')?.[1] || 'unknown'
    })), null, 2)}

${heartbeatContent ? `\nHeartbeat context:\n${heartbeatContent.slice(0, 500)}` : ''}`;

    try {
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { moltbook: [], clawstr: [], discoveries: [] };
    } catch (error) {
      console.error('[Heartbeat] Claude planning error:', error.message);
      return { moltbook: [], clawstr: [] };
    }
  }

  /**
   * Execute Moltbook engagement plan
   * @param {Array} engagements - Moltbook engagements from Claude
   */
  async executeMoltbookEngagement(engagements) {
    const postingMode = this.config.posting_mode;

    for (const engagement of engagements) {
      try {
        // Check if already engaged
        const alreadyEngaged = await stateManager.hasEngaged(
          engagement.action,
          engagement.postId
        );
        if (alreadyEngaged) {
          console.log(`[Heartbeat] Already engaged with ${engagement.postId}, skipping`);
          continue;
        }

        if (engagement.action === 'upvote') {
          // Upvotes are always safe to do automatically
          await moltbookApi.upvote(engagement.postId);
          await stateManager.recordEngagement('upvote', engagement.postId);
          console.log(`[Heartbeat] Moltbook: Upvoted ${engagement.postId}`);

        } else if (engagement.action === 'comment') {
          if (postingMode === 'autonomous') {
            // Auto-comment — wait out the 20s floor if a previous comment
            // in this same cycle (or respondToMoltbookReplies above) just
            // used it, rather than tripping Moltbook's own rate limiter.
            const canProceed = await this.ensureCommentSlot();
            if (!canProceed) {
              console.log(`[Heartbeat] Moltbook: Skipping comment on ${engagement.postId}, daily comment cap reached`);
              continue;
            }
            await moltbookApi.addComment(engagement.postId, engagement.comment);
            await stateManager.recordEngagement('comment', engagement.postId);
            console.log(`[Heartbeat] Moltbook: Commented on ${engagement.postId}`);
          } else {
            // Queue for approval
            await this.queueCommentForApproval(engagement);
            console.log(`[Heartbeat] Moltbook: Queued comment on ${engagement.postId} for approval`);
          }
        }
      } catch (error) {
        console.error(`[Heartbeat] Moltbook engagement error for ${engagement.postId}:`, error.message);
      }
    }
  }

  /**
   * Execute Clawstr engagement plan
   * @param {Array} engagements - Clawstr engagements from Claude
   */
  async executeClawstrEngagement(engagements) {
    const postingMode = this.config.posting_mode;

    for (const engagement of engagements) {
      try {
        // Check if already engaged
        const alreadyEngaged = await stateManager.hasEngaged(
          `clawstr_${engagement.action}`,
          engagement.eventId
        );
        if (alreadyEngaged) {
          console.log(`[Heartbeat] Already engaged with Clawstr event ${engagement.eventId.slice(0, 16)}..., skipping`);
          continue;
        }

        if (engagement.action === 'react') {
          // Reactions are safe - execute immediately
          const reaction = engagement.reaction || '+';
          await clawstrApi.react(engagement.eventId, reaction);
          await stateManager.recordEngagement('clawstr_react', engagement.eventId);
          console.log(`[Heartbeat] Clawstr: Reacted ${reaction} to ${engagement.eventId.slice(0, 16)}...`);

        } else if (engagement.action === 'reply') {
          if (postingMode === 'autonomous') {
            // Auto-reply
            await clawstrApi.createReply(
              engagement.eventId,
              engagement.content,
              engagement.subclaw,
              engagement.authorPubkey
            );
            await stateManager.recordEngagement('clawstr_reply', engagement.eventId, {
              subclaw: engagement.subclaw,
              parentEventId: engagement.eventId
            });
            console.log(`[Heartbeat] Clawstr: Replied to ${engagement.eventId.slice(0, 16)}...`);
          } else {
            // Queue for approval
            await this.queueClawstrReplyForApproval(engagement);
            console.log(`[Heartbeat] Clawstr: Queued reply to ${engagement.eventId.slice(0, 16)}... for approval`);
          }
        }
      } catch (error) {
        console.error(`[Heartbeat] Clawstr engagement error for ${engagement.eventId?.slice(0, 16)}:`, error.message);
      }
    }
  }

  /**
   * Queue a comment for approval (Moltbook)
   * @param {Object} engagement - Engagement object
   */
  async queueCommentForApproval(engagement) {
    const postGenerator = require('./post-generator');
    await postGenerator.createPostForApproval(
      engagement.comment,
      null,
      'heartbeat_engagement',
      {
        type: 'comment',
        postId: engagement.postId,
        action: engagement.action
      }
    );
  }

  /**
   * Queue a Clawstr reply for approval
   * @param {Object} engagement - Clawstr engagement object
   */
  async queueClawstrReplyForApproval(engagement) {
    const postGenerator = require('./post-generator');
    await postGenerator.createPostForApproval(
      engagement.content,
      null,
      'heartbeat_clawstr',
      {
        platform: 'clawstr',
        type: 'reply',
        parentEventId: engagement.eventId,
        subclaw: engagement.subclaw,
        parentPubkey: engagement.authorPubkey
      }
    );
  }

  /**
   * Notify admin via Telegram
   * @param {string} message - Message to send
   * @param {Object} details - Details object
   */
  async notifyAdmin(message, details) {
    if (this.bot && this.adminId) {
      try {
        let text;

        // Dual-platform notification format
        if (details.moltbookPosts !== undefined && details.clawstrPosts !== undefined) {
          text = `🤖 ${message}\n\n` +
            `📰 Moltbook:\n` +
            `  Posts: ${details.moltbookPosts || 0}\n` +
            `  Engagements: ${details.moltbookEngagements || 0}\n\n` +
            `🌐 Clawstr:\n` +
            `  Events: ${details.clawstrPosts || 0}\n` +
            `  Engagements: ${details.clawstrEngagements || 0}\n` +
            (details.discoveries ? `\n🔍 Discoveries: ${details.discoveries}` : '') +
            `\n\nTime: ${new Date().toLocaleString()}` +
            (details.error ? `\n\nError: ${details.error}` : '');
        } else {
          // Legacy single-platform format
          text = `🤖 ${message}\n\n` +
            `Posts checked: ${details.posts || 'N/A'}\n` +
            `Engagements: ${details.engagements || 0}\n` +
            `Time: ${new Date().toLocaleString()}` +
            (details.error ? `\n\nError: ${details.error}` : '');
        }

        await this.bot.telegram.sendMessage(this.adminId, text);
      } catch (error) {
        console.error('[Heartbeat] Failed to notify admin:', error.message);
      }
    }
  }
}

module.exports = HeartbeatSystem;
