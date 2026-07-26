#!/usr/bin/env node

/**
 * OKX AI ASP pre-submission check.
 *
 * Exercises the deployed x402 service the way OKX's reviewer and agent clients
 * will: the 402 challenge an agent parses to build a payment, the free
 * endpoints, and the failure modes. OKX fails an entire ASP submission if any
 * single registered service misbehaves, so this runs against the real public
 * URL before registration — the Jest suite covers handler logic, but the 402
 * body is produced by the facilitator-backed middleware and only exists on a
 * live deploy.
 *
 * Read-only: sends no payment and broadcasts no transaction.
 *
 * Usage:
 *   node scripts/okx-preflight-check.js https://kinetix-x402.up.railway.app
 */

const EXPECTED_PAY_TO = process.env.CDP_WALLET_ADDRESS || '0x8c61756f693A321777562433E19B2AabF71f5519';
const EXPECTED_NETWORK = 'eip155:8453';
const EXPECTED_PRICE_USDC = '1.00';
// USDC is 6-decimal, so $1.00 settles as 1000000 base units.
const EXPECTED_AMOUNT_BASE_UNITS = '1000000';
const EXPECTED_USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet USDC

const baseUrl = (process.argv[2] || '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('\nUsage: node scripts/okx-preflight-check.js <base-url>\n');
  process.exit(1);
}

const VALID_PAYLOAD = {
  agent_id: 'agent_preflight_check',
  commitment_description: 'Preflight probe — not a real commitment',
  verification_type: 'consistency',
  criteria: { duration_days: 7, frequency: 'daily', minimum_actions: 7 }
};

const results = [];

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function probe(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    paymentRequired: res.headers.get('payment-required'),
    body,
    text
  };
}

/**
 * Decode the x402 v2 challenge.
 *
 * v2 carries it as base64 JSON in the PAYMENT-REQUIRED response header and
 * leaves the body as `{}` — reading `accepts` off the body silently finds
 * nothing. The body fallback covers older facilitator versions.
 */
