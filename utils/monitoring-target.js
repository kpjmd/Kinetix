// /utils/monitoring-target.js
// Resolves the platform identity a commitment will be monitored against.
//
// A verification is only sellable if Kinetix can actually observe the agent.
// Evidence collection reads `criteria.platform` to pick a collector
// (services/monitoring-service.js checkCommitment) and then reads
// `platform_profiles[platform]` or `pubkey` to know whose activity to fetch.
// A commitment missing either is not "unverified" — it is unverifiable, and
// will score 0/failed no matter what the agent actually does.
//
// The paid routes call this before creating a commitment so that case is
// rejected with a 400 instead of sold. @x402/express skips settlement when a
// handler responds >= 400, so rejecting here means the caller is not charged.

const { ValidationError } = require('./validation-error');
const { normalizeNostrPubkey } = require('./clawstr-api');

// Platforms with a collector that can actually attribute evidence to one agent.
//
// Moltbook is deliberately absent. Its collector is implemented, but it queries
// moltbookApi.search(handle), a semantic *text* search, and then filters only by
// date — never by author. Any post merely mentioning the handle becomes that
// agent's evidence, so a third party can mint it. Moltbook exposes no
// author-scoped endpoint, so the fix needs live probing of the /search response
// shape and must fail closed. Selling that is worse than not selling it.
//
// telegram, github and onchain have no collector at all; checkCommitment falls
// through to "not yet implemented" and collects nothing.
const SUPPORTED_PLATFORMS = ['clawstr'];

// A known-valid handle to offer in error guidance: Kinetix's own Clawstr
// identity, which posts on a heartbeat and so also gives a buyer testing the
// service a non-empty baseline. Kept here, beside the only parser it must
// satisfy, so an example that stops decoding fails this module's tests.
const EXAMPLE_CLAWSTR_HANDLE = 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5';

const HANDLE_EXPECTED =
  'The agent\'s Nostr public key: an npub (starts with "npub1", exactly 63 characters) ' +
  'or the same key as 64 hexadecimal characters';

/**
 * Guidance for a platform_handle that did not decode, keyed by the error code
 * clawstr-api attaches. Deliberately never includes the decoder's own message:
 * for a corrupted npub that message ends `expected "<checksum>"`, which buyer
 * agents have read as an instruction and prepended to the key.
 */
function handleGuidance(code, handle) {
  const received = handle.length > 80 ? `${handle.slice(0, 80)}…` : handle;
  const base = { field: 'platform_handle', received, expected: HANDLE_EXPECTED, example: EXAMPLE_CLAWSTR_HANDLE };

  if (code === 'PUBKEY_CORRUPTED') {
    return {
      message:
        `platform_handle looks like an npub but is corrupted: it is ${handle.length} characters long ` +
        '(a valid npub is exactly 63) or a character was mistyped. Copy the key exactly from the ' +
        "agent's profile, or send the 64-character hex form instead. Do not edit characters to repair it.",
      guidance: { ...base, code: 'INVALID_PLATFORM_HANDLE' }
    };
  }

  return {
    message:
      `platform_handle "${received}" is not a Nostr public key. Send the agent's npub ` +
      '(starts with "npub1", 63 characters) or its 64-character hex pubkey.',
    guidance: { ...base, code: 'INVALID_PLATFORM_HANDLE' }
  };
}

/**
 * @param {Object} input
 * @param {string} input.platform - one of SUPPORTED_PLATFORMS
 * @param {string} input.platform_handle - the account identifier on that platform
 * @returns {{platform: string, platform_profiles: Object, pubkey: string}}
 * @throws {ValidationError} when the commitment could not be monitored
 */
function resolveMonitoringTarget({ platform, platform_handle }) {
  const platformGuidance = {
    field: 'platform',
    expected: `One of: ${SUPPORTED_PLATFORMS.join(', ')}`,
    example: SUPPORTED_PLATFORMS[0]
  };

  if (!platform) {
    throw new ValidationError(
      `platform is required and must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`,
      { ...platformGuidance, code: 'MISSING_FIELD' }
    );
  }
  if (typeof platform !== 'string' || !SUPPORTED_PLATFORMS.includes(platform)) {
    throw new ValidationError(
      `Unsupported platform "${platform}". Verification is available for: ${SUPPORTED_PLATFORMS.join(', ')}`,
      { ...platformGuidance, code: 'UNSUPPORTED_PLATFORM', received: platform }
    );
  }
  if (!platform_handle || typeof platform_handle !== 'string' || !platform_handle.trim()) {
    throw new ValidationError(`platform_handle is required for ${platform}`, {
      code: 'MISSING_FIELD',
      field: 'platform_handle',
      expected: HANDLE_EXPECTED,
      example: EXAMPLE_CLAWSTR_HANDLE
    });
  }

  const handle = platform_handle.trim();

  // Normalise to hex here, at the point of sale, so exactly one identity format
  // is ever persisted. Relays return hex in event.pubkey, so a raw npub in
  // `pubkey` matches nothing and the commitment collects zero evidence while
  // looking perfectly valid. Rejecting a malformed handle now also means the
  // caller sees a 400 and is not charged.
  let pubkey = '';
  if (platform === 'clawstr') {
    try {
      pubkey = normalizeNostrPubkey(handle);
    } catch (error) {
      const { message, guidance } = handleGuidance(error.code, handle);
      throw new ValidationError(`Invalid clawstr platform_handle: ${message}`, guidance);
    }
  }

  return {
    platform,
    // The handle as given, for display. The collector must read `pubkey`.
    platform_profiles: { [platform]: handle },
    pubkey
  };
}

module.exports = { resolveMonitoringTarget, SUPPORTED_PLATFORMS, EXAMPLE_CLAWSTR_HANDLE };
