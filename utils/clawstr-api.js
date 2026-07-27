/**
 * Clawstr API - Node.js wrapper around NAK CLI for Nostr/Clawstr interactions
 *
 * This module provides a clean JavaScript API for interacting with Clawstr (Nostr-based AI agent social network)
 * using the NAK CLI tool. It handles NIP-22 (subclaw) tags, multi-relay publishing, and robust error handling.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const { bech32 } = require('@scure/base');

// Where to look for the nak binary, in order, when NAK_PATH is not set.
// scripts/install-nak-railway.sh (run from postinstall on every Railway
// service) installs to ${NAK_INSTALL_DIR:-/app/bin}, but this module used to
// look only in ~/go/bin — the local `go install` location. On Railway that
// mismatch meant every nak call failed, and because getFeed swallows errors
// and returns [], Clawstr evidence collection silently produced nothing.
const NAK_FALLBACK_PATHS = [
  '/app/bin/nak',
  path.join(os.homedir(), 'go', 'bin', 'nak')
];

// Directories added to PATH for the spawned process, so a nak that resolves
// via bare-name lookup still works.
const NAK_PATH_DIRS = ['/app/bin', path.join(os.homedir(), 'go', 'bin')];

let resolvedNakPath = null;

function isExecutable(candidate) {
  try {
    fsSync.accessSync(candidate, fsSync.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Resolve the nak binary once, and say out loud which one won.
 * A missing binary used to surface as an empty evidence set, which is
 * indistinguishable from "the agent did nothing" — for a paid verification
 * that is the difference between a refund and a false negative.
 */
function resolveNakPath() {
  if (resolvedNakPath) return resolvedNakPath;

  // An explicit NAK_PATH always wins: a typo there should fail loudly rather
  // than fall through to some other binary the operator did not choose.
  if (process.env.NAK_PATH) {
    resolvedNakPath = process.env.NAK_PATH;
    if (!isExecutable(resolvedNakPath)) {
      console.warn(`[NAK] NAK_PATH=${resolvedNakPath} is not executable — nak calls will fail`);
    }
    return resolvedNakPath;
  }

  for (const candidate of NAK_FALLBACK_PATHS) {
    if (isExecutable(candidate)) {
      resolvedNakPath = candidate;
      console.log(`[NAK] Using nak at ${candidate}`);
      return resolvedNakPath;
    }
  }

  console.warn(
    `[NAK] No nak binary at ${NAK_FALLBACK_PATHS.join(' or ')} — ` +
    'falling back to a PATH lookup. Set NAK_PATH if this is wrong.'
  );
  resolvedNakPath = 'nak';
  return resolvedNakPath;
}

// Test-only: clears the memoised path so a test can vary NAK_PATH.
function _resetNakPathCache() {
  resolvedNakPath = null;
}

// Configuration
const CONFIG = {
  clawstrBaseUrl: 'https://clawstr.com',
  relays: [
    'wss://relay.ditto.pub',
    'wss://relay.primal.net',
    'wss://nos.lol'
  ],
  secretKeyPath: process.env.CLAWSTR_SECRET_KEY_PATH || path.join(os.homedir(), '.clawstr', 'secret.key'),
  // Resolved lazily so that probing the filesystem does not happen at require
  // time, and so NAK_PATH set after import is still honoured.
  get nakPath() { return resolveNakPath(); },
  retryAttempts: 3,
  retryDelay: 1000, // ms
  timeout: 45000 // 45 seconds
};

/**
 * Redact secret material from an argv array before it reaches a log line or an
 * error message. `--sec <key>` is used by the publishing commands, and
 * `key public <secret>` derives a pubkey from the secret key.
 */
function redactArgs(args) {
  return args.map((arg, i) => {
    if (args[i - 1] === '--sec') return '***';
    if (i === 2 && args[0] === 'key' && args[1] === 'public') return '***';
    return arg;
  });
}

/**
 * Load the Nostr secret key from file
 */
async function loadSecretKey() {
  // Support inline env var for Railway/cloud deployments (no filesystem key)
  if (process.env.CLAWSTR_SECRET_KEY) {
    return process.env.CLAWSTR_SECRET_KEY.trim();
  }
  try {
    const expandedPath = CONFIG.secretKeyPath.replace(/^~/, os.homedir());
    const secretKey = await fs.readFile(expandedPath, 'utf-8');
    return secretKey.trim();
  } catch (error) {
    throw new Error(`Failed to load secret key. Set CLAWSTR_SECRET_KEY env var or CLAWSTR_SECRET_KEY_PATH. Error: ${error.message}`);
  }
}

/**
 * Get public key (npub format) from secret key
 */
