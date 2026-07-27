#!/usr/bin/env node

/**
 * Seed one real verification receipt on the deployed x402 service.
 *
 * OKX reviewers are given `GET /api/v1/attestation/:receipt_id` as a free
 * service. That endpoint is only meaningful if at least one receipt exists on
 * the deployed volume, and the only way to create a commitment is to pay for
 * one. This script performs that single paid call and then retrieves the
 * resulting receipt.
 *
 * SPENDS REAL MONEY. Dry-run by default: without --confirm it fetches the
 * payment challenge, shows exactly what would be paid, and exits without
 * signing anything.
 *
 * The payer signs an EIP-3009 authorization; the resource server's facilitator
 * broadcasts the transfer. The payer therefore needs USDC but does NOT need
 * ETH for gas.
 *
 * Usage:
 *   export SEED_PAYER_KEY=0x...          # a wallet holding >= 1 USDC on Base
 *   node scripts/seed-okx-receipt.js                     # dry run
 *   node scripts/seed-okx-receipt.js --confirm           # actually pay
 *
 * Note: `export` puts the key in your shell history. Prefer a leading space
 * (` export SEED_PAYER_KEY=...`) or read it from your password manager.
 */

require('dotenv').config();

const { createPublicClient, http, erc20Abi, formatUnits } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm');

