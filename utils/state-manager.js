const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

const STATE_FILES = {
  heartbeat: 'heartbeat-state.json',
  engagement: 'engagement-history.json',
  social: 'social-state.json'
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
  }
};

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
      }
      break;
    case 'downvote':
      if (!state.downvotedPosts.includes(id)) {
        state.downvotedPosts.push(id);
      }
      break;
    case 'comment':
      state.commentedPosts.push(record);
      break;
    case 'reply':
      state.repliedComments.push(record);
      break;
    // Clawstr engagement types
    case 'clawstr_react':
      if (!state.clawstr_reacted_events.includes(id)) {
        state.clawstr_reacted_events.push(id);
      }
      break;
    case 'clawstr_reply':
      state.clawstr_replied_events.push(record);
      break;
    case 'clawstr_post':
      state.clawstr_posted_subclaws.push(record);
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
  updateSocial
};
