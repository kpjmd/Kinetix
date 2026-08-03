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
 *   export SEED_PAYER_KEY=0x...          # a wallet holding USDC on Base
 *   node scripts/seed-okx-receipt.js                          # dry run, premium
 *   node scripts/seed-okx-receipt.js --tier advanced          # dry run, $0.25
 *   node scripts/seed-okx-receipt.js --tier advanced --confirm
 *   node scripts/seed-okx-receipt.js --confirm --no-wait      # pay, poll later
 *
 * Note: `export` puts the key in your shell history. Prefer a leading space
 * (` export SEED_PAYER_KEY=...`) or read it from your password manager.
 *
 * Flags:
 *   --tier basic|advanced|premium   which paid route to buy (default premium)
 *   --duration-days N               commitment window (default 1)
 *   --no-wait                       pay and exit; poll the status route later
 *   --wait-minutes N                how long to poll for a score (default 90)
 *
 * Timing: the commitment window starts at purchase, so only activity *after*
 * this runs counts. Evidence is collected by the monitoring loop in the x402
 * process, so a receipt appears on the first tick after the window closes —
 * within MONITORING_INTERVAL_MINUTES of it, not instantly.
 */

require('dotenv').config();

const { createPublicClient, http, erc20Abi, formatUnits } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm');

const pricingConfig = require('../config/x402-pricing.json');

const DEFAULT_URL = 'https://kinetix-x402-production.up.railway.app';
const NETWORK = 'eip155:8453';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const noWait = args.includes('--no-wait');
const baseUrl = (readFlag('--url') || DEFAULT_URL).replace(/\/$/, '');

const tier = readFlag('--tier') || 'premium';
if (!pricingConfig.tiers[tier]) {
  fail(`Unknown tier "${tier}". Expected one of: ${Object.keys(pricingConfig.tiers).join(', ')}`);
}
// Read from the pricing config rather than a literal, so a tier price change
// cannot make the amount assertion below silently wrong. Prices are strings in
// the config ("1.00"), so coerce before doing arithmetic on them.
const priceUsdc = Number(pricingConfig.tiers[tier].price_usdc);
if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) {
  fail(`Tier "${tier}" has an unusable price: ${pricingConfig.tiers[tier].price_usdc}`);
}
const PRICE_BASE_UNITS = BigInt(Math.round(priceUsdc * 1e6));
const priceLabel = priceUsdc.toFixed(2);

// One day, because the window now has to contain real activity. The old
// default was 0.002 days (~3 minutes), chosen when nothing collected evidence
// and every receipt scored 0 by design. With collection working, a 3-minute
// window catches nothing and buys a `failed` receipt for real money.
const durationDays = Number(readFlag('--duration-days') || 1);
const waitMinutes = Number(readFlag('--wait-minutes') || 90);

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * Wait for the window to close, then poll until a receipt exists.
 *
 * A single check right after expiry is not enough any more. Scoring is
 * deferred until evidence collection has succeeded since the window closed,
 * and that happens on the monitoring loop's own schedule
 * (MONITORING_INTERVAL_MINUTES), so the status route legitimately reports
 * `active` for a while after `monitoring_until` passes.
 *
 * @returns {Promise<string|null>} the receipt id, or null if it never scored
 */
async function pollForReceipt(statusUrl, closesAtMs) {
  const untilClose = Math.max(0, closesAtMs - Date.now());
  if (untilClose > 0) {
    console.log(`\nWindow closes in ${Math.ceil(untilClose / 60000)} min. Waiting...`);
    await new Promise(resolve => setTimeout(resolve, untilClose + 5000));
  }

  const deadline = Date.now() + waitMinutes * 60 * 1000;
  const intervalMs = 60 * 1000;
  console.log(`Window closed. Polling for up to ${waitMinutes} min while the loop collects.`);

  while (Date.now() < deadline) {
    const res = await fetch(statusUrl);
    const status = await res.json();

    if (status.receipt_id) {
      console.log(`✓ Scored: status=${status.status}`);
      return status.receipt_id;
    }

    const mins = Math.ceil((deadline - Date.now()) / 60000);
    console.log(`  status=${status.status} evidence=${status.evidence_count} (${mins} min left)`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return null;
}

async function main() {
  const key = process.env.SEED_PAYER_KEY;
  if (!key) fail('SEED_PAYER_KEY is not set. See the usage note at the top of this file.');
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) fail('SEED_PAYER_KEY must be a 0x-prefixed 64-hex private key.');

  const account = privateKeyToAccount(key);
  console.log(`\nSeeding a receipt on ${baseUrl}`);
  console.log(`Tier:  ${tier} ($${priceLabel} USDC)`);
  console.log(`Payer: ${account.address}`);

  if (tier === 'basic') {
    // The basic route ignores caller criteria and pins its own window.
    console.log(
      `Note:  basic pins duration_days to ${pricingConfig.tiers.basic.max_duration_days}; ` +
      `--duration-days is ignored on this tier.`
    );
  }

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
    fail(`Need at least ${priceLabel} USDC on Base mainnet, have ${formatUnits(balance, 6)}.`);
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
    // giveFeedback is attempted, so this run costs the USDC and no gas.
  };

  // Show the real challenge before spending anything.
  const challengeRes = await fetch(`${baseUrl}/api/x402/verify/${tier}`, {
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
  // Don't assume accepts[0] is Base — the challenge now also carries an
  // X Layer option (OKX AI requirement), so find the Base entry explicitly.
  const option = challenge.accepts.find(a => a.network === NETWORK) || challenge.accepts[0];

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

  const paid = await fetchWithPay(`${baseUrl}/api/x402/verify/${tier}`, {
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

  const statusUrl = `${baseUrl}/api/x402/verify/${commitmentId}/status`;

  if (noWait) {
    console.log('\nNot waiting. Once the window closes, poll:');
    console.log(`  curl -s ${statusUrl}`);
    console.log('Then fetch the receipt with the receipt_id it reports.\n');
    return;
  }

  const receiptId = await pollForReceipt(statusUrl, new Date(body.monitoring_until).getTime());
  if (!receiptId) {
    fail(
      `No receipt after ${waitMinutes} min of polling. The commitment is still ` +
      `live — re-check ${statusUrl} later rather than paying again.`
    );
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
