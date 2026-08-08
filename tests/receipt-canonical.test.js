// tests/receipt-canonical.test.js
// Regression lock on MUTABLE_PATHS — the highest-blast-radius list in this
// repo. Adding a path that already exists on a stored receipt silently
// invalidates every signature and desynchronises every already-submitted
// on-chain hash (ERC-8004 feedbackHash, EAS receiptHash) from the stored
// receipt, neither of which is fixable after the fact — those hashes are
// permanent once submitted on-chain. No live network calls: verifyReceipt is
// pure (it recovers a signer address from the stored signature — it never
// creates its own signer or provider) and canonicalHash is pure.

const fs = require('fs');
const path = require('path');
const attestationService = require('../services/attestation-service');
const { canonicalHash } = require('../utils/receipt-canonical');

// A real, live receipt fetched from the deployed x402 service
// (GET /api/v1/attestation/rcpt_kx_9bdc1566e7d6) — the OKX reviewer receipt.
// It carries its own expected digest (signatures.canonical_hash), so this is
// a stronger check than a hand-built fixture: it fails immediately if this
// repo's canonical serialization has drifted from what actually got signed
// and IPFS-pinned in production.
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'receipt-rcpt_kx_9bdc1566e7d6.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

describe('receipt-canonical MUTABLE_PATHS', () => {
  it('reproduces the stored canonical_hash for a real production receipt', () => {
    expect(canonicalHash(fixture)).toBe(fixture.signatures.canonical_hash);
  });

  it('verifies the real production receipt signature with no key and no network', () => {
    expect(attestationService.verifyReceipt(fixture)).toBe(true);
  });

  it('leaves the hash unchanged when metadata.resolved_erc8004_token_id is set post-issuance', () => {
    // This is the field the P1 fix (reconciliation writing a late-resolved
    // token id) uses instead of mutating recipient.erc8004_token_id. It must
    // be a no-op on every receipt issued before it existed.
    const mutated = JSON.parse(JSON.stringify(fixture));
    mutated.metadata.resolved_erc8004_token_id = '16892';
    mutated.metadata.resolved_erc8004_token_id_at = new Date(0).toISOString();

    expect(canonicalHash(mutated)).toBe(fixture.signatures.canonical_hash);
    expect(attestationService.verifyReceipt(mutated)).toBe(true);
  });

  it('CHANGES the hash when recipient.erc8004_token_id is mutated directly — the bug this fix prevents', () => {
    // Documents why recipient.* must never be written after signing.
    // reconciliation-service.js used to do exactly this.
    const mutated = JSON.parse(JSON.stringify(fixture));
    mutated.recipient.erc8004_token_id = '16892';

    expect(canonicalHash(mutated)).not.toBe(fixture.signatures.canonical_hash);
    expect(attestationService.verifyReceipt(mutated)).toBe(false);
  });

  it('leaves the hash unchanged when eas.* fields are set post-issuance', () => {
    // The whole `eas` object is excluded — this is what makes the universal
    // EAS anchoring changes (eas.recipient, eas.anchor_mode) signature-safe.
    const mutated = JSON.parse(JSON.stringify(fixture));
    mutated.eas = {
      ...mutated.eas,
      status: 'submitted',
      attestation_uid: '0xabc',
      recipient: '0x0000000000000000000000000000000000000000',
      anchor_mode: 'unattributed'
    };

    expect(canonicalHash(mutated)).toBe(fixture.signatures.canonical_hash);
  });

  it('leaves the hash unchanged when metadata.onchain_* tracking fields are set post-issuance', () => {
    const mutated = JSON.parse(JSON.stringify(fixture));
    mutated.metadata.onchain_status = 'submitted';
    mutated.metadata.onchain_tx_hash = '0xdead';
    mutated.metadata.onchain_retry_count = 3;
    mutated.metadata.onchain_submitting_at = new Date(0).toISOString();

    expect(canonicalHash(mutated)).toBe(fixture.signatures.canonical_hash);
  });

  it('CHANGES the hash when a field outside MUTABLE_PATHS is mutated, as a sanity check the lock actually locks something', () => {
    const mutated = JSON.parse(JSON.stringify(fixture));
    mutated.verification_result.overall_score = 1;

    expect(canonicalHash(mutated)).not.toBe(fixture.signatures.canonical_hash);
  });
});