async function getPublicKey() {
  try {
    const hexPubkey = await getHexPublicKey();
    // spawnNak rather than execFile: these two used the configured path
    // directly with no PATH augmentation, so they broke in exactly the
    // environment the path resolution above exists to fix.
    const { stdout } = await spawnNak(['encode', 'npub', hexPubkey], CONFIG.timeout);
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
    const { stdout } = await spawnNak(['key', 'public', secretKey], CONFIG.timeout);
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
  const nakPath = resolveNakPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(nakPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: [process.env.PATH, ...NAK_PATH_DIRS].filter(Boolean).join(':') }
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
        const err = new Error(`Command failed: ${nakPath} ${redactArgs(args).join(' ')}\n${stderr.trim()}`);
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
      console.log(`[NAK] Executing (attempt ${attempt}/${retries}): nak ${redactArgs(args).join(' ')}`);

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

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Normalise any accepted Nostr identity form to a bare lowercase 64-char hex
 * pubkey — the form relays return in `event.pubkey`, and therefore the only
 * form an author filter can match.
 *
 * Decoded in-process rather than through `nak decode`: this runs on the paid
 * request path, where a subprocess per sale is both latency and a failure mode
 * (a missing nak would reject every Clawstr verification before payment).
 *
 * Throws rather than returning a falsy value — a silently unmatched pubkey
 * collects zero evidence and scores a paying customer as having done nothing.
 *
 * @param {string} value - npub1..., 0x-prefixed hex, or bare 64-char hex
 * @returns {string} 64-char lowercase hex pubkey
 */
function normalizeNostrPubkey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Nostr pubkey is required');
  }

  const trimmed = value.trim();

  if (trimmed.toLowerCase().startsWith('npub1')) {
    let decoded;
    try {
      // npub is 63 chars; bech32's default limit is 90, passed explicitly so a
      // library default change cannot silently start rejecting valid input.
      decoded = bech32.decode(trimmed.toLowerCase(), 90);
    } catch (error) {
      throw new Error(`Invalid npub (bech32 decode failed): ${error.message}`);
    }
    if (decoded.prefix !== 'npub') {
      throw new Error(`Expected an npub, got prefix "${decoded.prefix}"`);
    }
    const bytes = bech32.fromWords(decoded.words);
    if (bytes.length !== 32) {
      throw new Error(`Invalid npub: expected 32 bytes, got ${bytes.length}`);
    }
    return Buffer.from(bytes).toString('hex');
  }

  const bare = (trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed).toLowerCase();
  if (HEX64.test(bare)) {
    return bare;
  }

  throw new Error(
    `Invalid Nostr pubkey "${trimmed}": expected an npub1... or a 64-character hex key`
  );
}

/**
 * Fetch every kind-1111 event published by one author inside a time window.
 *
 * This is the evidence query for a paid verification, so it deliberately does
 * not behave like getFeed:
 *
 * - It **throws** instead of returning []. getFeed's swallow-and-degrade is
 *   right for a heartbeat and wrong here: a relay outage that yields zero
 *   events is indistinguishable from an agent that did nothing, and scores the
 *   customer `failed`.
 * - It reports relay health. nak exits 0 when *some* relays connected, printing
 *   the failures only to stderr, so a caller that ignores stderr cannot tell a
 *   genuine empty result from a partial outage.
 * - It does not slice to `limit`. nak applies -l per relay, so the union across
 *   CONFIG.relays legitimately exceeds it (verified: -l 5 over 3 relays returns
 *   6 unique events). Slicing would discard real evidence.
 * - It bypasses executeNak, whose "stderr mentions ok. and stdout is empty ->
 *   success" branch is exactly the silent under-count described above.
 *
 * @param {string} hexPubkey - 64-char hex author pubkey
 * @param {object} options - { since, until } unix seconds, { limit } per relay
 * @returns {Promise<{events: array, relaysOk: number, relaysTotal: number}>}
 */
async function getEventsByAuthor(hexPubkey, { since, until, limit = 500 } = {}) {
  if (!HEX64.test(hexPubkey || '')) {
    // Guarded before the spawn so a bad value never becomes an argv element.
    throw new Error(`getEventsByAuthor requires a 64-char hex pubkey, got "${hexPubkey}"`);
  }

  const args = ['req', '-k', '1111', '-a', hexPubkey];
  // Only when set: nak renders an unset -s/-u as a 1969 timestamp.
  if (Number.isFinite(since)) args.push('-s', String(Math.floor(since)));
  if (Number.isFinite(until)) args.push('-u', String(Math.floor(until)));
  args.push('-l', String(limit), ...CONFIG.relays);

  const attempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await spawnNak(args, CONFIG.timeout);
      return parseAuthorEvents(result, limit);
    } catch (error) {
      lastError = error;
      console.error(`[Clawstr] getEventsByAuthor attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * attempt));
      }
    }
  }

  throw new Error(
    `Clawstr author query failed after ${attempts} attempts: ${lastError.message}`
  );
}

/**
 * Turn a nak req result into events plus relay health.
 * Split out from getEventsByAuthor so the parsing is testable without a spawn.
 */
function parseAuthorEvents(result, limit) {
  const relaysTotal = CONFIG.relays.length;
  // nak prints one "connecting to <url>... ok." per relay it reached; a failure
  // prints the reason instead, on the same stream, and does not affect the exit
  // code as long as at least one relay answered.
  const relaysOk = ((result.stderr || '').match(/\.\.\.\s*ok\./g) || []).length;
  if (relaysOk < relaysTotal) {
    console.warn(
      `[Clawstr] Only ${relaysOk}/${relaysTotal} relays answered; ` +
      `a zero or short result may be an outage rather than agent inactivity`
    );
  }

  const byId = new Map();
  for (const line of (result.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      console.warn(`[Clawstr] Skipping unparseable event line: ${line.slice(0, 120)}`);
      continue;
    }
    // Relays overlap. A duplicate here would be counted as a second action.
    if (event && event.id && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }

  const events = [...byId.values()].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  if (events.length >= limit) {
    console.warn(
      `[Clawstr] Author query returned ${events.length} events at limit ${limit}; ` +
      `the window may be truncated and evidence under-counted`
    );
  }

  return { events, relaysOk, relaysTotal };
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
  getEventsByAuthor,
  normalizeNostrPubkey,
  getNotifications,
  setProfile,
  getProfile,
  getPublicKey,
  getHexPublicKey,
  resolveNakPath,
  CONFIG,
  _resetNakPathCache
};
