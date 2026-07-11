// /utils/signing-key.js
// Centralised, leak-safe access to KINETIX_SIGNING_KEY.
//
// ethers only redacts the private key in its error message for the
// valid-hex-but-wrong-length case. A key with stray whitespace or quotes
// (the most common .env mistakes) throws "invalid BytesLike value
// (... value="0x<FULL KEY> " ...)" — the raw key text. That message then
// flows into logs, persisted submission-tracking files, and Telegram replies.
//
// Everything that needs the signing key MUST go through here so a malformed
// value is rejected with a fixed-string error that never contains the value,
// and Wallet construction is wrapped so ethers' own message can never surface.

const { ethers } = require('ethers');

// A raw secp256k1 private key: 0x + 64 hex chars.
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Read and validate KINETIX_SIGNING_KEY from the environment.
 * @returns {string} the validated 0x-prefixed 32-byte hex key
 * @throws {Error} with a fixed-string message that never contains key material
 */
function getSigningKey() {
  const raw = process.env.KINETIX_SIGNING_KEY;
  if (!raw) {
    throw new Error('KINETIX_SIGNING_KEY not set in .env');
  }
  const key = raw.trim();
  if (!PRIVATE_KEY_RE.test(key)) {
    // Deliberately no interpolation of `raw`/`key` — never echo the value.
    throw new Error(
      'Invalid KINETIX_SIGNING_KEY format: expected a 0x-prefixed 64-character hex private key.'
    );
  }
  return key;
}

/**
 * Build an ethers Wallet from the validated signing key. Wraps construction so
 * that even an unexpected ethers error cannot leak the key in its message.
 * @param {ethers.Provider} [provider] - optional provider to connect
 * @returns {ethers.Wallet}
 * @throws {Error} with a fixed-string message that never contains key material
 */
function createSigner(provider = null) {
  const key = getSigningKey();
  try {
    return provider ? new ethers.Wallet(key, provider) : new ethers.Wallet(key);
  } catch {
    // Swallow the original error entirely — it may contain the raw key.
    throw new Error('Invalid KINETIX_SIGNING_KEY: failed to construct signing wallet.');
  }
}

module.exports = { getSigningKey, createSigner, PRIVATE_KEY_RE };
