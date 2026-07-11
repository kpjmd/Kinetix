// /utils/network.js
// Single source of truth for resolving the target on-chain network.
//
// Two env vars historically selected the network with DIFFERENT defaults:
//   - NETWORK_ID       (wallet layer)      e.g. 'base-sepolia', default base-sepolia
//   - DEFAULT_NETWORK  (attestation layer) e.g. 'base_sepolia', default base_mainnet
// Once the mainnet EAS schema is registered, an unset DEFAULT_NETWORK would
// silently send attestations to mainnet while the wallet layer still believed
// it was on Sepolia. This resolver removes the silent mainnet default (fail
// fast instead) and refuses to run when the two layers disagree.

const KNOWN_NETWORKS = ['base_mainnet', 'base_sepolia'];

// NETWORK_ID uses hyphens ('base-sepolia'); DEFAULT_NETWORK uses underscores.
function _normalize(name) {
  return name ? name.trim().replace(/-/g, '_') : null;
}

/**
 * Resolve the target attestation/reputation network.
 * @param {string|null} explicit - caller-specified network (wins if provided)
 * @returns {string} 'base_mainnet' or 'base_sepolia'
 * @throws {Error} if no network is configured, it is unknown, or the wallet
 *   and attestation env layers disagree.
 */
function resolveNetwork(explicit = null) {
  const explicitNorm = _normalize(explicit);
  const fromDefault = _normalize(process.env.DEFAULT_NETWORK);
  const fromWallet = _normalize(process.env.NETWORK_ID);

  // When a network is passed explicitly, that is the unambiguous answer for
  // this call. Otherwise we infer from the environment — and if the two env
  // layers disagree, refuse to guess: that split-brain would send on-chain
  // writes to a different network than the wallet layer believes it is on.
  if (!explicitNorm && fromDefault && fromWallet && fromDefault !== fromWallet) {
    throw new Error(
      `Network split-brain: DEFAULT_NETWORK=${fromDefault} but NETWORK_ID=${fromWallet}. ` +
      `Set both to the same network before running.`
    );
  }

  const chosen = explicitNorm || fromDefault || fromWallet;
  if (!chosen) {
    throw new Error(
      'No network configured. Set DEFAULT_NETWORK (base_mainnet or base_sepolia) explicitly.'
    );
  }
  if (!KNOWN_NETWORKS.includes(chosen)) {
    throw new Error(`Unknown network: ${chosen}. Use base_mainnet or base_sepolia`);
  }
  return chosen;
}

module.exports = { resolveNetwork, KNOWN_NETWORKS };