const DEFAULT_URL = 'https://kinetix-x402-production.up.railway.app';
const NETWORK = 'eip155:8453';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_BASE_UNITS = 1000000n; // $1.00, USDC has 6 decimals

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const baseUrl = (readFlag('--url') || DEFAULT_URL).replace(/\/$/, '');
// Short by default so the receipt materializes in minutes rather than days.
// Scoring runs when the window closes; nothing collects evidence on this
// service, so the receipt will legitimately score 0 / failed.
const durationDays = Number(readFlag('--duration-days') || 0.002);

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function main() {
  const key = process.env.SEED_PAYER_KEY;
  if (!key) fail('SEED_PAYER_KEY is not set. See the usage note at the top of this file.');
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) fail('SEED_PAYER_KEY must be a 0x-prefixed 64-hex private key.');

  const account = privateKeyToAccount(key);
  console.log(`\nSeeding a receipt on ${baseUrl}`);
  console.log(`Payer: ${account.address}`);

  if (account.address.toLowerCase() === '0x8c61756f693a321777562433e19b2aabf71f5519') {
    fail('That is the Kinetix payTo wallet. Pay from a different wallet.');
  }

  // Read-only balance check, so a run cannot fail after signing.
  const rpc = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
  const publicClient = createPublicClient({ chain: base, transport: http(rpc) });
  const balance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address]
  });
  console.log(`USDC balance: ${formatUnits(balance, 6)}`);
  // Only fatal when actually paying, so a dry run still shows the challenge.
  if (balance < PRICE_BASE_UNITS && confirmed) {
    fail(`Need at least 1.00 USDC on Base mainnet, have ${formatUnits(balance, 6)}.`);
  }

  const payload = {
    agent_id: 'kinetix_okx_listing_probe',
    commitment_description:
      'Reference verification issued to seed the Kinetix OKX AI listing. Demonstrates the full receipt format.',
    verification_type: 'consistency',
    // clawstr + Kinetix's own npub: the only platform whose collector can
    // attribute evidence to one agent, and an identity with real posting
    // history, so the seeded receipt scores on merit rather than on zero.
    platform: readFlag('--platform') || 'clawstr',
    platform_handle: readFlag('--handle') || 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5',
    // minimum_actions is derived from duration x frequency when omitted.
    criteria: { duration_days: durationDays, frequency: 'daily' }
    // erc8004_token_id deliberately omitted: without it no on-chain
    // giveFeedback is attempted, so this run costs the $1 USDC and no gas.
  };

  // Show the real challenge before spending anything.
  const challengeRes = await fetch(`${baseUrl}/api/x402/verify/premium`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (challengeRes.status !== 402) {
    fail(`Expected a 402 payment challenge, got ${challengeRes.status}.`);
  }
  const challenge = JSON.parse(
    Buffer.from(challengeRes.headers.get('payment-required'), 'base64').toString('utf8')
  );
  const option = challenge.accepts[0];

  console.log('\nPayment challenge:');
  console.log(`  amount:  ${formatUnits(BigInt(option.amount), 6)} USDC`);
  console.log(`  asset:   ${option.asset}`);
  console.log(`  payTo:   ${option.payTo}`);
  console.log(`  network: ${option.network}`);
  console.log(`  window:  ${durationDays} days (~${Math.round(durationDays * 24 * 60)} min)`);

  if (option.network !== NETWORK) fail(`Unexpected network ${option.network}.`);
  if (option.asset.toLowerCase() !== USDC.toLowerCase()) fail(`Unexpected asset ${option.asset}.`);
  if (BigInt(option.amount) !== PRICE_BASE_UNITS) fail(`Unexpected amount ${option.amount}.`);

  if (!confirmed) {
    console.log('\nDry run — nothing signed, nothing spent.');
    console.log('Re-run with --confirm to pay.\n');
    return;
  }

  console.log('\nPaying...');
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const paid = await fetchWithPay(`${baseUrl}/api/x402/verify/premium`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await paid.json();
  if (paid.status !== 200) {
    fail(`Payment succeeded but the service returned ${paid.status}: ${JSON.stringify(body)}`);
  }

  const commitmentId = body.commitment_id;
  console.log(`✓ Paid. Commitment: ${commitmentId}`);
  console.log(`  Monitoring until: ${body.monitoring_until}`);

  // Scoring is triggered by the status route once the window closes.
  const closesAt = new Date(body.monitoring_until).getTime();
  const waitMs = Math.max(0, closesAt - Date.now()) + 5000;
  console.log(`\nWaiting ${Math.ceil(waitMs / 1000)}s for the window to close...`);
  await new Promise(resolve => setTimeout(resolve, waitMs));

  const statusRes = await fetch(`${baseUrl}/api/x402/verify/${commitmentId}/status`);
  const status = await statusRes.json();
  const receiptId = status.receipt_id;
  console.log(`✓ Scored: status=${status.status}`);

  if (!receiptId) {
    console.log('\nNo receipt_id on the status response. Full status:');
    console.log(JSON.stringify(status, null, 2));
    fail('Could not determine the receipt id.');
  }

  const receiptRes = await fetch(`${baseUrl}/api/v1/attestation/${receiptId}`);
  if (receiptRes.status !== 200) {
    fail(`Receipt ${receiptId} was not retrievable (${receiptRes.status}).`);
  }
  const receipt = await receiptRes.json();

  // Verify the signature the same way a counterparty would, rather than
  // asserting the receipt is valid because we just issued it.
  const attestationService = require('../services/attestation-service');
  let verified = false;
  try {
    verified = attestationService.verifyReceipt(receipt);
  } catch (error) {
    console.warn(`  (signature check could not run: ${error.message})`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('Receipt is live and retrievable without payment:');
  console.log(`  ${baseUrl}/api/v1/attestation/${receiptId}`);
  console.log('─────────────────────────────────────────────');
  console.log(`  receipt_id:  ${receiptId}`);
  console.log(`  score:       ${receipt.verification_result?.overall_score}`);
  console.log(`  status:      ${receipt.verification_result?.status}`);
  console.log(`  signature:   ${receipt.signatures?.kinetix_signature ? 'present' : 'MISSING'}`);
  console.log(`  verifies:    ${verified ? 'yes' : 'NO'}`);
  console.log(`  issuer:      ${receipt.issuer?.pubkey}`);
  console.log(`  ipfs:        ${receipt.reputation_context?.ipfs_uri || 'not pinned'}`);
  console.log(`  eas:         ${receipt.eas?.status}`);

  if (!verified) {
    fail('Receipt signature did not verify — do not hand this to a reviewer.');
  }
  console.log('\nGive that URL to the OKX reviewer.\n');
}

main().catch(error => {
  fail(error.message);
});
