#!/usr/bin/env node

/**
 * Read-only audit of on-chain readiness across all commitments and receipts.
 *
 * Answers, before any code changes ship: how many in-flight commitments carry
 * an EVM identity that will let their receipt anchor on-chain, how many are
 * Nostr-only and will not, and how many already-issued receipts are currently
 * skipped or stuck — plus a signature/canonical-hash integrity check on every
 * stored receipt.
 *
 * HARD CONSTRAINTS — do not relax these without re-reading why they're here:
 *   - No writes to DATA_DIR, ever. Uses only dataStore.listCommitments() /
 *     listAttestations() (read-only) and attestationService.verifyReceipt()
 *     (pure — no signer, no network).
 *   - No network calls. Do NOT require utils/erc8004-reputation or
 *     utils/eas-attestation here — both build a signer/provider on
 *     initialize(), and erc8004-reputation.initialize() throws
 *     ISSUER_NOT_REGISTERED on a volume without the identity file, which
 *     would make this script fail exactly when it's most useful (a broken
 *     service). Do NOT add a --resolve flag that calls
 *     erc8004Lookup.resolveTokenId() — that writes the lookup cache via
 *     dataStore.saveERC8004LookupCache(). This script must stay read-only.
 *
 * Run this INSIDE the target Railway service (`railway ssh`), not via
 * `railway run` — `railway run` injects the service's env vars (including
 * DATA_DIR=/data) but executes the command on your local machine, where
 * /data does not exist. Because listCommitments/listAttestations swallow
 * ENOENT and return [], that failure mode looks exactly like "zero
 * commitments" instead of an error. The volume guard below exists to catch
 * this before it produces a false "all clear".
 *
 * There are two Railway services (bot + x402) with separate volumes and
 * disjoint receipt populations (see docs/RAILWAY or the topology note in
 * memory) — run this in both and do not assume one service's numbers apply
 * to the other.
 *
 * Usage:
 *   node scripts/audit-onchain-readiness.js
 *   node scripts/audit-onchain-readiness.js --json
 *   node scripts/audit-onchain-readiness.js --receipt rcpt_kx_xxxxx
 *   node scripts/audit-onchain-readiness.js --commitment cmt_kx_xxxxx
 *   node scripts/audit-onchain-readiness.js --verbose
 *
 * Exit codes: 0 clean, 1 a receipt failed signature/hash verification,
 * 2 the environment looks wrong (DATA_DIR unreadable).
 */

const fs = require('fs').promises;
const path = require('path');

const dataStore = require('../services/data-store');
const attestationService = require('../services/attestation-service');
const { canonicalHash } = require('../utils/receipt-canonical');

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const verbose = args.includes('--verbose');
const onlyReceipt = readFlag('--receipt');
const onlyCommitment = readFlag('--commitment');

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function log(...a) {
  if (!asJson) console.log(...a);
}

/**
 * Classify a commitment/receipt's identity into one of five buckets, using
 * the exact same EVM_ADDRESS test attestation-service.js uses to decide
 * whether wallet_address survives into a signed receipt.
 */
function classifyIdentity({ wallet_address, erc8004_token_id }) {
  const hasWallet = EVM_ADDRESS.test(wallet_address || '');
  const hasToken = !!erc8004_token_id;
  if (hasWallet && hasToken) return 'evm+token';
  if (hasWallet) return 'evm_only';
  if (hasToken) return 'token_only';
  return 'none'; // may still be nostr_only at the pubkey level; refined below
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const ms = new Date(isoDate).getTime() - Date.now();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

async function assertVolumeReadable() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
  const commitmentsDir = path.join(dataDir, 'commitments');
  const attestationsDir = path.join(dataDir, 'attestations');

  const results = await Promise.allSettled([
    fs.stat(commitmentsDir),
    fs.stat(attestationsDir)
  ]);

  const commitmentsOk = results[0].status === 'fulfilled';
  const attestationsOk = results[1].status === 'fulfilled';

  if (!commitmentsOk && !attestationsOk) {
    console.error(`\n✗ Neither commitments/ nor attestations/ exists under DATA_DIR.`);
    console.error(`  Resolved DATA_DIR: ${dataDir}`);
    console.error(`  This usually means the script is running OUTSIDE the Railway`);
    console.error(`  service. \`railway run\` injects env vars (DATA_DIR=/data) but`);
    console.error(`  executes locally, where /data does not exist — and this repo's`);
    console.error(`  data-store treats a missing directory as "zero records", not`);
    console.error(`  an error, so that failure mode looks like a clean empty audit.`);
    console.error(`  Use \`railway ssh\` and run this script inside the service instead.\n`);
    process.exit(2);
  }

  // One missing directory alone (e.g. a service that has issued
  // commitments but no receipts yet) is a legitimate state — warn, don't abort.
  if (!commitmentsOk) log(`  (note: commitments/ not found at ${commitmentsDir} — treating as empty)`);
  if (!attestationsOk) log(`  (note: attestations/ not found at ${attestationsDir} — treating as empty)`);

  return { dataDir };
}

