// Event-driven Moltbook posting: composes and publishes a post when a
// verification completes, instead of posting on a fixed schedule. Moltbook's
// own heartbeat.md is explicit that scheduled posting is the wrong model —
// "Do NOT post just because it's been a while" — so this fires from
// services/verification-service.js at the moment a receipt is issued, which
// is the one moment Kinetix has something genuine to say.

const fs = require('fs').promises;
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const moltbookApi = require('./moltbook-api');
const postGenerator = require('./post-generator');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AGENT_CONFIG_PATH = path.join(__dirname, '../config/agent.json');

// The submolt Kinetix's verification-themed posts have actually landed in,
// confirmed live via GET /agents/me/posts during the Jul 2026 audit — not
// /agentkinetics, which config/personality.json still claims as "primary"
// but which Kinetix's real post history never used.
const ANNOUNCE_SUBMOLT = 'aiagents';

/**
 * Re-read agent.json on every call rather than caching it. posting_mode can
 * change at runtime via the Telegram /mode command, which rewrites the file
 * but does not touch this module's state — a cached require() would go
 * stale until the next process restart.
 */
async function loadAgentConfig() {
  try {
    return JSON.parse(await fs.readFile(AGENT_CONFIG_PATH, 'utf-8'));
  } catch (error) {
    // Default to approval (not autonomous) on a config-read failure — a
    // missing/corrupt config should never silently unlock autonomous posting.
    return { model: 'claude-sonnet-4-5-20250929', posting_mode: 'approval' };
  }
}

/**
 * Compose and publish (or queue for approval) a Moltbook post announcing a
 * completed verification. Best-effort: a Moltbook failure must never break
 * receipt issuance, so every error here is caught and logged, never re-thrown.
 *
 * Explicit opt-in required (MOLTBOOK_ANNOUNCE_ENABLED=true). This call sits
 * on the synchronous path of issueAttestation(), which runs inline inside
 * the x402 status-poll request handler — exactly the code path
 * tests/x402-server.test.js exercises with real HTTP requests. A transitive
 * `require('dotenv').config()` deep in that module graph (utils/eas-attestation.js)
 * loads the real .env into the test process, so without this gate a test run
 * would use the real ANTHROPIC_API_KEY and MOLTBOOK_API_KEY and the live
 * posting_mode: "autonomous" to publish a real post to the live Moltbook
 * profile — which is exactly what happened once during development of this
 * feature, on a fabricated test commitment, before this gate existed.
 * @param {Object} receipt - The signed attestation receipt
 * @returns {Promise<Object|null>} The published/queued post, or null if skipped
 */
async function announceVerification(receipt) {
  if (process.env.MOLTBOOK_ANNOUNCE_ENABLED !== 'true') {
    console.log('[MoltbookAnnounce] Skipped — MOLTBOOK_ANNOUNCE_ENABLED is not "true"');
    return null;
  }

  try {
    const agentConfig = await loadAgentConfig();
    const content = await composeAnnouncement(receipt, agentConfig.model);
    if (!content) return null;

    if (agentConfig.posting_mode !== 'autonomous') {
      const queued = await postGenerator.createPostForApproval(content.body, ANNOUNCE_SUBMOLT, 'verification_completed', {
        type: 'post',
        title: content.title,
        receipt_id: receipt.receipt_id
      });
      console.log(`[MoltbookAnnounce] Queued verification announcement for approval: ${queued.id}`);
      return queued;
    }

    const post = await moltbookApi.createPost(ANNOUNCE_SUBMOLT, content.title, content.body);
    console.log(`[MoltbookAnnounce] Published verification announcement: ${post.id}`);
    return post;
  } catch (error) {
    if (error.isLocalRateLimit) {
      console.log(`[MoltbookAnnounce] Skipped — post floor not elapsed (${Math.ceil(error.waitMs / 1000)}s remaining)`);
    } else {
      console.error('[MoltbookAnnounce] Failed to announce verification:', error.message);
    }
    return null;
  }
}

/**
 * Draft the post title/body for a completed verification via Claude, in
 * Kinetix's voice, grounded in the actual receipt fields — not a fixed
 * template repeated on every commitment.
 */
async function composeAnnouncement(receipt, model) {
  try {
    const response = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-5-20250929',
      max_tokens: 400,
      system: 'You are Kinetix, verification infrastructure for AI agents. You just issued a signed attestation receipt for another agent\'s commitment. Write a short, genuine Moltbook post (title + body) about it — specific to this receipt\'s actual agent, commitment, and outcome, not a generic template. No hashtags. If the outcome was a failure or partial score, say so plainly; the whole point of the service is objective verification, not cheerleading. Return only JSON: {"title": "...", "body": "..."}',
      messages: [{
        role: 'user',
        content: `Receipt:\n` +
          `agent_id: ${receipt.recipient.agent_id}\n` +
          `verification_type: ${receipt.commitment.verification_type}\n` +
          `description: ${receipt.commitment.description}\n` +
          `score: ${receipt.verification_result.overall_score}\n` +
          `status: ${receipt.verification_result.status}\n` +
          `receipt_id: ${receipt.receipt_id}`
      }]
    });
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.body) return null;
    return parsed;
  } catch (error) {
    console.error('[MoltbookAnnounce] composeAnnouncement error:', error.message);
    return null;
  }
}

module.exports = { announceVerification };
