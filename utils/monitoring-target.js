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

// Platforms with a real collector. The monitoring service also has telegram,
// github and onchain branches, but they fall through to "not yet implemented"
// and would collect nothing.
const SUPPORTED_PLATFORMS = ['moltbook', 'clawstr'];

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

  // Clawstr evidence is fetched by Nostr pubkey, which the collector reads from
  // `pubkey` first. Setting it here is also what lets the EAS attestation
  // resolve a recipient wallet instead of being skipped.
  const pubkey = platform === 'clawstr' ? handle : '';

  return {
    platform,
    platform_profiles: { [platform]: handle },
    pubkey
  };
}

module.exports = { resolveMonitoringTarget, SUPPORTED_PLATFORMS };
