const axios = require('axios');
const stateManager = require('./state-manager');

const API_BASE = 'https://www.moltbook.com/api/v1';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000
});

// Inject API key dynamically on each request
client.interceptors.request.use(config => {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    throw new Error('MOLTBOOK_API_KEY not found in environment variables. Check your .env file.');
  }
  config.headers.Authorization = `Bearer ${apiKey}`;
  return config;
});

// Suspension/challenge admin notifier (set externally by telegram-bot)
let _moltbookAdminNotifier = null;
function setAdminNotifier(fn) {
  _moltbookAdminNotifier = fn;
}
async function _notifyAdmin(msg) {
  if (_moltbookAdminNotifier) {
    try { await _moltbookAdminNotifier(msg); } catch (e) { /* silent */ }
  }
}

// Compact, length-capped one-line summary of a response body — avoid flooding
// logs with pretty-printed JSON on repeated/high-frequency error responses.
function _summarize(data, maxLen = 300) {
  let str;
  try {
    str = JSON.stringify(data);
  } catch (e) {
    str = String(data);
  }
  if (!str) return '(empty)';
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

// Suppress repeated identical suspension notices — Moltbook can return the
// same "suspended" error on every call in a polling loop.
let _lastSuspensionNotifiedAt = 0;
const SUSPENSION_NOTIFY_INTERVAL_MS = 60 * 60 * 1000;

// Response interceptor for success responses that embed a challenge.
//
// Confirmed live (Jul 2026, re-confirmed via raw response logging Aug 2026):
// POST /posts and POST /posts/{id}/comments return 2xx with the created
// resource fields at the top level AND a sibling `verification` object:
// { id, ..., verification: { verification_code, challenge_text, expires_at,
// instructions } } — flat, not wrapped in a `post`/`comment` envelope (that
// wrapper only showed up on GET /posts/{id}, a separate endpoint). The
// `data?.post?.verification`/`data?.comment?.verification` fallbacks below
// are kept defensively in case a different endpoint ever wraps its create
// response the way GET does, but the confirmed, common case is flat.
client.interceptors.response.use(
  response => {
    const { data } = response;
    const nested = data?.verification || data?.post?.verification || data?.comment?.verification;
    const isEmbeddedChallenge =
      data && (data.challenge || data.challenge_text || data.verification_required || nested?.challenge_text);
    if (isEmbeddedChallenge) {
      console.error('[Moltbook API] ⚠️ Challenge embedded in 2xx response:', _summarize(data));
      const err = new Error(`Challenge required: ${data.challenge || data.challenge_text || nested?.challenge_text || 'verification_required'}`);
      err.isChallenge = true;
      // Keep the FULL original resource (id, title, content, ...), not just
      // the nested verification block — the caller needs the real id to
      // return once the challenge is solved, since POST /verify's own
      // response only echoes back a content_id, not the full resource.
      // Unwrap the `post`/`comment` envelope if present so callers always
      // get a flat resource with `.id`/`.verification` directly on it.
      err.challengeData = data?.post || data?.comment || data;
      throw err;
    }
    return response;
  },
  error => {
    if (error.response) {
      const { status, data } = error.response;

      // Transparently retry once on 429, honoring the server's Retry-After.
      // Capped so a slow/misbehaving retry-after can't hang a caller.
      if (status === 429 && !error.config.__moltbookRetried) {
        const retryAfterSec = Number(error.response.headers['retry-after'] || data?.retry_after_seconds || data?.retry_after || 5);
        const waitMs = Math.min(Number.isFinite(retryAfterSec) ? retryAfterSec : 5, 60) * 1000;
        error.config.__moltbookRetried = true;
        console.warn(`[Moltbook API] 429 rate limited, retrying in ${waitMs}ms`);
        return new Promise(resolve => setTimeout(resolve, waitMs)).then(() => client(error.config));
      }

      console.error(`[Moltbook API] Error Response: status=${status} data=${_summarize(data)}`);

      // Detect AI verification challenges
      if (status === 401 || status === 403) {
        if (data.challenge || data.verification_required || data.ai_challenge) {
          console.error('[Moltbook API] ⚠️ AI VERIFICATION CHALLENGE DETECTED');
        }
      }

      // Check for suspension messages and notify admin (rate-limited)
      if (data.error && data.error.includes('suspended')) {
        const now = Date.now();
        if (now - _lastSuspensionNotifiedAt > SUSPENSION_NOTIFY_INTERVAL_MS) {
          _lastSuspensionNotifiedAt = now;
          console.error('[Moltbook API] ⚠️ ACCOUNT SUSPENDED:', data.error);
          _notifyAdmin(`🚫 *Moltbook Account Suspended*\n\nReason: ${data.error}`);
        }
      }
    } else if (error.request) {
      console.error('[Moltbook API] No response received');
    }
    return Promise.reject(error);
  }
);

/**
 * Handle rate limit errors and provide helpful messages
 */
function handleError(error) {
  if (error.response) {
    const { status, data } = error.response;

    // Rate limiting
    if (status === 429) {
      const retryAfter = error.response.headers['retry-after'] || data.retry_after;
      const message = retryAfter
        ? `Rate limited. Retry after ${retryAfter} seconds.`
        : 'Rate limited. Please wait before trying again.';
      const err = new Error(message);
      err.retryAfter = retryAfter;
      err.response = error.response;
      throw err;
    }

    // AI verification challenge
    if ((status === 401 || status === 403) && (data.challenge || data.verification_required)) {
      const message = `AI verification challenge: ${data.challenge || data.message || 'Unknown challenge'}`;
      const err = new Error(message);
      err.isChallenge = true;
      err.challengeData = data;
      err.response = error.response;
      throw err;
    }

    // Account suspended
    if (data.error && data.error.includes('suspended')) {
      const message = `Account suspended: ${data.error}`;
      const err = new Error(message);
      err.isSuspended = true;
      err.response = error.response;
      throw err;
    }

    // Generic error
    const message = data.error || data.message || `API error: ${status}`;
    const err = new Error(message);
    err.response = error.response;
    throw err;
  }
  throw error;
}

// ===== Posts =====

/**
 * Create a new post in a submolt. Enforces Moltbook's documented 1-post/30min
 * floor locally (persisted, survives restarts) so a caller never trips the
 * platform's own rate limiter into a suspension.
 * @param {string} submolt - Submolt name (without 'm/' prefix)
 * @param {string} title - Post title
 * @param {string} content - Post content/body
 * @returns {Promise<Object>} Created post object
 */
async function createPost(submolt, title, content) {
  const rateCheck = await stateManager.checkMoltbookPostAllowed();
  if (!rateCheck.allowed) {
    const err = new Error(`Moltbook post floor not yet elapsed — wait ${Math.ceil(rateCheck.waitMs / 1000)}s`);
    err.isLocalRateLimit = true;
    err.waitMs = rateCheck.waitMs;
    throw err;
  }

  try {
    const response = await client.post('/posts', { submolt_name: submolt, title, content });
    await stateManager.recordMoltbookPost();
    const post = response.data.post || response.data;
    console.log(`[Moltbook API] Post created: ${post.id} in m/${submolt}`);
    return post;
  } catch (error) {
    if (error.isChallenge) {
      // The POST above already created the post server-side (it returned a
      // 2xx that embedded the challenge) — it just sits at
      // verification_status: "pending" until the challenge is answered.
      // Re-issuing the request here would create a duplicate post, so we
      // only solve the challenge and return whatever resource the platform
      // gave us, never re-POST the content.
      console.log('[Moltbook API] Challenge received on createPost - auto-solving...');
      const { solveChallengeAndSubmit } = require('./challenge-solver');
      // error.challengeData is the full original post (id/title/content/...)
      // with a `.verification` block — /verify's own response only echoes back
      // a content_id, not the full resource, so this is the reliable source
      // for the id callers need.
      const post = error.challengeData;
      let verified = true;
      try {
        await solveChallengeAndSubmit(post);
      } catch (challengeError) {
        // The post exists server-side either way; it just stays at
        // verification_status: "pending". Rethrowing here would leave the
        // caller's own bookkeeping unrun, so the next heartbeat would post a
        // duplicate. Record it, surface it, and return the resource.
        verified = false;
        console.error(`[Moltbook API] Post ${post.id} is live but UNVERIFIED:`, challengeError.message);
      }
      await stateManager.recordMoltbookPost();
      console.log(`[Moltbook API] Post ${post.id} live (verified: ${verified})`);
      return post;
    }
    handleError(error);
  }
}

/**
 * Get a post by ID
 * @param {string} postId - Post ID
 * @returns {Promise<Object>} Post object
 */
async function getPost(postId) {
  try {
    const response = await client.get(`/posts/${postId}`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Delete a post
 * @param {string} postId - Post ID
 * @returns {Promise<Object>} Deletion confirmation
 */
async function deletePost(postId) {
  try {
    const response = await client.delete(`/posts/${postId}`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

// ===== Comments =====

/**
 * Get comments on a post.
 * @param {string} postId
 * @param {string} sort - 'new' | 'best' | 'old'
 * @param {number} limit
 * @returns {Promise<Array>} Comments
 */
async function getComments(postId, sort = 'new', limit = 20) {
  try {
    const response = await client.get(`/posts/${postId}/comments`, { params: { sort, limit } });
    const data = response.data;
    return Array.isArray(data) ? data : (data.comments || []);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Add a comment to a post. Enforces Moltbook's documented 1-comment/20s and
 * 50-comments/day floors locally (persisted, survives restarts).
 * @param {string} postId - Post ID
 * @param {string} content - Comment content
 * @param {string|null} parentId - Parent comment ID for replies
 * @returns {Promise<Object>} Created comment object
 */
async function addComment(postId, content, parentId = null) {
  const rateCheck = await stateManager.checkMoltbookCommentAllowed();
  if (!rateCheck.allowed) {
    const err = new Error(`Moltbook comment floor not yet elapsed (${rateCheck.reason}) — wait ${Math.ceil(rateCheck.waitMs / 1000)}s`);
    err.isLocalRateLimit = true;
    err.waitMs = rateCheck.waitMs;
    throw err;
  }

  try {
    const payload = { content };
    if (parentId) {
      payload.parent_id = parentId;
    }
    const response = await client.post(`/posts/${postId}/comments`, payload);
    await stateManager.recordMoltbookComment();
    const comment = response.data.comment || response.data;
    console.log(`[Moltbook API] Comment created: ${comment.id} on post ${postId}`);
    return comment;
  } catch (error) {
    if (error.isChallenge) {
      // Same reasoning as createPost: the comment already exists server-side
      // pending the challenge answer, so don't re-POST it.
      console.log('[Moltbook API] Challenge received on addComment - auto-solving...');
      const { solveChallengeAndSubmit } = require('./challenge-solver');
      const comment = error.challengeData;
      let verified = true;
      try {
        await solveChallengeAndSubmit(comment);
      } catch (challengeError) {
        // Same reasoning as createPost: the comment is already live (just
        // unverified), so record it rather than throwing — otherwise
        // heartbeat's recordEngagement never runs and the next cycle leaves a
        // duplicate comment on the same post.
        verified = false;
        console.error(`[Moltbook API] Comment ${comment.id} is live but UNVERIFIED:`, challengeError.message);
      }
      await stateManager.recordMoltbookComment();
      console.log(`[Moltbook API] Comment ${comment.id} live on post ${postId} (verified: ${verified})`);
      return comment;
    }
    handleError(error);
  }
}

// ===== Voting =====

/**
 * Upvote a post
 * @param {string} postId - Post ID
 * @returns {Promise<Object>} Vote confirmation
 */
async function upvote(postId) {
  try {
    const response = await client.post(`/posts/${postId}/upvote`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Downvote a post
 * @param {string} postId - Post ID
 * @returns {Promise<Object>} Vote confirmation
 */
async function downvote(postId) {
  try {
    const response = await client.post(`/posts/${postId}/downvote`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Upvote a comment
 * @param {string} commentId - Comment ID
 * @returns {Promise<Object>} Vote confirmation
 */
async function upvoteComment(commentId) {
  try {
    const response = await client.post(`/comments/${commentId}/upvote`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

// ===== Submolts =====

/**
 * Create a new submolt
 * @param {string} name - Submolt name (slug)
 * @param {string} displayName - Display name
 * @param {string} description - Submolt description
 * @returns {Promise<Object>} Created submolt object
 */
async function createSubmolt(name, displayName, description) {
  try {
    const response = await client.post('/submolts', {
      name,
      display_name: displayName,
      description
    });
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * List available submolts
 * @returns {Promise<Array>} List of submolts
 */
async function listSubmolts() {
  try {
    const response = await client.get('/submolts');
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Subscribe to a submolt
 * @param {string} submoltName - Submolt name
 * @returns {Promise<Object>} Subscription confirmation
 */
async function subscribe(submoltName) {
  try {
    const response = await client.post(`/submolts/${submoltName}/subscribe`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Unsubscribe from a submolt
 * @param {string} submoltName - Submolt name
 * @returns {Promise<Object>} Unsubscription confirmation
 */
async function unsubscribe(submoltName) {
  try {
    const response = await client.post(`/submolts/${submoltName}/unsubscribe`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

// ===== Feed & Search =====

/**
 * Get the main feed
 * @param {string} sort - Sort order: 'hot', 'new', 'top'
 * @param {number} limit - Number of posts to return
 * @returns {Promise<Array>} List of posts
 */
async function getFeed(sort = 'hot', limit = 25) {
  try {
    const response = await client.get('/feed', {
      params: { sort, limit }
    });
    // Normalize: handle both formats (array or object with posts property)
    const data = response.data;
    return Array.isArray(data) ? data : (data.posts || []);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Get feed for a specific submolt
 * @param {string} submoltName - Submolt name
 * @param {string} sort - Sort order: 'hot', 'new', 'top'
 * @returns {Promise<Array>} List of posts
 */
async function getSubmoltFeed(submoltName, sort = 'new') {
  try {
    const response = await client.get(`/submolts/${submoltName}/posts`, {
      params: { sort }
    });
    // Normalize: handle both formats (array or object with posts property)
    const data = response.data;
    return Array.isArray(data) ? data : (data.posts || []);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Semantic search across Moltbook
 * @param {string} query - Search query
 * @param {string} type - Search type: 'all', 'posts', 'comments', 'agents'
 * @param {number} limit - Number of results
 * @returns {Promise<Object>} Search results
 */
async function search(query, type = 'all', limit = 20) {
  try {
    const response = await client.get('/search', {
      params: { q: query, type, limit }
    });
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

// ===== Profile & Following =====

/**
 * Get the authenticated agent's profile
 * @returns {Promise<Object>} Profile object
 */
async function getProfile() {
  try {
    // Correct endpoint is /agents/me, not /me
    const response = await client.get('/agents/me');
    // API returns { agent: {...} }, extract the agent object
    return response.data.agent || response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Update the authenticated agent's own profile (e.g. description/bio).
 * Confirmed live via a Phase-0 probe: PATCH /agents/me exists (returns 400
 * "No valid fields to update" on an empty body, not 404).
 * @param {Object} fields - e.g. { description: '...' }
 * @returns {Promise<Object>} Updated agent object
 */
async function updateProfile(fields) {
  try {
    const response = await client.patch('/agents/me', fields);
    return response.data.agent || response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Set up owner email for account management
 * @param {string} email - Owner's email address
 * @returns {Promise<Object>} Setup confirmation
 */
async function setupOwnerEmail(email) {
  try {
    const response = await client.post('/agents/me/setup-owner-email', {
      email
    });
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Follow another agent
 * @param {string} name - Agent name
 * @returns {Promise<Object>} Follow confirmation
 */
async function followAgent(name) {
  try {
    const response = await client.post(`/agents/${name}/follow`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * Unfollow an agent
 * @param {string} name - Agent name
 * @returns {Promise<Object>} Unfollow confirmation
 */
async function unfollowAgent(name) {
  try {
    const response = await client.post(`/agents/${name}/unfollow`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

// ===== Home & Notifications =====

/**
 * GET /home — the dashboard endpoint Moltbook's own heartbeat.md calls
 * first: account status, activity on your posts, DMs, announcements,
 * followed agents' posts. There was previously no code path that ever
 * called this, so Kinetix never surfaced replies to its own posts/comments.
 * @returns {Promise<Object>} Home dashboard object
 */
async function getHome() {
  try {
    const response = await client.get('/home');
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

/**
 * List notifications (comment replies, mentions, etc).
 * @param {number} limit
 * @returns {Promise<Array>} Notifications
 */
async function getNotifications(limit = 20) {
  try {
    const response = await client.get('/notifications', { params: { limit } });
    return response.data.notifications || [];
  } catch (error) {
    handleError(error);
  }
}

/**
 * Mark all notifications for a post as read.
 * @param {string} postId
 * @returns {Promise<Object>}
 */
async function markNotificationsRead(postId) {
  try {
    const response = await client.post(`/notifications/read-by-post/${postId}`);
    return response.data;
  } catch (error) {
    handleError(error);
  }
}

module.exports = {
  // Posts
  createPost,
  getPost,
  deletePost,

  // Comments
  getComments,
  addComment,

  // Voting
  upvote,
  downvote,
  upvoteComment,

  // Submolts
  createSubmolt,
  listSubmolts,
  subscribe,
  unsubscribe,

  // Feed & Search
  getFeed,
  getSubmoltFeed,
  search,

  // Profile & Following
  getProfile,
  updateProfile,
  setupOwnerEmail,
  followAgent,
  unfollowAgent,

  // Home & Notifications
  getHome,
  getNotifications,
  markNotificationsRead,

  // Admin notifier registration
  setAdminNotifier
};
