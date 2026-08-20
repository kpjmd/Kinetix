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

// OKX AI's facilitator only settles on X Layer — this is the exact network
// OKX rejected Kinetix's first submission for not declaring. Same $1.00 in
// USD₮0 (6-decimal), so the base-unit amount matches Base's.
const EXPECTED_X_LAYER_NETWORK = 'eip155:196';
const EXPECTED_X_LAYER_ASSET = '0x779dED0c9e1022225f8E0630b35a9b54bE713736'; // USD₮0
const EXPECTED_X_LAYER_AMOUNT = '1000000';
const EXPECTED_X_LAYER_PAY_TO = process.env.X_LAYER_PAY_TO || '0x68fb2f902ecdff17f715ffa487a9eb94d2460f5e';

const baseUrl = (process.argv[2] || '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('\nUsage: node scripts/okx-preflight-check.js <base-url>\n');
  process.exit(1);
}

const VALID_PAYLOAD = {
  agent_id: 'agent_preflight_check',
  commitment_description: 'Preflight probe — not a real commitment',
  verification_type: 'consistency',
  platform: 'clawstr',
  // A real npub: the service bech32-decodes the handle and 400s a placeholder.
  platform_handle: 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5',
  criteria: { duration_days: 7, frequency: 'daily', minimum_actions: 7 }
};

// All three paid tiers. Historically only premium was probed here, which is
// part of why a GET-404 on every one of them went unnoticed for seven review
// rounds — premium is the tier registered with OKX, but the others share its
// wiring and regress together.
const TIERS = [
  { path: '/api/x402/verify/basic', label: 'basic' },
  { path: '/api/x402/verify/advanced', label: 'advanced' },
  { path: '/api/x402/verify/premium', label: 'premium' }
];

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
    'reports X Layer alongside Base (OKX requirement)',
    Array.isArray(res.body?.x402_networks) && res.body.x402_networks.includes(EXPECTED_X_LAYER_NETWORK),
    `x402_networks=${JSON.stringify(res.body?.x402_networks)}`
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

  // Don't assume accepts[0] is any particular network — find each option
  // explicitly, since ordering is an implementation detail, not a contract.
  const xLayerOption = accepts.find(a => a.network === EXPECTED_X_LAYER_NETWORK);
  const baseOption = accepts.find(a => a.network === EXPECTED_NETWORK);

  // This is exactly what OKX's first review rejected on — if this fails,
  // do not resubmit.
  check(
    'challenge includes eip155:196 (OKX requirement)',
    !!xLayerOption,
    xLayerOption ? '' : 'missing — this is exactly what OKX rejected the first submission on'
  );
  if (xLayerOption) {
    check('X Layer scheme is "exact"', xLayerOption.scheme === 'exact', `scheme=${xLayerOption.scheme}`);
    check(
      'X Layer payTo is the OKX Agentic Wallet',
      (xLayerOption.payTo || '').toLowerCase() === EXPECTED_X_LAYER_PAY_TO.toLowerCase(),
      `payTo=${xLayerOption.payTo}`
    );
    check(
      'X Layer asset is USD₮0',
      (xLayerOption.asset || '').toLowerCase() === EXPECTED_X_LAYER_ASSET.toLowerCase(),
      `asset=${xLayerOption.asset}`
    );
    const xLayerAmount = xLayerOption.amount ?? xLayerOption.maxAmountRequired;
    check(
      `X Layer amount is $${EXPECTED_PRICE_USDC} USD₮0`,
      String(xLayerAmount) === EXPECTED_X_LAYER_AMOUNT,
      `amount=${xLayerAmount} (expected ${EXPECTED_X_LAYER_AMOUNT})`
    );
  }

  check(
    'challenge still includes eip155:8453 (existing Base callers)',
    !!baseOption,
    baseOption ? '' : 'missing'
  );
  if (baseOption) {
    check('Base scheme is "exact"', baseOption.scheme === 'exact', `scheme=${baseOption.scheme}`);
    check(
      'Base payTo is the Kinetix payment wallet',
      (baseOption.payTo || '').toLowerCase() === EXPECTED_PAY_TO.toLowerCase(),
      `payTo=${baseOption.payTo}`
    );
    check(
      'Base asset is Base mainnet USDC',
      (baseOption.asset || '').toLowerCase() === EXPECTED_USDC_ASSET.toLowerCase(),
      `asset=${baseOption.asset}`
    );
    // Field name differs across x402 versions; compare the base-unit value a
    // payer would actually sign rather than the display price.
    const baseAmount = baseOption.amount ?? baseOption.maxAmountRequired;
    check(
      `Base amount is $${EXPECTED_PRICE_USDC} USDC`,
      String(baseAmount) === EXPECTED_AMOUNT_BASE_UNITS,
      `amount=${baseAmount} (expected ${EXPECTED_AMOUNT_BASE_UNITS})`
    );
  }

  // Caught a real bug this way once already: the Bazaar discovery example
  // advertised platform "moltbook" while the adjacent schema only allowed
  // "clawstr" — a usage example that would 400 if anyone actually tried it.
  // OKX's ASP review rejected the listing twice for "missing... usage
  // examples" before this was found, so this stays a permanent check.
  // schema is a sibling of info under extensions.bazaar, not nested inside it.
  const discoveryBody = challenge.extensions?.bazaar?.info?.input?.body;
  const allowedPlatforms = challenge.extensions?.bazaar?.schema
    ?.properties?.input?.properties?.body?.properties?.platform?.enum;
  check(
    'Bazaar discovery example is present',
    !!discoveryBody,
    discoveryBody ? '' : 'missing extensions.bazaar.info.input.body'
  );
  check(
    'Bazaar discovery schema declares an allowed-platform enum',
    Array.isArray(allowedPlatforms) && allowedPlatforms.length > 0,
    `allowedPlatforms=${JSON.stringify(allowedPlatforms)}`
  );
  if (discoveryBody && Array.isArray(allowedPlatforms)) {
    check(
      'Bazaar discovery example uses a platform its own schema allows',
      allowedPlatforms.includes(discoveryBody.platform),
      `example platform=${discoveryBody.platform}, schema allows=${JSON.stringify(allowedPlatforms)}`
    );
  }
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

  // Malformed body behind the paywall: parameter validation now runs before
  // the 402 challenge is ever built, so this must be a 400, not a 402 — OKX's
  // ASP review flagged that the previous ordering made buyers sign a payment
  // authorization before finding out their request was invalid.
  const malformed = await probe('/api/x402/verify/premium', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_PAYLOAD, verification_type: 'fraud' })
  });
  check(
    'malformed payload is rejected with 400 before the payment challenge',
    malformed.status === 400,
    `got ${malformed.status}`
  );
  check(
    'no internal detail leaked in the error body',
    !/ENOENT|\/app\/|node_modules/.test(malformed.text),
    'response body scanned for paths'
  );
}

