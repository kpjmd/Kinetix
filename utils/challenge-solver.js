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
 * Use Claude Haiku to decode the obfuscated lobster math problem and return
 * only the numeric answer as a string.
 * @param {Object} challengeData - Raw challenge object from Moltbook response
 * @returns {Promise<string>} Numeric answer string
 */
async function solveChallenge(challengeData) {
  const challengeText =
    challengeData.challenge ||
    challengeData.challenge_text ||
    challengeData.problem ||
    JSON.stringify(challengeData);

  console.log('[ChallengeSolver] Solving challenge:', challengeText);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content:
          'This is an obfuscated lobster-themed math problem. Decode the garbled text and compute the answer. ' +
          'Return ONLY the number, nothing else. Problem: ' + challengeText
      }
    ]
  });

  const answer = response.content[0].text.trim();
  console.log('[ChallengeSolver] Answer:', answer);
  return answer;
}

/**
 * Submit the solved answer back to Moltbook.
 * Tries multiple endpoint patterns and logs everything on failure.
 * @param {Object} challengeData - Raw challenge object from Moltbook response
 * @param {string} answer - Numeric answer string
 * @returns {Promise<Object>} API response data
 */
async function submitChallengeAnswer(challengeData, answer) {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const baseURL = 'https://www.moltbook.com/api/v1';

  const attempts = [];

  // Attempt 1: use submit_url from challengeData if provided
  if (challengeData.submit_url) {
    attempts.push({
      label: 'submit_url',
      url: challengeData.submit_url,
      payload: { answer }
    });
  }

  // Attempt 2: POST /challenge/verify with challenge_id
  if (challengeData.challenge_id) {
    attempts.push({
      label: '/challenge/verify',
      url: `${baseURL}/challenge/verify`,
      payload: { challenge_id: challengeData.challenge_id, answer }
    });
    attempts.push({
      label: `/challenge/${challengeData.challenge_id}/answer`,
      url: `${baseURL}/challenge/${challengeData.challenge_id}/answer`,
      payload: { answer }
    });
  }

  // Attempt 3: use token field
  if (challengeData.token) {
    attempts.push({
      label: '/challenge/verify (token)',
      url: `${baseURL}/challenge/verify`,
      payload: { token: challengeData.token, answer }
    });
  }

  // Attempt 4: generic fallback
  if (attempts.length === 0) {
    attempts.push({
      label: '/challenge/verify (fallback)',
      url: `${baseURL}/challenge/verify`,
      payload: { answer }
    });
  }

  for (const attempt of attempts) {
    try {
      console.log(`[ChallengeSolver] Trying ${attempt.label} →`, attempt.url);
      const res = await axios.post(attempt.url, attempt.payload, { headers, timeout: 15000 });
      console.log(`[ChallengeSolver] Success via ${attempt.label}:`, res.data);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      console.warn(`[ChallengeSolver] ${attempt.label} failed (${status}):`, JSON.stringify(data));
    }
  }

  // All attempts failed — log everything and notify admin
  const debugInfo =
    `[ChallengeSolver] ALL submission attempts failed.\n` +
    `challengeData: ${JSON.stringify(challengeData, null, 2)}\n` +
    `answer: ${answer}`;
  console.error(debugInfo);

  const adminMsg =
    `⚠️ *Moltbook Challenge Submission Failed*\n\n` +
    `All endpoint attempts exhausted. Full challenge data logged.\n\n` +
    `\`\`\`\n${JSON.stringify(challengeData, null, 2).slice(0, 800)}\n\`\`\``;
  await notifyAdmin(adminMsg);

  throw new Error('Challenge submission failed on all attempted endpoints — see logs for full challengeData');
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
