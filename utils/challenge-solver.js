const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Admin notification callback - set by telegram-bot at startup
let _notifyAdmin = null;

/**
 * Register a callback for admin Telegram notifications.
 * @param {Function} fn - async (message: string) => void
 */
function setAdminNotifier(fn) {
  _notifyAdmin = fn;
}

async function notifyAdmin(message) {
  if (_notifyAdmin) {
    try {
      await _notifyAdmin(message);
    } catch (e) {
      console.error('[ChallengeSolver] Admin notify failed:', e.message);
    }
  }
}

/**
 * Confirmed live (Jul 2026): moltbookApi passes through the FULL created
 * resource as challengeData (so callers still have its real id), with the
 * actual challenge nested under `.verification`:
 * { verification_code, challenge_text, expires_at, instructions }.
 * This unwraps that, falling back to a flat shape for robustness in case
 * Moltbook embeds it differently on another endpoint.
 * @param {Object} challengeData
 * @returns {Object} { challengeText, verificationCode, instructions }
 */
function getVerificationBlock(challengeData) {
  const v = challengeData.verification || challengeData;
  return {
    challengeText: v.challenge_text || v.challenge || v.problem || JSON.stringify(challengeData),
    verificationCode: v.verification_code || v.challenge_id || v.id || v.token || null,
    instructions: v.instructions || null
  };
}

/**
 * Use Claude Haiku to decode the obfuscated lobster math problem and return
 * only the numeric answer as a string, formatted per Moltbook's own
 * instructions (confirmed live: two decimal places, e.g. "28.00").
 * @param {Object} challengeData - Raw challenge object from Moltbook response
 * @returns {Promise<string>} Numeric answer string
 */
async function solveChallenge(challengeData) {
  const { challengeText, instructions } = getVerificationBlock(challengeData);

  console.log('[ChallengeSolver] Solving challenge:', challengeText);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content:
          'This is an obfuscated lobster-themed math problem. Decode the garbled text and compute the answer. ' +
          (instructions ? `Formatting instructions: ${instructions} ` : 'Return ONLY the number, nothing else. ') +
          'Problem: ' + challengeText
      }
    ]
  });

  const answer = response.content[0].text.trim();
  console.log('[ChallengeSolver] Answer:', answer);
  return answer;
}

/**
 * Submit the solved answer back to Moltbook via POST /api/v1/verify.
 *
 * Confirmed live (Jul 2026): the correct payload is
 * { verification_code, answer } — verification_code is the field Moltbook's
 * own challenge response actually uses, not challenge_id/id/token as
 * originally guessed. Those guesses are kept as fallbacks only in case a
 * different endpoint ever embeds the challenge in a different shape.
 * @param {Object} challengeData - Raw challenge object from Moltbook response
 * @param {string} answer - Numeric answer string
 * @returns {Promise<Object>} API response data
 */
async function submitChallengeAnswer(challengeData, answer) {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const { verificationCode } = getVerificationBlock(challengeData);
  const submitUrl = challengeData.verification?.submit_url || challengeData.submit_url || 'https://www.moltbook.com/api/v1/verify';

  const payloadAttempts = [];
  if (verificationCode) payloadAttempts.push({ verification_code: verificationCode, answer });
  payloadAttempts.push({ answer }); // challenge may be tied server-side to the authenticated agent

  for (const payload of payloadAttempts) {
    try {
      console.log(`[ChallengeSolver] POST ${submitUrl} with payload keys [${Object.keys(payload).join(',')}]`);
      const res = await axios.post(submitUrl, payload, { headers, timeout: 15000 });
      console.log(`[ChallengeSolver] Verified:`, res.data);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      console.warn(`[ChallengeSolver] Payload keys [${Object.keys(payload).join(',')}] failed (${status}):`, JSON.stringify(data));
    }
  }

  // All attempts failed — log everything and notify admin
  const debugInfo =
    `[ChallengeSolver] ALL submission attempts failed against ${submitUrl}.\n` +
    `challengeData: ${JSON.stringify(challengeData, null, 2)}\n` +
    `answer: ${answer}`;
  console.error(debugInfo);

  const adminMsg =
    `⚠️ *Moltbook Challenge Submission Failed*\n\n` +
    `All payload shapes against ${submitUrl} were rejected. Full challenge data logged.\n\n` +
    `\`\`\`\n${JSON.stringify(challengeData, null, 2).slice(0, 800)}\n\`\`\``;
  await notifyAdmin(adminMsg);

  throw new Error('Challenge submission failed against /api/v1/verify — see logs for full challengeData');
}

/**
 * Convenience: solve + submit in one call.
 * @param {Object} challengeData
 * @returns {Promise<Object>} Submission response
 */
async function solveChallengeAndSubmit(challengeData) {
  // Log and forward full challengeData to admin so we can observe API structure
  console.log('[ChallengeSolver] Full challengeData:', JSON.stringify(challengeData, null, 2));
  await notifyAdmin(
    `🦞 *Moltbook Challenge Received*\n\n` +
    `Attempting auto-solve...\n\n` +
    `\`\`\`\n${JSON.stringify(challengeData, null, 2).slice(0, 800)}\n\`\`\``
  );

  const answer = await solveChallenge(challengeData);
  return submitChallengeAnswer(challengeData, answer);
}

module.exports = { solveChallengeAndSubmit, setAdminNotifier };
