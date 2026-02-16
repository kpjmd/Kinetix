/**
 * Clawstr API - Node.js wrapper around NAK CLI for Nostr/Clawstr interactions
 *
 * This module provides a clean JavaScript API for interacting with Clawstr (Nostr-based AI agent social network)
 * using the NAK CLI tool. It handles NIP-22 (subclaw) tags, multi-relay publishing, and robust error handling.
 */

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const execFileAsync = promisify(execFile);

// Configuration
const CONFIG = {
  clawstrBaseUrl: 'https://clawstr.com',
  relays: [
    'wss://relay.ditto.pub',
    'wss://relay.primal.net',
    'wss://nos.lol'
  ],
  secretKeyPath: process.env.CLAWSTR_SECRET_KEY_PATH || path.join(os.homedir(), '.clawstr', 'secret.key'),
  nakPath: process.env.NAK_PATH || path.join(os.homedir(), 'go', 'bin', 'nak'), // Default to ~/go/bin/nak
  retryAttempts: 3,
  retryDelay: 1000, // ms
  timeout: 45000 // 45 seconds
};

/**
 * Load the Nostr secret key from file
 */
async function loadSecretKey() {
  try {
    const expandedPath = CONFIG.secretKeyPath.replace(/^~/, os.homedir());
    const secretKey = await fs.readFile(expandedPath, 'utf-8');
    return secretKey.trim();
  } catch (error) {
    throw new Error(`Failed to load secret key from ${CONFIG.secretKeyPath}: ${error.message}`);
  }
}

/**
 * Get public key (npub format) from secret key
 */
async function getPublicKey() {
  try {
    const hexPubkey = await getHexPublicKey();
    const { stdout } = await execFileAsync(CONFIG.nakPath, ['encode', 'npub', hexPubkey]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get public key: ${error.message}`);
  }
}

/**
 * Get hex public key from secret key
 */
async function getHexPublicKey() {
  try {
    const secretKey = await loadSecretKey();
    const { stdout } = await execFileAsync(CONFIG.nakPath, ['key', 'public', secretKey]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get hex public key: ${error.message}`);
  }
}

/**
 * Build NIP-22 tags for subclaw posts
 *
 * CRITICAL: Clawstr requires specific tag formats (per official docs):
 * - I tag: Full URL format (https://clawstr.com/c/<subclaw>), NOT short paths
 * - K tag: "web" (literal string), NOT "1111"
 * - Root posts: Need BOTH uppercase I/K AND lowercase i/k tags
 * - Replies: lowercase k must be "1111" (parent's kind), NOT "web"
 *
 * @param {string} subclaw - Subclaw identifier (e.g., "/c/ai-freedom")
 * @param {object} parentEvent - Parent event object if this is a reply (must have id, pubkey, optionally relay)
 * @returns {array} Array of NIP-22 compliant tags
 */
function buildNip22Tags(subclaw, parentEvent = null) {
  const tags = [];

  // Convert short path to full URL (Clawstr requires full URLs)
  const subclawUrl = subclaw.startsWith('http')
    ? subclaw
    : `${CONFIG.clawstrBaseUrl}${subclaw}`;

  // Root scope tags (UPPERCASE) - always present
  tags.push(['I', subclawUrl]);
  tags.push(['K', 'web']);

  if (parentEvent) {
    // REPLY: e tag with relay hint, k=1111 (parent's kind), p tag
    const relayHint = parentEvent.relay || 'wss://relay.ditto.pub';
    tags.push(['e', parentEvent.id, relayHint, parentEvent.pubkey]);
    tags.push(['k', '1111']);  // CRITICAL: parent's kind is 1111, not "web"
    tags.push(['p', parentEvent.pubkey]);
  } else {
    // ROOT POST: lowercase i/k tags (same as uppercase for new posts)
    tags.push(['i', subclawUrl]);
    tags.push(['k', 'web']);
  }

  // AI agent labels (NIP-32) - REQUIRED for AI feeds
  tags.push(['L', 'agent']);
  tags.push(['l', 'ai', 'agent']);

  return tags;
}

/**
 * Build tag arguments for NAK CLI
 * NAK expects tags in format: -t key=value1;value2;value3
 *
 * @param {array} tags - Array of tag arrays
 * @returns {array} Flat array of args like ['-t', 'I=/c/ai-freedom;subclaw', '-t', 'K=1111']
 */
function buildTagArgs(tags) {
  const args = [];
  for (const tag of tags) {
    const [key, ...values] = tag;
    args.push('-t', `${key}=${values.join(';')}`);
  }
  return args;
}

/**
 * Run NAK as a spawned process with stdin closed.
 * NAK checks for stdin input and hangs if a pipe is open, so we must use
 * spawn with stdio: ['ignore', 'pipe', 'pipe'] instead of execFile.
 *
 * @param {array} args - Array of arguments for the NAK binary
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function spawnNak(args, timeout) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.nakPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env.PATH}:${os.homedir()}/go/bin` }
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || (!killed && stdout.trim())) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        const err = new Error(`Command failed: ${CONFIG.nakPath} ${args.join(' ')}\n${stderr.trim()}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        err.killed = killed;
        reject(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Execute NAK command with retry logic, partial success detection, and multi-relay support
 *
 * @param {array} args - Array of arguments for the NAK binary
 * @param {object} options - Options: retries, timeout
 * @returns {object} { stdout, stderr }
 */
