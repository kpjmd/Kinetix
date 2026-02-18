const axios = require('axios');

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

// Response interceptor for success responses that embed a challenge
client.interceptors.response.use(
  response => {
    const { data } = response;
    if (data && (data.challenge || data.challenge_text || data.verification_required)) {
      console.error('[Moltbook API] ⚠️ Challenge embedded in 2xx response - treating as challenge error');
      console.error('[Moltbook API] Full response data:', JSON.stringify(data, null, 2));
      const err = new Error(`Challenge required: ${data.challenge || data.challenge_text || 'verification_required'}`);
      err.isChallenge = true;
      err.challengeData = data;
      throw err;
    }
    return response;
  },
  error => {
    if (error.response) {
      const { status, data } = error.response;

      console.error('[Moltbook API] Error Response:');
      console.error(`  Status: ${status}`);
      console.error(`  Full Data:`, JSON.stringify(data, null, 2));

      // Detect AI verification challenges — log ALL fields
      if (status === 401 || status === 403) {
        if (data.challenge || data.verification_required || data.ai_challenge) {
          console.error('[Moltbook API] ⚠️ AI VERIFICATION CHALLENGE DETECTED');
          console.error('[Moltbook API] Full challengeData:', JSON.stringify(data, null, 2));
        }
      }

      // Check for suspension messages and notify admin
      if (data.error && data.error.includes('suspended')) {
        console.error('[Moltbook API] ⚠️ ACCOUNT SUSPENDED');
        console.error('[Moltbook API] Reason:', data.error);
        _notifyAdmin(`🚫 *Moltbook Account Suspended*\n\nReason: ${data.error}`);
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

// Submolt ID cache to reduce API calls
const submoltCache = new Map();

/**
 * Get submolt ID by name
 * @param {string} submoltName - Submolt name (e.g., "humanbiology", "agentkinetics")
 * @returns {Promise<string>} Submolt UUID
 */
async function getSubmoltId(submoltName) {
  // Check cache first
  if (submoltCache.has(submoltName)) {
    return submoltCache.get(submoltName);
  }

  try {
    const response = await client.get(`/submolts/${submoltName}`);
    const id = response.data.id || response.data.submolt?.id;

    // Cache the result
    submoltCache.set(submoltName, id);

    return id;
  } catch (error) {
    console.warn(`[Moltbook API] Submolt ${submoltName} not found, using default`);
    const defaultId = '29beb7ee-ca7d-4290-9c2f-09926264866f'; // Default general submolt

    // Cache default too
    submoltCache.set(submoltName, defaultId);

    return defaultId;
  }
}

/**
 * Create a new post in a submolt
 * @param {string} submolt - Submolt name (without 'm/' prefix) or UUID
 * @param {string} title - Post title
 * @param {string} content - Post content/body
 * @returns {Promise<Object>} Created post object
 */
async function createPost(submolt, title, content) {
  try {
    // Check if submolt is already a UUID (36 chars with dashes)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submolt);

    // Get submolt_id if name was provided
    const submolt_id = isUUID ? submolt : await getSubmoltId(submolt);

    const response = await client.post('/posts', {
      submolt_id,  // Fixed: use submolt_id instead of submolt
      title,
      content
    });
    return response.data;
  } catch (error) {
    if (error.isChallenge) {
      console.log('[Moltbook API] Challenge received on createPost - auto-solving...');
      const { solveChallengeAndSubmit } = require('./challenge-solver');
      await solveChallengeAndSubmit(error.challengeData);
      return; // content is live after challenge answer accepted
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
 * Add a comment to a post
 * @param {string} postId - Post ID
 * @param {string} content - Comment content
 * @param {string|null} parentId - Parent comment ID for replies
 * @returns {Promise<Object>} Created comment object
 */
async function addComment(postId, content, parentId = null) {
  try {
    const payload = { content };
    if (parentId) {
      payload.parent_id = parentId;
    }
    const response = await client.post(`/posts/${postId}/comments`, payload);
    return response.data;
  } catch (error) {
    if (error.isChallenge) {
      console.log('[Moltbook API] Challenge received on addComment - auto-solving...');
      const { solveChallengeAndSubmit } = require('./challenge-solver');
      await solveChallengeAndSubmit(error.challengeData);
      return; // content is live after challenge answer accepted
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

// ===== Status =====

/**
 * Get API status and rate limit info
 * @returns {Promise<Object>} Status object
 */
async function getStatus() {
  try {
    const response = await client.get('/status');
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
  getSubmoltId,

  // Comments
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
  setupOwnerEmail,
  followAgent,
  unfollowAgent,

  // Status
  getStatus,

  // Admin notifier registration
  setAdminNotifier
};