/**
 * Parameter validation must complete before the 402 challenge is issued.
 *
 * OKX's ASP review rejected this listing because a buyer was made to sign a
 * payment authorization before the service ever checked whether the request
 * was valid. This proves the fix across all three paid tiers — basic and
 * advanced are otherwise untested in this script — by sending a request with
 * a missing required field and no payment header, and asserting the response
 * is a plain 400 with no PAYMENT-REQUIRED header and no decodable challenge.
 */
async function checkPreValidation() {
  console.log('\nParameter validation before the payment challenge');

  const basicPayload = { platform: 'clawstr', platform_handle: VALID_PAYLOAD.platform_handle }; // missing agent_id
  const advancedPayload = {
    commitment_description: VALID_PAYLOAD.commitment_description,
    platform: 'clawstr',
    platform_handle: VALID_PAYLOAD.platform_handle,
    criteria: { duration_days: 7, frequency: 'daily' }
  }; // missing agent_id
  const { agent_id, ...premiumPayload } = VALID_PAYLOAD; // missing agent_id

  const cases = [
    { path: '/api/x402/verify/basic', payload: basicPayload, label: 'basic' },
    { path: '/api/x402/verify/advanced', payload: advancedPayload, label: 'advanced' },
    { path: '/api/x402/verify/premium', payload: premiumPayload, label: 'premium' }
  ];

  for (const { path, payload, label } of cases) {
    const res = await probe(path, { method: 'POST', body: JSON.stringify(payload) });
    check(`${label}: missing agent_id returns 400, not 402`, res.status === 400, `got ${res.status}`);
    check(
      `${label}: no PAYMENT-REQUIRED header on a rejected request`,
      !res.paymentRequired,
      res.paymentRequired ? 'header present — the challenge fired before validation' : ''
    );
    check(
      `${label}: no payment challenge in the response body`,
      decodeChallenge(res) === null,
      'accepts[] should be absent on a 400'
    );
  }

  // A payload that only fails the deeper commitment-shape check (not merely a
  // missing field) must also be rejected before the challenge.
  const deepInvalid = await probe('/api/x402/verify/premium', {
    method: 'POST',
    body: JSON.stringify({ ...VALID_PAYLOAD, verification_type: 'fraud' })
  });
  check(
    'premium: invalid verification_type returns 400, not 402',
    deepInvalid.status === 400,
    `got ${deepInvalid.status}`
  );
  check(
    'premium: no PAYMENT-REQUIRED header for a deep-validation rejection',
    !deepInvalid.paymentRequired,
    deepInvalid.paymentRequired ? 'header present — the challenge fired before validation' : ''
  );
}