async function main() {
  const { dataDir } = await assertVolumeReadable();
  log(`Auditing DATA_DIR=${dataDir}\n`);

  let commitments = await dataStore.listCommitments();
  let attestations = await dataStore.listAttestations();

  if (onlyCommitment) commitments = commitments.filter(c => c.commitment_id === onlyCommitment);
  if (onlyReceipt) attestations = attestations.filter(r => r.receipt_id === onlyReceipt);

  // ---- Commitments ----
  const commitmentRows = commitments.map(c => {
    const identity_class = classifyIdentity(c);
    const nostrOnly = identity_class === 'none' && !!(c.pubkey || c.platform_profiles?.clawstr);
    return {
      commitment_id: c.commitment_id,
      agent_id: c.agent_id,
      status: c.status,
      end_date: c.end_date || null,
      days_until_due: daysUntil(c.end_date),
      identity_class: nostrOnly ? 'nostr_only' : identity_class,
      receipt_id: c.receipt_id || null,
      frozen: !!c.receipt_id
    };
  });

  const inFlight = commitmentRows.filter(c => c.status !== 'attested');

  // ---- Attestations ----
  // attestationService.verifyReceipt() logs unconditionally via console.log
  // (AttestationService._log). In --json mode that would interleave plain-text
  // log lines into what must be parseable JSON on stdout, so silence
  // console.log for the duration of this loop only.
  const realConsoleLog = console.log;
  if (asJson) console.log = () => {};
  const attestationRows = attestations.map(r => {
    const hasWallet = EVM_ADDRESS.test(r.recipient?.wallet_address || '');
    const hasToken = !!r.recipient?.erc8004_token_id;
    let signature_ok = false;
    let canonical_hash_matches = false;
    try {
      signature_ok = attestationService.verifyReceipt(r);
    } catch (e) {
      signature_ok = false;
    }
    try {
      canonical_hash_matches = canonicalHash(r) === r.signatures?.canonical_hash;
    } catch (e) {
      canonical_hash_matches = false;
    }
    return {
      receipt_id: r.receipt_id,
      agent_id: r.recipient?.agent_id,
      issued_at: r.metadata?.issued_at || null,
      onchain_status: r.metadata?.onchain_status || 'unknown',
      onchain_retry_count: r.metadata?.onchain_retry_count || 0,
      eas_status: r.eas?.status || 'NO_EAS_BLOCK',
      eas_anchor_mode: r.eas?.anchor_mode || null,
      has_ipfs: !!r.reputation_context?.ipfs_uri,
      has_wallet: hasWallet,
      has_token: hasToken,
      signature_ok,
      canonical_hash_matches
    };
  });
  if (asJson) console.log = realConsoleLog;

  // ---- Summary ----
  const byClass = {};
  for (const c of inFlight) byClass[c.identity_class] = (byClass[c.identity_class] || 0) + 1;
  const dueWithin7 = inFlight.filter(c => c.days_until_due !== null && c.days_until_due <= 7).length;

  const willAnchorEasNow = inFlight.filter(c => c.identity_class === 'evm_only' || c.identity_class === 'evm+token').length;
  const willAnchorEasAfterFix = inFlight.length; // zero-address fallback anchors every receipt

  const tokenAlready = inFlight.filter(c => c.identity_class === 'evm+token' || c.identity_class === 'token_only').length;
  const tokenResolvable = inFlight.filter(c => c.identity_class === 'evm_only').length;
  const tokenImpossible = inFlight.filter(c => c.identity_class === 'nostr_only' || c.identity_class === 'none').length;

  const onchainStatusHist = {};
  const easStatusHist = {};
  let sigFailures = 0;
  let hashFailures = 0;
  for (const r of attestationRows) {
    onchainStatusHist[r.onchain_status] = (onchainStatusHist[r.onchain_status] || 0) + 1;
    easStatusHist[r.eas_status] = (easStatusHist[r.eas_status] || 0) + 1;
    if (!r.signature_ok) sigFailures++;
    if (!r.canonical_hash_matches) hashFailures++;
  }

  const burstEstimate = attestationRows.filter(
    r => r.eas_status === 'skipped_no_wallet' || r.eas_status === 'NO_EAS_BLOCK'
  ).length;

  const summary = {
    dataDir,
    commitments: {
      total: commitmentRows.length,
      in_flight: inFlight.length,
      by_identity_class: byClass,
      due_within_7_days: dueWithin7
    },
    eas_anchoring: {
      now: `${willAnchorEasNow}/${inFlight.length}`,
      after_zero_address_fallback: `${willAnchorEasAfterFix}/${inFlight.length}`
    },
    erc8004: {
      token_already_present: tokenAlready,
      resolvable_from_wallet: tokenResolvable,
      impossible_no_wallet: tokenImpossible
    },
    attestations: {
      total: attestationRows.length,
      onchain_status_histogram: onchainStatusHist,
      eas_status_histogram: easStatusHist,
      burst_estimate_next_eas_fix_deploy: burstEstimate
    },
    signatures: {
      verify_ok: `${attestationRows.length - sigFailures}/${attestationRows.length}`,
      canonical_hash_ok: `${attestationRows.length - hashFailures}/${attestationRows.length}`,
      failures: sigFailures,
      hash_mismatches: hashFailures
    }
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, commitments: commitmentRows, attestations: attestationRows }, null, 2));
  } else {
    console.log('=== Commitments ===');
    console.log(`Total: ${commitmentRows.length}  In-flight: ${inFlight.length}  Due within 7 days: ${dueWithin7}`);
    console.log('By identity class (in-flight only):');
    for (const [k, v] of Object.entries(byClass)) console.log(`  ${k.padEnd(12)} ${v}`);

    if (verbose) {
      console.log('\nCommitment detail:');
      for (const c of commitmentRows) {
        console.log(`  ${c.commitment_id}  ${c.status.padEnd(10)} ${c.identity_class.padEnd(10)} due=${c.days_until_due ?? 'n/a'}d  ${c.frozen ? '[FROZEN]' : ''}`);
      }
    }

    console.log('\n=== EAS anchoring ===');
    console.log(`  Now (code as of today):        ${summary.eas_anchoring.now}`);
    console.log(`  After zero-address fallback:   ${summary.eas_anchoring.after_zero_address_fallback}`);

    console.log('\n=== ERC-8004 ===');
    console.log(`  Token already present: ${tokenAlready}`);
    console.log(`  Resolvable from wallet: ${tokenResolvable}`);
    console.log(`  Impossible (no wallet, no token): ${tokenImpossible}`);

    console.log('\n=== Attestations ===');
    console.log(`Total: ${attestationRows.length}`);
    console.log('onchain_status:');
    for (const [k, v] of Object.entries(onchainStatusHist)) console.log(`  ${k.padEnd(24)} ${v}`);
    console.log('eas.status:');
    for (const [k, v] of Object.entries(easStatusHist)) console.log(`  ${k.padEnd(24)} ${v}`);
    console.log(`\nBurst estimate (extra EAS txs the zero-address fix will queue): ${burstEstimate}`);

    if (verbose) {
      console.log('\nAttestation detail:');
      for (const r of attestationRows) {
        console.log(`  ${r.receipt_id}  onchain=${r.onchain_status.padEnd(22)} eas=${r.eas_status.padEnd(18)} sig=${r.signature_ok ? 'ok' : 'FAIL'} hash=${r.canonical_hash_matches ? 'ok' : 'FAIL'}`);
      }
    }

    console.log('\n=== Signature integrity ===');
    console.log(`  verifyReceipt():      ${summary.signatures.verify_ok}`);
    console.log(`  canonical hash match: ${summary.signatures.canonical_hash_ok}`);
    if (sigFailures > 0 || hashFailures > 0) {
      console.log(`\n  ⚠️  ${sigFailures} signature failure(s), ${hashFailures} canonical-hash mismatch(es).`);
      console.log('  Failing receipts:');
      for (const r of attestationRows) {
        if (!r.signature_ok || !r.canonical_hash_matches) {
          console.log(`    ${r.receipt_id}  sig=${r.signature_ok}  hash=${r.canonical_hash_matches}`);
        }
      }
    }
  }

  if (sigFailures > 0 || hashFailures > 0) process.exit(1);
  process.exit(0);
}

main().catch(error => {
  console.error(`\n✗ Audit failed: ${error.message}`);
  console.error(error.stack);
  process.exit(2);
});