async function executeNak(args, options = {}) {
  const { retries = CONFIG.retryAttempts, timeout = CONFIG.timeout } = options;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Redact secret key from log output
      const logArgs = args.map((a, i) => args[i - 1] === '--sec' ? '***' : a);
      console.log(`[NAK] Executing (attempt ${attempt}/${retries}): nak ${logArgs.join(' ')}`);

      const result = await spawnNak(args, timeout);

      console.log(`[NAK] Success on attempt ${attempt}`);
      return result;

    } catch (error) {
      // Check if event was created despite error (partial success for event commands)
      if (error.stdout && error.stdout.trim().startsWith('{')) {
        console.log(`[NAK] Partial success on attempt ${attempt} (event created, some relays may have failed)`);
        return { stdout: error.stdout.trim(), stderr: (error.stderr || '').trim() };
      }

      // NAK req exits non-zero when no events match the filter.
      // If relays connected successfully but returned no data, treat as empty success.
      const stderr = (error.stderr || '').trim();
      const connectedOk = stderr.includes('ok.');
      const isReqCommand = args[0] === 'req';
      if (isReqCommand && connectedOk && (!error.stdout || error.stdout.trim() === '')) {
        console.log(`[NAK] No results from relays on attempt ${attempt} (connected ok, zero matches)`);
        return { stdout: '', stderr };
      }

      lastError = error;
      console.error(`[NAK] Attempt ${attempt} failed: ${error.message}`);

      if (attempt < retries) {
        const delay = CONFIG.retryDelay * attempt;
        console.log(`[NAK] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`NAK command failed after ${retries} attempts: ${lastError.message}`);
}

/**
 * Create a new post in a subclaw
 *
 * @param {string} subclaw - Subclaw identifier (e.g., "/c/ai-freedom")
 * @param {string} content - Post content
 * @returns {object} Result with event ID and relay confirmations
 */
async function createPost(subclaw, content) {
  try {
    const secretKey = await loadSecretKey();
    const tags = buildNip22Tags(subclaw);
    const tagArgs = buildTagArgs(tags);

    const args = [
      'event',
      '--sec', secretKey,
      '--kind', '1111',
      '--auth',
      '-c', content,
      ...tagArgs,
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 45000 });

    // Parse event ID from output (NAK returns event JSON)
    let eventId = null;
    try {
      const eventJson = JSON.parse(result.stdout);
      eventId = eventJson.id;
    } catch {
      // If parsing fails, try to extract from output
      const match = result.stdout.match(/"id"\s*:\s*"([a-f0-9]+)"/);
      eventId = match ? match[1] : null;
    }

    return {
      success: true,
      eventId,
      subclaw,
      content,
      relays: CONFIG.relays,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`[Clawstr] Failed to create post in ${subclaw}:`, error.message);
    throw error;
  }
}

/**
 * Create a reply to an existing event
 *
 * @param {string} eventId - ID of event to reply to
 * @param {string} content - Reply content
 * @param {string} subclaw - Subclaw where original event was posted
 * @param {string} parentPubkey - Pubkey of parent event author
 * @param {string} relayHint - Relay hint for the parent event (optional)
 * @returns {object} Result with event ID and relay confirmations
 */
async function createReply(eventId, content, subclaw, parentPubkey, relayHint = null) {
  try {
    const secretKey = await loadSecretKey();
    const tags = buildNip22Tags(subclaw, {
      id: eventId,
      pubkey: parentPubkey,
      relay: relayHint || 'wss://relay.ditto.pub'
    });
    const tagArgs = buildTagArgs(tags);

    const args = [
      'event',
      '--sec', secretKey,
      '--kind', '1111',
      '--auth',
      '-c', content,
      ...tagArgs,
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 45000 });

    // Parse event ID from output
    let replyEventId = null;
    try {
      const eventJson = JSON.parse(result.stdout);
      replyEventId = eventJson.id;
    } catch {
      const match = result.stdout.match(/"id"\s*:\s*"([a-f0-9]+)"/);
      replyEventId = match ? match[1] : null;
    }

    return {
      success: true,
      eventId: replyEventId,
      parentEventId: eventId,
      subclaw,
      content,
      relays: CONFIG.relays,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`[Clawstr] Failed to create reply to ${eventId}:`, error.message);
    throw error;
  }
}

/**
 * React to an event (upvote or downvote)
 *
 * @param {string} eventId - ID of event to react to
 * @param {string} reaction - Reaction type: "+" (upvote) or "-" (downvote)
 * @param {string} targetPubkey - Public key of target event author (optional)
 * @returns {object} Result with reaction event ID
 */
async function react(eventId, reaction = '+', targetPubkey = null) {
  try {
    const secretKey = await loadSecretKey();

    // Normalize reaction
    const normalizedReaction = reaction === '+' || reaction === 'upvote' ? '+' : '-';
    const relayHint = 'wss://relay.ditto.pub';

    const args = [
      'event',
      '--sec', secretKey,
      '--kind', '7',
      '--auth',
      '-t', `e=${eventId};${relayHint}${targetPubkey ? ';' + targetPubkey : ''}`,
      '-t', 'k=1111',  // CRITICAL: target event's kind
      ...(targetPubkey ? ['-t', `p=${targetPubkey}`] : []),
      '-c', normalizedReaction,
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 45000 });

    // Parse event ID from output
    let reactionEventId = null;
    try {
      const eventJson = JSON.parse(result.stdout);
      reactionEventId = eventJson.id;
    } catch {
      const match = result.stdout.match(/"id"\s*:\s*"([a-f0-9]+)"/);
      reactionEventId = match ? match[1] : null;
    }

    return {
      success: true,
      eventId: reactionEventId,
      targetEventId: eventId,
      reaction: normalizedReaction,
      relays: CONFIG.relays,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`[Clawstr] Failed to react to ${eventId}:`, error.message);
    throw error;
  }
}

/**
 * Get feed from a subclaw
 *
 * @param {string} subclaw - Subclaw identifier (e.g., "/c/ai-freedom")
 * @param {number} limit - Number of posts to retrieve (default: 20)
 * @returns {array} Array of events
 */
async function getFeed(subclaw, limit = 20) {
  try {
    // Convert short path to full URL (Clawstr requires full URLs for queries)
    const subclawUrl = subclaw.startsWith('http')
      ? subclaw
      : `${CONFIG.clawstrBaseUrl}${subclaw}`;

    const args = [
      'req',
      '-k', '1111',
      '-t', `I=${subclawUrl}`,
      '-l', String(limit),
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 15000 });

    // Parse events from output
    const events = [];
    const lines = result.stdout.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);
      } catch (error) {
        console.warn(`[Clawstr] Failed to parse event: ${line}`);
      }
    }

    // Sort by created_at descending (newest first)
    events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    return events.slice(0, limit);

  } catch (error) {
    console.error(`[Clawstr] Failed to get feed for ${subclaw}:`, error.message);
    // Return empty array on error to allow graceful degradation
    return [];
  }
}

/**
 * Get notifications (mentions and replies)
 *
 * @param {number} limit - Number of notifications to retrieve (default: 20)
 * @returns {array} Array of notification events
 */
async function getNotifications(limit = 20) {
  try {
    const hexPubkey = await getHexPublicKey();

    const args = [
      'req',
      '-p', hexPubkey,
      '-l', String(limit),
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 15000 });

    // Parse events from output
    const events = [];
    const lines = result.stdout.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);
      } catch (error) {
        console.warn(`[Clawstr] Failed to parse notification event: ${line}`);
      }
    }

    // Sort by created_at descending (newest first)
    events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    return events.slice(0, limit);

  } catch (error) {
    console.error(`[Clawstr] Failed to get notifications:`, error.message);
    return [];
  }
}

/**
 * Set Nostr profile metadata (NIP-01 kind 0)
 *
 * @param {object} metadata - Profile metadata { name, about, picture, etc. }
 * @returns {object} Result with event ID
 */
async function setProfile(metadata) {
  try {
    const secretKey = await loadSecretKey();
    const metadataJson = JSON.stringify(metadata);

    const args = [
      'event',
      '--sec', secretKey,
      '--kind', '0',
      '--auth',
      '-c', metadataJson,
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 45000 });

    // Parse event ID from output
    let eventId = null;
    try {
      const eventJson = JSON.parse(result.stdout);
      eventId = eventJson.id;
    } catch {
      const match = result.stdout.match(/"id"\s*:\s*"([a-f0-9]+)"/);
      eventId = match ? match[1] : null;
    }

    return {
      success: true,
      eventId,
      metadata,
      relays: CONFIG.relays,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`[Clawstr] Failed to set profile:`, error.message);
    throw error;
  }
}

/**
 * Get profile metadata for a public key
 *
 * @param {string} pubkey - Public key (npub or hex format)
 * @returns {object} Profile metadata
 */
async function getProfile(pubkey = null) {
  try {
    // If no pubkey provided, get our own
    const targetPubkey = pubkey || await getHexPublicKey();

    const args = [
      'req',
      '-k', '0',
      '-a', targetPubkey,
      '-l', '1',
      ...CONFIG.relays
    ];

    const result = await executeNak(args, { timeout: 10000 });

    // Parse profile event
    const lines = result.stdout.split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      return null;
    }

    try {
      const event = JSON.parse(lines[0]);
      const metadata = JSON.parse(event.content);
      return {
        ...metadata,
        pubkey: event.pubkey,
        updated_at: event.created_at
      };
    } catch (error) {
      console.warn(`[Clawstr] Failed to parse profile: ${error.message}`);
      return null;
    }

  } catch (error) {
    console.error(`[Clawstr] Failed to get profile:`, error.message);
    return null;
  }
}

module.exports = {
  createPost,
  createReply,
  react,
  getFeed,
  getNotifications,
  setProfile,
  getProfile,
  getPublicKey,
  getHexPublicKey,
  CONFIG
};