/**
 * `criteria` is polymorphic — its real shape depends on verification_type
 * (consistency/quality/time_bound) — but the Bazaar discovery schema only
 * ever documented the consistency shape. OKX's ASP review rejected this
 * listing ("a parameter that cannot be specifically inferred") because an
 * agent reading the schema had no way to learn what quality/time_bound need.
 * Worse, the premium discovery EXAMPLE set verification_type: "time_bound"
 * with criteria: { duration_days: 30 } — no milestones — which crashes
 * _scoreTimeBound at scoring time if anyone actually used it. This check
 * asserts every field each scoring path reads is documented, and that the
 * example itself is one that would actually work.
 */
async function checkCriteriaSchemaCompleteness() {
  console.log('\ncriteria schema completeness (OKX round-6 regression)');

  const premiumRes = await probe('/api/x402/verify/premium', {
    method: 'POST',
    body: JSON.stringify(VALID_PAYLOAD)
  });
  const advancedRes = await probe('/api/x402/verify/advanced', {
    method: 'POST',
    body: JSON.stringify(VALID_PAYLOAD)
  });

  const premiumChallenge = decodeChallenge(premiumRes);
  const advancedChallenge = decodeChallenge(advancedRes);

  const criteriaProps = challenge =>
    challenge?.extensions?.bazaar?.schema
      ?.properties?.input?.properties?.body?.properties?.criteria?.properties;

  const premiumCriteria = criteriaProps(premiumChallenge);
  const advancedCriteria = criteriaProps(advancedChallenge);

  const PREMIUM_EXPECTED_FIELDS = [
    'duration_days', 'frequency', 'minimum_actions', 'action_type', 'content_requirements',
    'quality_metrics', 'minimum_samples', 'milestones', 'allow_early_completion', 'penalty_per_late_hour'
  ];
  const ADVANCED_EXPECTED_FIELDS = [
    'verification_type', 'duration_days', 'frequency', 'minimum_actions', 'action_type',
    'content_requirements', 'quality_metrics', 'minimum_samples'
  ];

  if (premiumCriteria) {
    const missing = PREMIUM_EXPECTED_FIELDS.filter(f => !(f in premiumCriteria));
    check(
      'premium criteria schema documents every field scoring reads',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : ''
    );
  } else {
    check('premium criteria schema documents every field scoring reads', false, 'could not read premium criteria schema');
  }

  if (advancedCriteria) {
    const missing = ADVANCED_EXPECTED_FIELDS.filter(f => !(f in advancedCriteria));
    check(
      'advanced criteria schema documents every field scoring reads',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : ''
    );
  } else {
    check('advanced criteria schema documents every field scoring reads', false, 'could not read advanced criteria schema');
  }

  // The example itself must be one that would actually work, not merely one
  // the schema happens to allow — this is exactly what broke before.
  const premiumExampleBody = premiumChallenge?.extensions?.bazaar?.info?.input?.body;
  if (premiumExampleBody?.verification_type === 'time_bound') {
    const milestones = premiumExampleBody.criteria?.milestones;
    const valid = Array.isArray(milestones) && milestones.length > 0 &&
      milestones.every(m => m && typeof m === 'object' && m.milestone_id && m.deadline);
    check(
      'premium discovery example (verification_type: time_bound) has a non-empty, well-formed milestones array',
      valid,
      valid ? '' : `criteria.milestones=${JSON.stringify(milestones)}`
    );
  }
}

/**
 * The advertised usage example must actually be accepted by the service.
 *
 * Twice now the documented example has been one the service itself would
 * reject: it named a platform its own schema forbade, and later it declared
 * verification_type "time_bound" with no milestones, which crashed scoring.
 * Rather than assert a hardcoded shape, send the example back and see. A valid
 * body earns the 402 challenge; an invalid one is rejected pre-payment with a
 * 400, which is the failure this catches.
 */
