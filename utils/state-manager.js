const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

const STATE_FILES = {
  heartbeat: 'heartbeat-state.json',
  engagement: 'engagement-history.json',
  social: 'social-state.json',
  moltbookRate: 'moltbook-rate-state.json'
};

// Default state structures
const DEFAULTS = {
  heartbeat: {
    lastCheck: null,
    lastHeartbeatFetch: null,
    runHistory: []  // { timestamp, action, result }
  },
  engagement: {
    upvotedPosts: [],      // post IDs (Moltbook)
    downvotedPosts: [],
    commentedPosts: [],    // { postId, commentId, timestamp }
    repliedComments: [],
    // Clawstr engagement tracking
    clawstr_reacted_events: [],  // event IDs that were reacted to
    clawstr_replied_events: [],  // { id, timestamp, eventId, subclaw }
    clawstr_posted_subclaws: []  // { subclaw, eventId, timestamp }
  },
  social: {
    followedAgents: [],
    subscribedSubmolts: [],
    lastProfileSync: null,
    // Clawstr social state
    clawstr_subclaws: [],  // Subclaws we're active in
    clawstr_pubkey: null,  // Our Nostr public key (npub)
    clawstr_profile_updated: null  // Last profile update timestamp
  },
  moltbookRate: {
    lastPostAt: null,          // ISO timestamp of the last successful post
    commentTimestamps: []      // ISO timestamps of successful comments, last 24h
  }
};

// Moltbook's documented floors for an established agent (rules.md):
// 1 post / 30 min, 1 comment / 20 sec, 50 comments / day.
const MOLTBOOK_POST_FLOOR_MS = 30 * 60 * 1000;
const MOLTBOOK_COMMENT_FLOOR_MS = 20 * 1000;
const MOLTBOOK_COMMENT_DAILY_MAX = 50;
const MOLTBOOK_COMMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Check whether Moltbook's per-30-minute post floor allows a post right now.
 * Enforced locally (persisted to disk) so the limit survives a Railway restart
 * and applies across every caller (heartbeat, Telegram approve, NLP tool).
 * @returns {Promise<{allowed: boolean, waitMs: number}>}
 */
async function checkMoltbookPostAllowed() {
  const state = await loadState('moltbookRate');
  if (!state.lastPostAt) return { allowed: true, waitMs: 0 };
  const elapsed = Date.now() - new Date(state.lastPostAt).getTime();
  const waitMs = MOLTBOOK_POST_FLOOR_MS - elapsed;
  return waitMs > 0 ? { allowed: false, waitMs } : { allowed: true, waitMs: 0 };
}

/**
 * Record a successful Moltbook post for the rate floor above.
 */
async function recordMoltbookPost() {
  const state = await loadState('moltbookRate');
  state.lastPostAt = new Date().toISOString();
  await saveState('moltbookRate', state);
}

/**
 * Check whether Moltbook's 20s-between/50-per-day comment floor allows a
 * comment right now.
 * @returns {Promise<{allowed: boolean, waitMs: number, reason?: string}>}
 */
async function checkMoltbookCommentAllowed() {
  const state = await loadState('moltbookRate');
  const cutoff = Date.now() - MOLTBOOK_COMMENT_WINDOW_MS;
  const recent = state.commentTimestamps.filter(t => new Date(t).getTime() >= cutoff);

  if (recent.length >= MOLTBOOK_COMMENT_DAILY_MAX) {
    const oldest = new Date(recent[0]).getTime();
    return { allowed: false, waitMs: oldest + MOLTBOOK_COMMENT_WINDOW_MS - Date.now(), reason: 'daily_max' };
  }

  const last = recent[recent.length - 1];
  if (last) {
    const elapsed = Date.now() - new Date(last).getTime();
    const waitMs = MOLTBOOK_COMMENT_FLOOR_MS - elapsed;
    if (waitMs > 0) return { allowed: false, waitMs, reason: 'floor' };
  }

  return { allowed: true, waitMs: 0 };
}

/**
 * Record a successful Moltbook comment for the rate floor above.
 */
async function recordMoltbookComment() {
  const state = await loadState('moltbookRate');
  const cutoff = Date.now() - MOLTBOOK_COMMENT_WINDOW_MS;
  state.commentTimestamps = state.commentTimestamps.filter(t => new Date(t).getTime() >= cutoff);
  state.commentTimestamps.push(new Date().toISOString());
  await saveState('moltbookRate', state);
}

/**
 * Load state from JSON file
 * @param {string} stateType - Type of state: 'heartbeat', 'engagement', 'social'
 * @returns {Promise<Object>} State object
 */