function decodeChallenge(res) {
  if (res.paymentRequired) {
    try {
      return JSON.parse(Buffer.from(res.paymentRequired, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  return res.body && Array.isArray(res.body.accepts) ? res.body : null;
}

async function checkHealth() {
  console.log('\nHealth');
  const res = await probe('/health');
  check('GET /health returns 200', res.status === 200, `got ${res.status}`);
  check(
    'reports Base mainnet',
    res.body?.x402_network === EXPECTED_NETWORK,
    `x402_network=${res.body?.x402_network}`
  );
  check(
    'reports the registered ERC-8004 token id',
    res.body?.erc8004_token_id === 16892,
    `erc8004_token_id=${res.body?.erc8004_token_id}`
  );
  check(
    'reports the expected payment wallet',
    (res.body?.wallet || '').toLowerCase() === EXPECTED_PAY_TO.toLowerCase(),
    `wallet=${res.body?.wallet}`
  );
}

async function checkPaymentChallenge() {
  console.log('\n402 challenge (what an agent client parses)');
  const res = await probe('/api/x402/verify/premium', {
    method: 'POST',
    body: JSON.stringify(VALID_PAYLOAD)
  });

  check('unpaid request returns 402', res.status === 402, `got ${res.status}`);
  check('402 body is JSON', res.contentType.includes('application/json'), res.contentType);
  check('PAYMENT-REQUIRED header is present', !!res.paymentRequired, res.paymentRequired ? '' : 'missing');

  const challenge = decodeChallenge(res);
  if (!challenge) {
    check('challenge decodes', false, 'could not parse PAYMENT-REQUIRED or body');
    return;
  }
  check('challenge decodes', true, `x402Version=${challenge.x402Version}`);

  const accepts = challenge.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    check('challenge carries an accepts[] array', false, 'missing or empty');
    return;
  }
  check('challenge carries an accepts[] array', true, `${accepts.length} option(s)`);

  const option = accepts[0];
  check('scheme is "exact"', option.scheme === 'exact', `scheme=${option.scheme}`);
  check('network is Base mainnet', option.network === EXPECTED_NETWORK, `network=${option.network}`);
  check(
    'payTo is the Kinetix payment wallet',
    (option.payTo || '').toLowerCase() === EXPECTED_PAY_TO.toLowerCase(),
    `payTo=${option.payTo}`
  );
  check(
    'asset is Base mainnet USDC',
    (option.asset || '').toLowerCase() === EXPECTED_USDC_ASSET.toLowerCase(),
    `asset=${option.asset}`
  );

  // Field name differs across x402 versions; compare the base-unit value a
  // payer would actually sign rather than the display price.
  const amount = option.amount ?? option.maxAmountRequired;
  check(
    `amount is $${EXPECTED_PRICE_USDC} USDC`,
    String(amount) === EXPECTED_AMOUNT_BASE_UNITS,
    `amount=${amount} (expected ${EXPECTED_AMOUNT_BASE_UNITS})`
  );
}

async function checkAgentContentNegotiation() {
  console.log('\nContent negotiation');
  // A browser-shaped request gets the HTML paywall. Confirms agents asking for
  // JSON are never handed HTML they cannot parse.
  const res = await fetch(`${baseUrl}/api/x402/verify/premium`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    },
    body: JSON.stringify(VALID_PAYLOAD)
  });
  const contentType = res.headers.get('content-type') || '';
  check('browser request still returns 402', res.status === 402, `got ${res.status}`);
  check('browser request gets the HTML paywall', contentType.includes('text/html'), contentType);
}

async function checkFailureModes() {
  console.log('\nFailure modes');

  const garbage = await probe('/api/x402/verify/premium', {
    method: 'POST',
    headers: { 'PAYMENT-SIGNATURE': 'not-a-real-signature', 'X-PAYMENT': 'garbage' },
    body: JSON.stringify(VALID_PAYLOAD)
  });
  check(
    'malformed payment header returns 402, not 500',
    garbage.status === 402,
    `got ${garbage.status}`
  );
  check('malformed payment header response is JSON', garbage.body !== null, garbage.contentType);

  // Free routes must never be caught by the payment middleware.
  const attestation = await probe('/api/v1/attestation/preflight-does-not-exist');
  check(
    'free attestation lookup is not payment-gated',
    attestation.status === 404,
    `got ${attestation.status}${attestation.status === 402 ? ' (payment middleware over-matched)' : ''}`
  );

  const status = await probe('/api/x402/verify/cmt_kx_preflight_missing/status');
  check(
    'free status route is not payment-gated',
    status.status === 404,
    `got ${status.status}${status.status === 402 ? ' (payment middleware over-matched)' : ''}`
  );

  // Malformed body behind the paywall: the payment challenge fires first, so a
  // 402 here is correct and proves the caller is not charged before validation.
  const malformed = await probe('/api/x402/verify/premium', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_PAYLOAD, verification_type: 'fraud' })
  });
  check(
    'malformed payload is rejected without a 500',
    malformed.status !== 500,
    `got ${malformed.status}`
  );
  check(
    'no internal detail leaked in the error body',
    !/ENOENT|\/app\/|node_modules/.test(malformed.text),
    'response body scanned for paths'
  );
}

async function main() {
  console.log(`\nOKX preflight check against ${baseUrl}`);

  await checkHealth();
  await checkPaymentChallenge();
  await checkAgentContentNegotiation();
  await checkFailureModes();

  const failed = results.filter(r => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.log('\nFailed:');
    failed.forEach(f => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    console.log('\nDo not submit to OKX until these pass.\n');
    process.exit(1);
  }

  console.log('\nAll checks passed. Safe to submit for OKX review.\n');
}

main().catch(error => {
  console.error(`\nPreflight check could not complete: ${error.message}\n`);
  process.exit(1);
});
