// /utils/receipt-identity.js
// Single definition of how to read a recipient's on-chain identity off a
// receipt, once that identity can be discovered both at issuance
// (receipt.recipient.*, frozen inside the signed payload) and later by
// reconciliation (receipt.metadata.resolved_erc8004_token_id, a mutable
// field — see receipt-canonical.js). Every reader of a recipient's token id
// or wallet must go through here rather than reading receipt.recipient.*
// directly, so the precedence rule has exactly one place to change.

// Matches the EVM-address test used when a receipt is first signed
// (attestation-service.js) — anything that fails this becomes '' there and
// stays '' forever (recipient.* is frozen post-signing).
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * The ERC-8004 token ID to use for this receipt, preferring a token
 * resolved after issuance (metadata.resolved_erc8004_token_id, written by
 * reconciliation once a wallet's on-chain registration is found) over the
 * one supplied at issuance (recipient.erc8004_token_id, frozen).
 * @param {Object} receipt
 * @returns {string|null}
 */
function effectiveTokenId(receipt) {
  return receipt.metadata?.resolved_erc8004_token_id ?? receipt.recipient?.erc8004_token_id ?? null;
}

/**
 * True if the receipt's recipient carries a syntactically valid EVM wallet
 * address — the only thing that can ever make an ERC-8004 token id
 * resolvable, and the only thing EAS can attest to as a real recipient.
 * @param {Object} receipt
 * @returns {boolean}
 */
function hasEvmWallet(receipt) {
  return EVM_ADDRESS.test(receipt.recipient?.wallet_address || '');
}

module.exports = { EVM_ADDRESS, effectiveTokenId, hasEvmWallet };