async function loadState(stateType) {
  const filePath = path.join(DATA_DIR, STATE_FILES[stateType]);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return { ...DEFAULTS[stateType], ...JSON.parse(data) };
  } catch (error) {
    // Return defaults if file doesn't exist
    return { ...DEFAULTS[stateType] };
  }
}

/**
 * Save state to JSON file
 * @param {string} stateType - Type of state: 'heartbeat', 'engagement', 'social'
 * @param {Object} state - State object to save
 */
async function saveState(stateType, state) {
  const filePath = path.join(DATA_DIR, STATE_FILES[stateType]);
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

/**
 * Record an engagement action
 * @param {string} type - Engagement type: 'upvote', 'downvote', 'comment', 'reply', 'clawstr_react', 'clawstr_reply', 'clawstr_post'
 * @param {string} id - Post or comment ID (or event ID for Clawstr)
 * @param {Object} metadata - Additional metadata
 */
async function recordEngagement(type, id, metadata = {}) {
  const state = await loadState('engagement');
  const record = { id, timestamp: new Date().toISOString(), ...metadata };

  switch(type) {
    case 'upvote':
      if (!state.upvotedPosts.includes(id)) {
        state.upvotedPosts.push(id);
        if (state.upvotedPosts.length > 5000) state.upvotedPosts = state.upvotedPosts.slice(-5000);
      }
      break;
    case 'downvote':
      if (!state.downvotedPosts.includes(id)) {
        state.downvotedPosts.push(id);
        if (state.downvotedPosts.length > 5000) state.downvotedPosts = state.downvotedPosts.slice(-5000);
      }
      break;
    case 'comment':
      state.commentedPosts.push(record);
      if (state.commentedPosts.length > 1000) state.commentedPosts = state.commentedPosts.slice(-1000);
      break;
    case 'reply':
      state.repliedComments.push(record);
      if (state.repliedComments.length > 1000) state.repliedComments = state.repliedComments.slice(-1000);
      break;
    // Clawstr engagement types
    case 'clawstr_react':
      if (!state.clawstr_reacted_events.includes(id)) {
        state.clawstr_reacted_events.push(id);
        if (state.clawstr_reacted_events.length > 5000) state.clawstr_reacted_events = state.clawstr_reacted_events.slice(-5000);
      }
      break;
    case 'clawstr_reply':
      state.clawstr_replied_events.push(record);
      if (state.clawstr_replied_events.length > 1000) state.clawstr_replied_events = state.clawstr_replied_events.slice(-1000);
      break;
    case 'clawstr_post':
      state.clawstr_posted_subclaws.push(record);
      if (state.clawstr_posted_subclaws.length > 1000) state.clawstr_posted_subclaws = state.clawstr_posted_subclaws.slice(-1000);
      break;
  }

  await saveState('engagement', state);
}

/**
 * Check if already engaged with a post
 * @param {string} type - Engagement type
 * @param {string} id - Post or comment ID (or event ID for Clawstr)
 * @returns {Promise<boolean>} True if already engaged
 */
async function hasEngaged(type, id) {
  const state = await loadState('engagement');
  switch(type) {
    case 'upvote':
      return state.upvotedPosts.includes(id);
    case 'downvote':
      return state.downvotedPosts.includes(id);
    case 'comment':
      return state.commentedPosts.some(c => c.id === id);
    // Clawstr engagement checks
    case 'clawstr_react':
      return state.clawstr_reacted_events.includes(id);
    case 'clawstr_reply':
      return state.clawstr_replied_events.some(e => e.id === id);
    case 'clawstr_post':
      return state.clawstr_posted_subclaws.some(e => e.id === id);
  }
  return false;
}

/**
 * Update heartbeat state
 * @param {string} action - Action description
 * @param {Object} result - Result object
 */
async function updateHeartbeat(action, result) {
  const state = await loadState('heartbeat');
  state.lastCheck = new Date().toISOString();
  state.runHistory.push({
    timestamp: state.lastCheck,
    action,
    result
  });

  // Keep only last 100 entries
  if (state.runHistory.length > 100) {
    state.runHistory = state.runHistory.slice(-100);
  }

  await saveState('heartbeat', state);
}

/**
 * Update social state (followed agents, subscribed submolts)
 * @param {Object} updates - Updates to apply
 */
async function updateSocial(updates) {
  const state = await loadState('social');
  Object.assign(state, updates);
  await saveState('social', state);
}

module.exports = {
  loadState,
  saveState,
  recordEngagement,
  hasEngaged,
  updateHeartbeat,
  updateSocial,
  checkMoltbookPostAllowed,
  recordMoltbookPost,
  checkMoltbookCommentAllowed,
  recordMoltbookComment
};
