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

/**
 * @param {Object} input
 * @param {string} input.platform - one of SUPPORTED_PLATFORMS
 * @param {string} input.platform_handle - the account identifier on that platform
 * @returns {{platform: string, platform_profiles: Object, pubkey: string}}
 * @throws {ValidationError} when the commitment could not be monitored
 */
function resolveMonitoringTarget({ platform, platform_handle }) {
  if (!platform) {
    throw new ValidationError(
      `platform is required and must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`
    );
  }
  if (typeof platform !== 'string' || !SUPPORTED_PLATFORMS.includes(platform)) {
    throw new ValidationError(
      `Unsupported platform "${platform}". Verification is available for: ${SUPPORTED_PLATFORMS.join(', ')}`
    );
  }
  if (!platform_handle || typeof platform_handle !== 'string' || !platform_handle.trim()) {
    throw new ValidationError(`platform_handle is required for ${platform}`);
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
      throw new ValidationError(`Invalid clawstr platform_handle: ${error.message}`);
    }
  }

  return {
    platform,
    // The handle as given, for display. The collector must read `pubkey`.
    platform_profiles: { [platform]: handle },
    pubkey
  };
}

module.exports = { resolveMonitoringTarget, SUPPORTED_PLATFORMS };