async function checkAdvertisedExampleIsAccepted() {
  console.log('\nadvertised example is accepted by the service');

  for (const { path, label } of TIERS) {
    const challenge = decodeChallenge(await probe(path, { method: 'POST', body: JSON.stringify(VALID_PAYLOAD) }));
    const example = challenge?.extensions?.bazaar?.info?.input?.body;

    if (!example) {
      check(`${label}: discovery example is present`, false, 'could not read the example from the challenge');
      continue;
    }

    const res = await probe(path, { method: 'POST', body: JSON.stringify(example) });
    check(
      `${label}: the documented example passes pre-payment validation`,
      res.status === 402,
      res.status === 400
        ? `got 400 — the advertised example would be rejected: ${res.text.slice(0, 160)}`
        : `got ${res.status}`
    );
  }
}

/**
 * A parameterless probe must return the 402 challenge, not a 404 or a 400.
 *
 * This is the check that would have caught seven rounds of OKX rejections.
 * `onchainos agent x402-check --endpoint <url>` and `onchainos payment quote
 * <url>` probe a registered endpoint with GET; while these routes were
 * POST-only that GET fell through to Express's 404 and OKX reported "Endpoint
 * returned HTTP 404 (not 402); not a valid x402 service" — so their stack
 * could never read the Bazaar schema documenting our parameters. Every probe
 * shape is covered here because the preflight previously only ever POSTed.
 */
async function checkParameterlessProbe() {
  console.log('\nparameterless probe returns the challenge (OKX round-7 regression)');

  for (const { path, label } of TIERS) {
    const get = await probe(path, { method: 'GET' });
    check(
      `${label}: GET returns 402`,
      get.status === 402,
      get.status === 404
        ? `got 404 — this is what "onchainos agent x402-check" reports as "not a valid x402 service"`
        : `got ${get.status}`
    );
    check(`${label}: GET carries the PAYMENT-REQUIRED header`, !!get.paymentRequired, get.paymentRequired ? '' : 'missing');

    const getChallenge = decodeChallenge(get);
    check(`${label}: GET challenge decodes`, !!getChallenge, getChallenge ? '' : 'could not decode');

    // A GET must still advertise the POST contract: the verification is
    // POST-only, and a discovery record keyed {url, method:GET} would be wrong.
    check(
      `${label}: GET challenge still advertises method POST`,
      getChallenge?.extensions?.bazaar?.info?.input?.method === 'POST',
      `method=${getChallenge?.extensions?.bazaar?.info?.input?.method}`
    );

    // Identical config object on both verbs, so the two must not differ.
    const post = await probe(path, { method: 'POST', body: JSON.stringify(VALID_PAYLOAD) });
    const postChallenge = decodeChallenge(post);
    check(
      `${label}: GET and POST challenges declare the same accepts[]`,
      JSON.stringify(getChallenge?.accepts) === JSON.stringify(postChallenge?.accepts),
      'GET and POST must quote the same price and networks'
    );

    // An empty body supplies no parameters, so there is nothing to reject —
    // it must yield the challenge that documents what to send.
    const emptyPost = await probe(path, { method: 'POST', body: '{}' });
    check(`${label}: POST with {} returns 402`, emptyPost.status === 402, `got ${emptyPost.status}`);

    const bodylessPost = await fetch(`${baseUrl}${path}`, { method: 'POST' });
    check(`${label}: POST with no body at all returns 402`, bodylessPost.status === 402, `got ${bodylessPost.status}`);

    // Negative control: an array carries no keys but is malformed input, and
    // must keep failing pre-payment rather than being read as a probe.
    const arrayPost = await probe(path, { method: 'POST', body: '[]' });
    check(`${label}: POST with [] is still rejected`, arrayPost.status === 400, `got ${arrayPost.status}`);
  }

  // Trailing slash is a distinct path string; @x402/core normalizes it, and a
  // probe that adds one must not fall through to a 404.
  const slash = await probe('/api/x402/verify/premium/', { method: 'GET' });
  check('premium: GET with a trailing slash returns 402', slash.status === 402, `got ${slash.status}`);
}

async function main() {
  console.log(`\nOKX preflight check against ${baseUrl}`);

  await checkHealth();
  await checkPaymentChallenge();
  await checkAgentContentNegotiation();
  await checkFailureModes();
  await checkPreValidation();
  await checkCriteriaSchemaCompleteness();
  await checkAdvertisedExampleIsAccepted();
  await checkParameterlessProbe();

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
