#!/usr/bin/env node

/**
 * Attach an EVM wallet address (and optionally an ERC-8004 token id) to an
 * existing, not-yet-attested commitment.
 *
 * Why this exists: recipient.wallet_address and recipient.erc8004_token_id
 * are only ever populated from the request body of the four x402 POST routes
 * (and now the free /api/v1/verify route) at commitment-CREATION time. There
 * is no PATCH endpoint, and — since Phase 1 of the on-chain anchoring fixes —
 * recipient.* is frozen the instant a receipt is signed (it is inside the
 * canonical signed payload; see utils/receipt-canonical.js). So the only
 * window in which an operator can attach a missing identity is between
 * commitment creation and scoring. This script is that window's only tool.
 *
 * Dry-run by default. Pass --write to actually save.
 *
 * Usage:
 *   node scripts/attach-agent-identity.js <commitment_id> --wallet 0x...
 *   node scripts/attach-agent-identity.js <commitment_id> --wallet 0x... --token-id 123
 *   node scripts/attach-agent-identity.js <commitment_id> --wallet 0x... --write
 *   node scripts/attach-agent-identity.js <commitment_id> --wallet 0x... --force --write
 *   node scripts/attach-agent-identity.js <commitment_id> --wallet 0x... --resolve-token-id --write
 *
 * Flags:
 *   --wallet <0x...>       Required. EVM address to attach.
 *   --token-id <N>         Optional. ERC-8004 token id to attach directly.
 *   --resolve-token-id     Optional. Look up the token id from the wallet via
 *                          the on-chain IdentityRegistry (utils/erc8004-lookup.js)
 *                          instead of supplying --token-id. NOTE: this writes
 *                          the ERC-8004 lookup cache (data/erc8004/lookup-cache-*.json)
 *                          as a side effect — it is not read-only. Requires
 *                          network access and DEFAULT_NETWORK/NETWORK_ID to be set.
 *   --force                Required to overwrite an already-set, different wallet_address.
 *   --write                Actually save. Without it, this only prints the plan.
 */

