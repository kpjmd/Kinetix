// /utils/receipt-canonical.js
// One canonical, immutable representation of a receipt — the single thing the
// Kinetix signature and BOTH on-chain hashes (EAS receiptHash, ERC-8004
// feedbackHash) commit to.
//
// Why this exists: fields that are filled in AFTER a receipt is signed (the
// signature block itself, on-chain tracking status/tx hash/retry counters, IPFS
// URIs, EAS metadata) must be excluded from the hashed payload. Otherwise:
//   - the signature stops verifying against the stored receipt the moment any
//     of those fields mutate (which they do on every on-chain step), and
//   - the EAS/ERC-8004 hashes — previously keccak of insertion-order
//     JSON.stringify(receipt) at submission time — are not reproducible from
//     the stored receipt and differ from each other.
// Hashing this canonical payload everywhere makes all three reproducible and
// mutually consistent.

const { ethers } = require('ethers');

// Post-issuance mutable fields, by path. Excluded from the canonical payload.
//
// recipient.* is deliberately NOT here. attestation-service.js writes it once
// at signing time and nothing may touch it after: reconciliation-service.js
// used to write a late-resolved recipient.erc8004_token_id directly, which
// silently invalidated the signature (recipient IS in the signed payload) and
// desynchronised the already-submitted/pinned on-chain hashes from the stored
// receipt. A late-resolved token id now lands in metadata.resolved_erc8004_token_id
// instead (see utils/receipt-identity.js effectiveTokenId) — a brand-new key
// absent on every receipt written before this change, so adding it here does
// not alter any existing receipt's canonical hash (delete on an absent key is
// a no-op). Do not add ['recipient', 'erc8004_token_id'] to this list — that
// key is written (possibly as null) on every receipt already issued, so
// excluding it would change every existing canonical hash and invalidate
// every stored signature.
const MUTABLE_PATHS = [
  ['signatures'],
  ['metadata', 'onchain_status'],
  ['metadata', 'onchain_retry_count'],
  ['metadata', 'onchain_tx_hash'],
  ['metadata', 'onchain_submitting_at'],
  ['metadata', 'resolved_erc8004_token_id'],
  ['metadata', 'resolved_erc8004_token_id_at'],
  ['reputation_context', 'ipfs_uri'],
  ['reputation_context', 'submission_index'],
  ['reputation_context', 'submitted_at'],
  ['eas']
];

// Recursively sort object keys for deterministic serialization.
function _sortedStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => _sortedStringify(item));
  }
  const sorted = {};
  Object.keys(obj).sort().forEach(key => {
    sorted[key] = _sortedStringify(obj[key]);
  });
  return sorted;
}

/**
 * The canonical immutable object for a receipt: a deep copy with all
 * post-issuance mutable fields removed and keys recursively sorted.
 */
function canonicalObject(receipt) {
  const clone = JSON.parse(JSON.stringify(receipt));
  for (const parts of MUTABLE_PATHS) {
    let node = clone;
    for (let i = 0; i < parts.length - 1 && node; i++) {
      node = node[parts[i]];
    }
    if (node && typeof node === 'object') {
      delete node[parts[parts.length - 1]];
    }
  }
  return _sortedStringify(clone);
}

/** Deterministic canonical JSON string. */
function canonicalString(receipt) {
  return JSON.stringify(canonicalObject(receipt));
}

/** keccak256 of the canonical string (bytes32) — used for on-chain hashes. */
function canonicalHash(receipt) {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalString(receipt)));
}

module.exports = { canonicalObject, canonicalString, canonicalHash, MUTABLE_PATHS };