require('dotenv').config();
const dataStore = require('../services/data-store');

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const args = process.argv.slice(2);
const commitmentId = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--wallet' && args[args.indexOf(a) - 1] !== '--token-id');
const write = args.includes('--write');
const force = args.includes('--force');
const resolveTokenId = args.includes('--resolve-token-id');

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function main() {
  if (!commitmentId) {
    fail('Usage: node scripts/attach-agent-identity.js <commitment_id> --wallet 0x... [--token-id N] [--force] [--write]');
  }

  const wallet = readFlag('--wallet');
  if (!wallet) fail('--wallet is required (an EVM address, 0x + 40 hex chars).');
  if (!EVM_ADDRESS.test(wallet)) {
    fail(`--wallet "${wallet}" is not a valid EVM address (expected 0x + 40 hex chars).`);
  }

  const rawTokenId = readFlag('--token-id');
  if (rawTokenId !== null && (!/^[0-9]+$/.test(rawTokenId) || Number(rawTokenId) <= 0)) {
    fail(`--token-id "${rawTokenId}" must be a positive integer.`);
  }
  if (rawTokenId !== null && resolveTokenId) {
    fail('Pass either --token-id or --resolve-token-id, not both.');
  }

  const commitment = await dataStore.loadCommitment(commitmentId);
  if (!commitment) {
    fail(`Commitment not found: ${commitmentId}`);
  }

  // The unambiguous "a signed receipt exists" signal — status alone is not,
  // since verification-service.js sets status to the scoring result
  // ('verified'/'partial'/'failed') before it separately sets status to
  // 'attested' once issueAttestation() has actually run and signed the
  // receipt (services/verification-service.js).
  if (commitment.receipt_id) {
    fail(
      `Commitment ${commitmentId} already has receipt ${commitment.receipt_id} — recipient.* was ` +
      `frozen the moment that receipt was signed and cannot be changed. The only post-issuance ` +
      `identity path is metadata.resolved_erc8004_token_id, written automatically by reconciliation ` +
      `once a wallet already on the receipt resolves to a token; there is no path at all for a ` +
      `wallet added after signing. This script can only help before a receipt exists.`
    );
  }

  const existingWallet = commitment.wallet_address || '';
  if (existingWallet && EVM_ADDRESS.test(existingWallet) && existingWallet.toLowerCase() !== wallet.toLowerCase() && !force) {
    fail(
      `Commitment ${commitmentId} already has a different wallet_address (${existingWallet}). ` +
      `Pass --force to overwrite it.`
    );
  }

  // ethers is only required here (not at module load) so the pure "commitment
  // not found" / "already attested" checks above never depend on it being
  // installed correctly, and so a dry-run planning a --token-id attach never
  // touches ethers at all.
  const { ethers } = require('ethers');
  let checksummedWallet;
  try {
    checksummedWallet = ethers.getAddress(wallet);
  } catch (error) {
    fail(`--wallet "${wallet}" failed EIP-55 checksum validation: ${error.message}`);
  }

  let tokenId = rawTokenId;
  if (resolveTokenId) {
    console.log(`\nResolving ERC-8004 token id for ${checksummedWallet} via the on-chain IdentityRegistry...`);
    console.log('(This writes the ERC-8004 lookup cache as a side effect — not read-only.)');
    const erc8004Lookup = require('../utils/erc8004-lookup');
    const { resolveNetwork } = require('../utils/network');
    const network = resolveNetwork();
    tokenId = await erc8004Lookup.resolveTokenId(checksummedWallet, network);
    if (!tokenId) {
      console.log(`No registered ERC-8004 token found for ${checksummedWallet} on ${network}. Proceeding with wallet only.`);
    } else {
      console.log(`Resolved token id: ${tokenId}`);
    }
  }

  // Kinetix's own signing wallet would trip SELF_VERIFICATION on the ERC-8004
  // leg (utils/erc8004-reputation.js isSelfVerification) — legitimate for a
  // deliberate self-check, but worth flagging rather than attaching silently.
  try {
    const { createSigner } = require('../utils/signing-key');
    const kinetixAddress = createSigner().address;
    if (kinetixAddress.toLowerCase() === checksummedWallet.toLowerCase()) {
      console.log(
        `\n⚠️  ${checksummedWallet} is Kinetix's own signing wallet. The ERC-8004 leg will be ` +
        `skipped as self-verification (SELF_VERIFICATION) — this is only correct if that is intended.`
      );
    }
  } catch (error) {
    // No signing key configured in this environment — nothing to compare
    // against, and this check is advisory only. Not fatal.
  }

  const before = {
    wallet_address: commitment.wallet_address || '',
    erc8004_token_id: commitment.erc8004_token_id || null
  };
  const after = {
    wallet_address: checksummedWallet,
    erc8004_token_id: tokenId !== null && tokenId !== undefined ? String(tokenId) : before.erc8004_token_id
  };

  console.log(`\nCommitment: ${commitmentId}`);
  console.log(`  agent_id: ${commitment.agent_id}`);
  console.log(`  status:   ${commitment.status}`);
  console.log(`  end_date: ${commitment.end_date || 'n/a'}`);
  if (commitment.end_date) {
    const daysLeft = (new Date(commitment.end_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    console.log(`  time remaining: ${daysLeft > 0 ? `${daysLeft.toFixed(2)} days` : 'already ended — scoring may run at any time'}`);
  }
  console.log(`\nPlanned change:`);
  console.log(`  wallet_address:     ${JSON.stringify(before.wallet_address)} -> ${JSON.stringify(after.wallet_address)}`);
  console.log(`  erc8004_token_id:   ${JSON.stringify(before.erc8004_token_id)} -> ${JSON.stringify(after.erc8004_token_id)}`);

  if (!write) {
    console.log(`\nDry run — nothing written. Re-run with --write to apply.`);
    console.log(
      `\nReminder: generateReceipt() reads these fields at issuance (services/attestation-service.js). ` +
      `Once the commitment window ends and scoring runs, this script can no longer help — the receipt ` +
      `will already be signed with whatever identity was on the commitment at that moment.\n`
    );
    return;
  }

  commitment.wallet_address = after.wallet_address;
  if (after.erc8004_token_id !== null) {
    commitment.erc8004_token_id = after.erc8004_token_id;
  }
  await dataStore.saveCommitment(commitment);

  console.log(`\n✓ Saved.\n`);
}

main().catch(error => {
  fail(error.message);
});
