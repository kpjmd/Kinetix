const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { createFacilitatorConfig } = require('@coinbase/x402');
const { registerExactEvmScheme } = require('@x402/evm/exact/server');
const { OKXFacilitatorClient } = require('@okxweb3/x402-core');
const {
  bazaarResourceServerExtension,
  declareDiscoveryExtension
} = require('@x402/extensions/bazaar');
const verificationService = require('../../services/verification-service');
const { deriveMinimumActions } = verificationService;
const monitoringService = require('../../services/monitoring-service');
const reconciliationService = require('../../services/reconciliation-service');
const attestationService = require('../../services/attestation-service');
const verificationRules = require('../../config/verification-rules.json');
const dataStore = require('../../services/data-store');
const pricingConfig = require('../../config/x402-pricing.json');
const { createRateLimiter } = require('../../utils/rate-limiter');
const {
  resolveMonitoringTarget,
  SUPPORTED_PLATFORMS,
  EXAMPLE_CLAWSTR_HANDLE
} = require('../../utils/monitoring-target');
const { buildBaseline } = require('../../services/baseline-service');
const { ValidationError } = require('../../utils/validation-error');
const clawstrApi = require('../../utils/clawstr-api');

const app = express();

// Railway terminates TLS and forwards over http, so without this req.protocol
// is 'http' and req.ip is the proxy. The first put `http://` into the 402
// challenge's resource.url — a client that follows it is 301-redirected, which
// turns a paid POST into a body-less GET. The second made the rate limiter one
// bucket shared by every caller.
app.set('trust proxy', 1);

const KINETIX_WALLET = process.env.CDP_WALLET_ADDRESS || '0x8c61756f693A321777562433E19B2AabF71f5519';

// Normalize network ID format (accept both base-sepolia and base_sepolia)
const rawNetworkId = process.env.NETWORK_ID || 'base_sepolia';
const NETWORK_ID = rawNetworkId.replace('-', '_'); // Always use underscore for config lookups
const chainId = pricingConfig.network[NETWORK_ID].chain_id;

// Registered ERC-8004 identity. Published in the health check, the Bazaar
// discovery metadata and the OKX ASP profile, so it is resolved once here
// rather than inlined at each use.
const ERC8004_TOKEN_ID = Number(
  process.env.KINETIX_ERC8004_TOKEN_ID || (NETWORK_ID === 'base_mainnet' ? 16892 : 509)
);

// Map to CAIP-2 network format (eip155:chainId)
// Base Mainnet (8453) -> eip155:8453, Base Sepolia (84532) -> eip155:84532
const x402NetworkName = `eip155:${chainId}`;

// Configure facilitator based on network
// Mainnet uses CDP facilitator with JWT auth, Testnet uses public x402.org facilitator
const isMainnet = chainId === 8453;
const facilitatorConfig = isMainnet
  ? createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
  : { url: process.env.X402_FACILITATOR_URL || 'https://www.x402.org/facilitator' };

// X Layer (OKX AI's marketplace network) is a second, additive accepts[]
// option alongside Base — required so the 402 challenge on this endpoint
// satisfies OKX AI's ASP review, which only settles on eip155:196. Gated on
// credential presence so local/dev and any deploy without OKX Developer
// Portal keys keep today's Base-only behavior unchanged.
const xLayerConfig = pricingConfig.x_layer;
const X_LAYER_NETWORK = `eip155:${xLayerConfig.chain_id}`;
const X_LAYER_ASSET = xLayerConfig.assets[xLayerConfig.default_asset];
const X_LAYER_PAY_TO = process.env.X_LAYER_PAY_TO || '0x68fb2f902ecdff17f715ffa487a9eb94d2460f5e';

const hasOkxCreds = !!(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE);
const okxFacilitatorClient = hasOkxCreds
  ? new OKXFacilitatorClient({
      apiKey: process.env.OKX_API_KEY,
      secretKey: process.env.OKX_SECRET_KEY,
      passphrase: process.env.OKX_PASSPHRASE,
    })
  : null;

// x402 v2 `price` accepts either a plain Money string (`"$1.00"`, resolved via
// the scheme's default-asset table) or an explicit AssetAmount. @x402/evm's
// default-asset table has no eip155:196 entry, so the X Layer leg must always
// use the explicit form; the Base leg keeps using the plain string unchanged.
function buildAccepts(priceUsdc, payTo) {
  const accepts = [{ scheme: 'exact', price: `$${priceUsdc}`, network: x402NetworkName, payTo }];
  if (okxFacilitatorClient) {
    accepts.unshift({
      scheme: 'exact',
      network: X_LAYER_NETWORK,
      price: {
        amount: String(Math.round(parseFloat(priceUsdc) * 10 ** X_LAYER_ASSET.decimals)),
        asset: X_LAYER_ASSET.address,
        extra: { name: X_LAYER_ASSET.name, version: X_LAYER_ASSET.version }
      },
      payTo: X_LAYER_PAY_TO,
      maxTimeoutSeconds: 300
    });
  }
  return accepts;
}

// Parse JSON bodies, and form bodies from clients that send params that way:
// a non-JSON body used to parse to {} and be treated as a parameterless probe.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cap how long any single request may occupy a connection. Without this a
// stalled upstream (IPFS pin, RPC call during scoring) leaves the caller
// holding an open socket with no response; agent clients read that as a hang
// rather than a failure.
const REQUEST_TIMEOUT_MS = 30000;
app.use((req, res, next) => {
  // Never for a request carrying a payment. @x402/express buffers the
  // handler's response until settlement finishes, so headersSent stays false
  // throughout — this timer would replace a delivered result with a 504 while
  // settlement still charged the buyer. Paid-request latency is bounded
  // instead by the facilitator verify timeout and the baseline cap.
  if (hasPaymentHeader(req)) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout' });
    }
  }, REQUEST_TIMEOUT_MS);
  res.on('close', () => clearTimeout(timer));
  next();
});

// Abuse control for the unauthenticated free endpoints below. The paid routes
// are gated by payment, so this is deliberately generous.
app.use(createRateLimiter(300, 60 * 60 * 1000));

// Health check (free endpoint)
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    agent: 'Kinetix',
    erc8004_token_id: ERC8004_TOKEN_ID,
    network: NETWORK_ID,
    wallet: KINETIX_WALLET,
    x402_network: x402NetworkName,
    x402_networks: okxFacilitatorClient ? [X_LAYER_NETWORK, x402NetworkName] : [x402NetworkName],
    timestamp: new Date().toISOString()
  });
});

// Free: retrieve an issued attestation receipt. Mirrors the same route on the
// free API server (api/routes/verification.js) so a counterparty can audit
// outcomes before paying for a verification.
app.get('/api/v1/attestation/:receipt_id', async (req, res, next) => {
  try {
    const receipt = await dataStore.loadAttestation(req.params.receipt_id);
    if (!receipt) {
      return res.status(404).json({ error: 'Attestation not found' });
    }
    res.json(receipt);
  } catch (error) {
    next(error);
  }
});

// Free: check verification status. getStatus() offers the commitment for
// scoring once its window has closed, which is what writes the attestation to
// this process's DATA_DIR.
//
// Scoring may legitimately be deferred after the window closes — it waits for
// an evidence collection that succeeded since then, so a relay outage is never
// scored as agent inactivity. The `collection` block in the response says
// whether that is happening and when the wait ends, so a caller can tell a
// deferral from a hang.
app.get('/api/x402/verify/:id/status', async (req, res, next) => {
  try {
    const status = await verificationService.getStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Verification not found' });
    }
    // The absolute link a buyer follows next, so the receipt they paid for is
    // one hop away rather than a URL pattern they have to know.
    const receiptUrl = status.receipt_id
      ? `${publicBaseUrl(req)}/api/v1/attestation/${status.receipt_id}`
      : null;
    res.json({ ...status, receipt_url: receiptUrl });
  } catch (error) {
    next(error);
  }
});

function hasPaymentHeader(req) {
  return Boolean(req.get('payment-signature') || req.get('x-payment'));
}

// Neither facilitator client puts a timeout on its fetches. Bound `verify`,
// which moves no money, so a stalled facilitator fails the request cleanly
// instead of hanging it. `settle` is deliberately left unbounded: abandoning a
// settlement that then lands on-chain would charge the buyer for a response
// we had already turned into an error.
const FACILITATOR_VERIFY_TIMEOUT_MS = 10000;
function withVerifyTimeout(client) {
  return new Proxy(client, {
    get(target, prop) {
      const value = target[prop];
      if (prop === 'verify') {
        return (...args) => {
          let timer;
          return Promise.race([
            value.apply(target, args),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Facilitator verify timed out after ${FACILITATOR_VERIFY_TIMEOUT_MS}ms`)),
                FACILITATOR_VERIFY_TIMEOUT_MS
              );
            })
          ]).finally(() => clearTimeout(timer));
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

// Initialize x402 resource server. facilitatorClients is an array so the
// OKX facilitator (X Layer settlement) can sit alongside the CDP facilitator
// (Base settlement) on the same resourceServer — x402ResourceServer dispatches
// each accepts[] entry to whichever registered facilitator supports its network.
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
const facilitatorClients = [withVerifyTimeout(facilitatorClient)];
if (okxFacilitatorClient) facilitatorClients.push(withVerifyTimeout(okxFacilitatorClient));
const resourceServer = new x402ResourceServer(facilitatorClients);

// Register EVM scheme for each supported network. (The previous call passed
// a bare string here, which registerExactEvmScheme's real `{networks: [...]}`
// signature silently falls through to an `eip155:*` wildcard registration —
// harmless, but the explicit form below is what the signature actually expects.)
registerExactEvmScheme(resourceServer, {
  networks: okxFacilitatorClient ? [x402NetworkName, X_LAYER_NETWORK] : [x402NetworkName]
});

// Register Bazaar extension for discovery.
//
// Wrapped rather than registered bare: the stock extension stamps the *live
// request's* method into the discovery declaration, and these resources are
// now keyed under GET as well as POST (see protectedRoutes) so an unpaid GET
// probe would otherwise advertise "GET, with a JSON body" and let a
// facilitator index a second Bazaar row keyed {same url, method: GET}. The
// verification is POST-only regardless of which verb asked for the challenge,
// so pin the advertised method to POST. Keeping `key: 'bazaar'` matters —
// @x402/express checks hasExtension('bazaar') and would re-register the stock
// extension over this one if the key changed.
resourceServer.registerExtension({
  ...bazaarResourceServerExtension,
  enrichDeclaration: (declaration, context) =>
    bazaarResourceServerExtension.enrichDeclaration(
      declaration,
      context && typeof context === 'object' && 'method' in context
        ? { ...context, method: 'POST' }
        : context
    )
});

// Bazaar discovery metadata.
//
// Every example here must succeed if a buyer sends it verbatim — buyer agents
// copy them, and OKX AI derives its own call instructions from them. Past
// examples 400'd (moltbook), crashed at scoring (time_bound without
// milestones), and finally could only ever score `failed` (time_bound, which
// the Clawstr collector cannot attribute). Only what can actually be scored is
// offered: consistency, and quality judged on post length.

const PLATFORM_HANDLE_DOC =
  'The agent\'s Nostr public key: an npub (starts with "npub1", exactly 63 characters) or the same ' +
  'key as 64 hex characters. Copy it exactly; a single changed character fails validation.';

const WALLET_ADDRESS_DOC =
  'Optional EVM address to receive the on-chain EAS attestation. Omit to get a signed receipt without an EAS attestation.';

const CONSISTENCY_CRITERIA_PROPERTIES = {
  duration_days: {
    type: 'number',
    minimum: 1,
    description: 'Length of the monitoring window in days. Default 7. Capped per tier.'
  },
  frequency: {
    type: 'string',
    enum: ['daily', 'weekly'],
    description: "How often the agent is expected to post. Default 'daily'."
  },
  minimum_actions: {
    type: 'number',
    description: 'Optional. Qualifying posts required in the window. Derived from duration_days and frequency if omitted (7 daily days -> 7).'
  },
  content_requirements: {
    type: 'object',
    description: 'Optional, consistency only.',
    properties: {
      min_length: { type: 'number', description: 'Minimum character length of each qualifying post.' },
      required_tags: { type: 'array', items: { type: 'string' }, description: 'Tags every qualifying post must include.' },
      forbidden_content: { type: 'array', items: { type: 'string' }, description: 'Strings that disqualify a post if present.' }
    }
  }
};

const QUALITY_CRITERIA_PROPERTIES = {
  quality_metrics: {
    type: 'object',
    description: 'Required when verification_type is "quality". Posts are judged on length.',
    properties: {
      minimum_length: { type: 'number', description: 'Minimum characters for a post to count as a quality sample.' }
    },
    required: ['minimum_length']
  },
  minimum_samples: {
    type: 'number',
    description: 'Required when verification_type is "quality". Posts needed to score; fewer yields "failed".'
  }
};

// What a successful paid call returns, abbreviated. Mirrors
// buildDeliveryResponse below.
function outputExample(tier) {
  return {
    success: true,
    delivered: ['certificate', 'baseline'],
    summary: 'Monitoring started for example-agent-123 (7-day daily consistency, 7 posts required). Recent activity (on track): Posted on 6 of the last 7 days; a daily commitment needs activity on nearly every day. Final signed receipt expected by 2026-10-08T12:00:00Z.',
    commitment_id: 'cmt_kx_abc123',
    tier,
    status: 'monitoring',
    monitoring_until: '2026-10-07T12:00:00Z',
    final_receipt_expected_by: '2026-10-08T12:00:00Z',
    certificate: { type: 'kinetix_commitment_certificate', commitment_id: 'cmt_kx_abc123', signatures: { kinetix_signature: '0x…' } },
    baseline: { status: 'complete', lookback_days: 7, events_found: 12, active_days: 6, outlook: 'on_track' },
    next_steps: {
      status_url: 'https://kinetix-x402-production.up.railway.app/api/x402/verify/cmt_kx_abc123/status',
      receipt_url_template: 'https://kinetix-x402-production.up.railway.app/api/v1/attestation/{receipt_id}'
    },
    payment_confirmed: true
  };
}

const basicDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: 'example-agent-123',
    platform: 'clawstr',
    platform_handle: EXAMPLE_CLAWSTR_HANDLE,
    commitment_description: 'Post at least once a day for 7 days'
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Your identifier for the agent being verified.' },
      platform: {
        type: 'string',
        enum: SUPPORTED_PLATFORMS,
        description: 'Platform whose activity is monitored for evidence'
      },
      platform_handle: { type: 'string', description: PLATFORM_HANDLE_DOC },
      wallet_address: { type: 'string', description: WALLET_ADDRESS_DOC },
      commitment_description: { type: 'string', description: 'What is being verified, in plain words.' }
    },
    required: ['agent_id', 'platform', 'platform_handle']
  },
  output: { example: outputExample('basic') }
});

const advancedDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: 'example-agent-123',
    commitment_description: 'Post at least once a day for 14 days',
    platform: 'clawstr',
    platform_handle: EXAMPLE_CLAWSTR_HANDLE,
    criteria: {
      verification_type: 'consistency',
      duration_days: 14,
      frequency: 'daily'
    }
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Your identifier for the agent being verified.' },
      commitment_description: { type: 'string', description: 'What is being verified, in plain words.' },
      platform: {
        type: 'string',
        enum: SUPPORTED_PLATFORMS,
        description: 'Platform whose activity is monitored for evidence'
      },
      platform_handle: { type: 'string', description: PLATFORM_HANDLE_DOC },
      wallet_address: { type: 'string', description: WALLET_ADDRESS_DOC },
      criteria: {
        type: 'object',
        description:
          'A JSON object (a JSON string of one is also accepted). verification_type "consistency" uses ' +
          'duration_days/frequency/minimum_actions/content_requirements; "quality" uses duration_days plus ' +
          'quality_metrics.minimum_length and minimum_samples.',
        properties: {
          verification_type: {
            type: 'string',
            enum: ['consistency', 'quality'],
            description: "Which scoring model to apply. Default 'consistency'."
          },
          ...CONSISTENCY_CRITERIA_PROPERTIES,
          ...QUALITY_CRITERIA_PROPERTIES
        },
        required: ['duration_days']
      }
    },
    required: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle']
  },
  output: { example: outputExample('advanced') }
});

const premiumDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: 'example-agent-123',
    commitment_description: 'Post at least once a day for 7 days',
    platform: 'clawstr',
    platform_handle: EXAMPLE_CLAWSTR_HANDLE,
    verification_type: 'consistency',
    criteria: { duration_days: 7, frequency: 'daily' }
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Your identifier for the agent being verified.' },
      commitment_description: { type: 'string', description: 'What is being verified, in plain words.' },
      platform: {
        type: 'string',
        enum: SUPPORTED_PLATFORMS,
        description: 'Platform whose activity is monitored for evidence'
      },
      platform_handle: { type: 'string', description: PLATFORM_HANDLE_DOC },
      wallet_address: { type: 'string', description: WALLET_ADDRESS_DOC },
      verification_type: {
        type: 'string',
        enum: ['consistency', 'quality'],
        description: "Optional. Default 'consistency'."
      },
      criteria: {
        type: 'object',
        description:
          'Optional. Omit it for a 7-day daily consistency check. A JSON object (a JSON string of one is ' +
          'also accepted). consistency uses duration_days/frequency/minimum_actions/content_requirements; ' +
          'quality requires quality_metrics.minimum_length and minimum_samples. Checked before payment, so ' +
          'a bad value is a 400, never a charge.',
        properties: { ...CONSISTENCY_CRITERIA_PROPERTIES, ...QUALITY_CRITERIA_PROPERTIES },
        required: []
      }
    },
    required: ['agent_id', 'commitment_description', 'platform', 'platform_handle']
  },
  output: { example: outputExample('premium') }
});

// The fields a caller must supply per tier. Single source of truth: the 402
// body advertises it, the GET handler repeats it, and the post-payment guard
// echoes it when a body never arrived.
const REQUIRED_BY_TIER = {
  // criteria is deliberately absent from premium: it is optional and defaults
  // to a 7-day daily consistency check. See buildPremiumCommitment.
  basic: ['agent_id', 'platform', 'platform_handle'],
  advanced: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle'],
  premium: ['agent_id', 'commitment_description', 'platform', 'platform_handle']
};

const TIER_DISCOVERY = { basic: basicDiscovery, advanced: advancedDiscovery, premium: premiumDiscovery };

/**
 * A copy-paste GET form of a tier's example request, for buyers (and OKX AI's
 * derived call instructions) that pass parameters in the query string.
 * `criteria` travels as JSON, which the pre-payment parser accepts.
 */
function exampleQueryString(tier) {
  const body = TIER_DISCOVERY[tier].bazaar.info.input.body;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return `/api/x402/verify/${tier}?${params.toString()}`;
}

/**
 * How to call a tier: the guide served in the 402 body, and repeated in every
 * error body so a buyer who got something wrong is shown what right is.
 */
function callGuide(tier) {
  return {
    method: 'POST',
    also_accepted: 'GET with the same parameter names in the query string (criteria as a JSON string)',
    content_type: 'application/json',
    required: REQUIRED_BY_TIER[tier],
    example_request: TIER_DISCOVERY[tier].bazaar.info.input.body,
    example_get: exampleQueryString(tier)
  };
}

/**
 * The body served with the 402 challenge.
 *
 * x402 v2 puts the challenge in the base64 PAYMENT-REQUIRED header and leaves
 * the body `{}`, which is fine for an agent client and useless to a human —
 * an OKX reviewer curling this endpoint saw an empty object. The parameter
 * details are already assembled for Bazaar discovery, so serve them here too.
 * Deliberately carries no `accepts` key: clients that fall back to reading the
 * challenge off the body test for `Array.isArray(body.accepts)`, so this stays
 * invisible to them and only the header remains authoritative.
 */
function tierDescription(tier) {
  const discovery = TIER_DISCOVERY[tier].bazaar;
  return {
    service: 'Kinetix Commitment Verification',
    tier,
    price_usdc: pricingConfig.tiers[tier].price_usdc,
    description: pricingConfig.tiers[tier].description,
    ...callGuide(tier),
    parameters: discovery.schema.properties.input.properties.body,
    example_response: discovery.info.output.example,
    delivers:
      'Immediately: a signed commitment certificate and a baseline of the agent\'s last 7 days of activity. ' +
      'When the window closes: a signed, IPFS-pinned receipt with the score, fetchable free from next_steps.status_url.',
    payment:
      'Pay per the PAYMENT-REQUIRED header, then repeat this request with the payment header. Parameters are ' +
      'checked before payment is requested, and payment only settles when a verification is created.'
  };
}

// @x402/core expects `{contentType, body}` here, not a bare body — it reads
// `unpaidResponse.contentType` straight into the Content-Type header, and an
// undefined one makes Node throw ERR_HTTP_INVALID_HEADER_VALUE.
function describeTier(tier) {
  return () => ({ contentType: 'application/json', body: tierDescription(tier) });
}

// Define protected routes with pricing.
//
// Each tier's config is built once and keyed under BOTH verbs. GET matters:
// OKX AI's `onchainos agent x402-check` and `payment quote` probe a registered
// endpoint with GET, and while these routes were POST-only that probe fell
// past every app.post layer to Express's own 404 — reported back as "Endpoint
// returned HTTP 404 (not 402); not a valid x402 service", which also meant
// OKX could never read the Bazaar inputSchema describing our parameters.
// Sharing one config object (rather than two literals) means the GET and POST
// challenges cannot drift; @x402/core never mutates a routeConfig.
const tierRouteConfig = {};
const protectedRoutes = {};
for (const tier of Object.keys(TIER_DISCOVERY)) {
  tierRouteConfig[tier] = {
    accepts: buildAccepts(pricingConfig.tiers[tier].price_usdc, KINETIX_WALLET),
    description: pricingConfig.tiers[tier].description,
    extensions: { ...TIER_DISCOVERY[tier] },
    unpaidResponseBody: describeTier(tier)
  };
  protectedRoutes[`POST /api/x402/verify/${tier}`] = tierRouteConfig[tier];
  protectedRoutes[`GET /api/x402/verify/${tier}`] = tierRouteConfig[tier];
  // A HEAD probe (seen from OKX's side) otherwise fell through to a 405.
  protectedRoutes[`HEAD /api/x402/verify/${tier}`] = tierRouteConfig[tier];
}

// Check if we should use test mode (no facilitator validation)
const TEST_MODE = process.env.X402_TEST_MODE === 'true' || process.env.TESTNET_MODE === 'true';

// Fail loudly at boot rather than silently serving a misconfigured paid
// service. Every condition below is one that would let the deploy look healthy
// while giving away verifications, signing receipts with the wrong key, or
// quoting the wrong chain.
const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.OKX_LISTED === 'true';
if (PRODUCTION) {
  const fatal = [];
  if (TEST_MODE) {
    fatal.push('X402_TEST_MODE/TESTNET_MODE is enabled — payment validation would be bypassed');
  }
  if (!isMainnet) {
    fatal.push(`NETWORK_ID=${rawNetworkId} resolves to chain ${chainId}, not Base mainnet (8453)`);
  }
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    fatal.push('CDP_API_KEY_ID/CDP_API_KEY_SECRET are required for the mainnet facilitator');
  }
  if (!hasOkxCreds) {
    fatal.push('OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE are required — this URL is registered with OKX AI and its 402 challenge must declare eip155:196');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(KINETIX_WALLET)) {
    fatal.push(`CDP_WALLET_ADDRESS is not a valid address: ${KINETIX_WALLET}`);
  }
  if (process.env.ALLOW_EPHEMERAL_SIGNING_KEY === 'true') {
    fatal.push('ALLOW_EPHEMERAL_SIGNING_KEY would sign receipts with a throwaway key');
  }
  if (fatal.length > 0) {
    console.error('❌ Refusing to start in production with:');
    fatal.forEach(reason => console.error(`  - ${reason}`));
    process.exit(1);
  }
}

// --- Pre-payment parameter validation --------------------------------------
//
// OKX AI's ASP review flagged that this service only surfaced bad-parameter
// errors after the buyer had already signed a payment authorization: the x402
// middleware below issues its 402 challenge purely from a path+method match,
// with no visibility into the request body, so a malformed request used to
// sail through the full challenge/sign/resubmit round trip before a route
// handler's own checks rejected it. These three builders run the same
// validation and commitment construction each handler used to do inline, and
// are wired in as `app.post`/`app.get` handlers *before* the payment
// middleware is mounted below, so Express dispatches them first and a bad
// request never reaches the point where a 402 is issued. The real handler
// further down reuses the already-validated commitment via
// `req.builtCommitment`.

// Per-parameter docs for the "missing" list in an error body.
const PARAM_GUIDANCE = {
  agent_id: { type: 'string', example: 'example-agent-123', description: 'Your identifier for the agent being verified' },
  commitment_description: { type: 'string', example: 'Post at least once a day for 7 days', description: 'What is being verified' },
  platform: { type: 'string', example: 'clawstr', description: `One of: ${SUPPORTED_PLATFORMS.join(', ')}` },
  platform_handle: { type: 'string', example: EXAMPLE_CLAWSTR_HANDLE, description: PLATFORM_HANDLE_DOC },
  criteria: {
    type: 'object',
    example: { verification_type: 'consistency', duration_days: 14, frequency: 'daily' },
    description: 'A JSON object; see the endpoint\'s parameter schema'
  }
};

function requireFields(body, fields) {
  const missing = fields.filter(name => {
    const value = body[name];
    return value === undefined || value === null || (typeof value === 'string' && !value.trim());
  });
  if (missing.length === 0) return;
  throw new ValidationError(`Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, {
    code: 'MISSING_FIELD',
    field: missing[0],
    required: fields,
    missing: missing.map(name => ({ field: name, ...PARAM_GUIDANCE[name] }))
  });
}

// Keys whose values arrive as strings from a query string or form body, and
// what they must become. Anything else stays a string.
const NUMERIC_CRITERIA = ['duration_days', 'minimum_actions', 'minimum_samples'];

function toNumberIfNumeric(value) {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
}

/**
 * One parameter shape out of the ways buyers actually send them.
 *
 * OKX AI's derived call instructions for this service are a GET with query
 * parameters, and its schema types `criteria` as a string, so its buyer
 * tooling coerces it to one. Accept, for criteria: an object (JSON body or
 * `criteria[duration_days]=7`), a JSON string, or dotted keys
 * (`criteria.duration_days=7`); and coerce numeric strings to numbers.
 */
function normalizeParams(raw) {
  const params = { ...raw };

  if (typeof params.criteria === 'string') {
    const text = params.criteria.trim();
    if (text === '') {
      delete params.criteria;
    } else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ValidationError('criteria must be a JSON object', {
          code: 'INVALID_TYPE',
          field: 'criteria',
          received: text.length > 80 ? `${text.slice(0, 80)}…` : text,
          expected: 'A JSON object, or a JSON string of one. Omit it for a 7-day daily consistency check.',
          example: { duration_days: 7, frequency: 'daily' }
        });
      }
      params.criteria = parsed;
    }
  }

  for (const key of Object.keys(params)) {
    if (!key.startsWith('criteria.')) continue;
    const criteria = params.criteria && typeof params.criteria === 'object' ? params.criteria : {};
    criteria[key.slice('criteria.'.length)] = params[key];
    params.criteria = criteria;
    delete params[key];
  }

  if (params.criteria && typeof params.criteria === 'object' && !Array.isArray(params.criteria)) {
    const criteria = { ...params.criteria };
    for (const key of NUMERIC_CRITERIA) {
      if (key in criteria) criteria[key] = toNumberIfNumeric(criteria[key]);
    }
    if (criteria.quality_metrics && typeof criteria.quality_metrics === 'object') {
      criteria.quality_metrics = {
        ...criteria.quality_metrics,
        minimum_length: toNumberIfNumeric(criteria.quality_metrics.minimum_length)
      };
      if (criteria.quality_metrics.minimum_length === undefined) delete criteria.quality_metrics.minimum_length;
    }
    params.criteria = criteria;
  }

  return params;
}

function requireCriteriaObject(criteria) {
  // Checked before the builders spread it, which would otherwise turn a
  // string into {0:'a',1:'b',...} and hide the bad input from the service layer.
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
    throw new ValidationError('criteria must be an object', {
      code: 'INVALID_TYPE',
      field: 'criteria',
      expected: 'A JSON object, or a JSON string of one',
      example: { duration_days: 7, frequency: 'daily' }
    });
  }
}

/**
 * Refuse, before payment, a verification this service could only ever fail.
 *
 * The Clawstr collector records each post's time and length and nothing else.
 * time_bound scoring looks deliveries up by `milestone_id`, which no evidence
 * carries, so every milestone scores `missed` and the receipt is `failed`
 * whatever the agent did. quality scoring is sound for `minimum_length` (from
 * `content_length`) and blind to its other metrics, which read fields no
 * evidence has. Selling either would take payment for a foregone verdict.
 */
function assertScoreable(commitment) {
  if (commitment.verification_type === 'time_bound') {
    throw new ValidationError(
      'verification_type "time_bound" is not available: Clawstr evidence cannot yet be matched to milestones. Use "consistency".',
      {
        code: 'UNSUPPORTED_VERIFICATION_TYPE',
        field: 'verification_type',
        received: 'time_bound',
        expected: 'One of: consistency, quality',
        example: 'consistency'
      }
    );
  }
  const metrics = commitment.criteria.quality_metrics;
  // An absent quality_metrics is left to _validateCommitment, which says it is
  // required; this only judges one that was supplied.
  if (commitment.verification_type === 'quality' && metrics && typeof metrics === 'object') {
    const unsupported = Object.keys(metrics).filter(key => key !== 'minimum_length');
    if (unsupported.length > 0 || metrics.minimum_length === undefined) {
      throw new ValidationError(
        unsupported.length
          ? `criteria.quality_metrics supports only minimum_length on Clawstr; remove: ${unsupported.join(', ')}`
          : 'criteria.quality_metrics.minimum_length is required for verification_type "quality"',
        {
          code: 'UNSUPPORTED_QUALITY_METRIC',
          field: 'criteria.quality_metrics',
          received: metrics,
          expected: 'An object with minimum_length (characters) and nothing else',
          example: { minimum_length: 200 }
        }
      );
    }
  }
}

function buildBasicCommitment(body) {
  const { agent_id, platform, platform_handle, commitment_description, erc8004_token_id, wallet_address } = body;

  requireFields(body, REQUIRED_BY_TIER.basic);

  // Throws ValidationError (-> 400, unpaid) if the agent could not be observed.
  const target = resolveMonitoringTarget({ platform, platform_handle });

  const commitment = {
    agent_id,
    platform_profiles: target.platform_profiles,
    pubkey: target.pubkey,
    wallet_address,
    description: commitment_description || `Basic verification for ${agent_id}`,
    verification_type: 'consistency',
    criteria: {
      platform: target.platform,
      frequency: 'daily',
      duration_days: pricingConfig.tiers.basic.max_duration_days,
      // Derived, not 1: a hardcoded 1 over a 7-day daily window meant a single
      // post scored 100% completion and sold a `verified` receipt.
      minimum_actions: deriveMinimumActions({
        frequency: 'daily',
        duration_days: pricingConfig.tiers.basic.max_duration_days
      })
    },
    erc8004_token_id: erc8004_token_id || null
  };

  verificationService._validateCommitment(commitment);
  return commitment;
}

function buildAdvancedCommitment(body) {
  const { agent_id, commitment_description, criteria, platform, platform_handle, erc8004_token_id, wallet_address } = body;

  requireFields(body, REQUIRED_BY_TIER.advanced);
  requireCriteriaObject(criteria);

  // Throws ValidationError (-> 400, unpaid) if the agent could not be observed.
  const target = resolveMonitoringTarget({ platform, platform_handle });

  const commitment = {
    agent_id,
    platform_profiles: target.platform_profiles,
    pubkey: target.pubkey,
    wallet_address,
    description: commitment_description,
    verification_type: criteria.verification_type || 'consistency',
    criteria: buildCriteria(criteria, {
      frequency: criteria.frequency || 'daily',
      platform: target.platform,
      // Clamp last: spreading `criteria` after this would let a caller's raw
      // duration_days overwrite the cap and buy a 90-day window at tier price.
      duration_days: Math.min(criteria.duration_days || 7, pricingConfig.tiers.advanced.max_duration_days)
    }),
    erc8004_token_id: erc8004_token_id || null
  };

  verificationService._validateCommitment(commitment);
  assertScoreable(commitment);
  return commitment;
}

function buildPremiumCommitment(body) {
  const {
    agent_id, commitment_description, verification_type,
    platform, platform_handle, erc8004_token_id, wallet_address
  } = body;

  // criteria is optional. Requiring it bought nothing: `criteria: {}` already
  // passed and produced this same fully-defaulted 7-day daily consistency
  // window, so the only effect was forcing a caller to name a polymorphic
  // object whose required shape depends on verification_type — the parameter
  // OKX AI's review called out as one that "cannot be specifically inferred".
  // A supplied criteria is still validated below, and quality still requires
  // its own sub-fields (enforced pre-payment in _validateCommitment).
  const criteria = body.criteria ?? {};

  requireFields(body, REQUIRED_BY_TIER.premium);
  requireCriteriaObject(criteria);

  // Throws ValidationError (-> 400, unpaid) if the agent could not be observed.
  const target = resolveMonitoringTarget({ platform, platform_handle });

  const commitment = {
    agent_id,
    platform_profiles: target.platform_profiles,
    pubkey: target.pubkey,
    wallet_address,
    description: commitment_description,
    verification_type: verification_type || 'consistency',
    criteria: buildCriteria(criteria, {
      platform: target.platform,
      // Clamp last: spreading `criteria` after this would let a caller's raw
      // duration_days overwrite the cap and buy a 10-year window at tier price.
      duration_days: Math.min(criteria.duration_days || 7, pricingConfig.tiers.premium.max_duration_days)
    }),
    erc8004_token_id: erc8004_token_id || null
  };

  // Before _validateCommitment, so time_bound gets "not available" rather
  // than a request for the milestones it could never score.
  assertScoreable(commitment);
  verificationService._validateCommitment(commitment);
  return commitment;
}

/**
 * Whether a request carried no parameters at all — a discovery probe.
 *
 * express.json() normalizes an absent body, a zero-length body and a non-JSON
 * content type all to `{}`, and an absent query string is `{}` too, so `{}` is
 * the whole signal. An array is NOT a probe: `[]` has no keys but is a
 * malformed request and must keep 400ing.
 */
function isParameterlessProbe(params) {
  return params === undefined
    || params === null
    || (typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length === 0);
}

// The request's parameters: the query string for GET/HEAD, the body otherwise.
function requestParams(req) {
  return req.method === 'GET' || req.method === 'HEAD' ? req.query : req.body;
}

// Builds and validates the commitment, or sends the appropriate 400/500 and
// stops the chain — either way, nothing downstream (the payment middleware
// included) ever sees an invalid request.
function validateAndBuild(tier, builder) {
  return (req, res, next) => {
    const params = requestParams(req);
    // A caller who supplied no parameters gets the 402 challenge, which is
    // what carries the Bazaar schema naming the parameters. Answering 400 here
    // instead was a chicken-and-egg: you had to already know the parameters to
    // be told what they are, and it is why OKX AI's discovery probe could
    // never read this service. Nothing was supplied, so there is nothing to
    // validate — and a request that DOES carry parameters still runs the full
    // builder below before reaching the payment middleware.
    if (isParameterlessProbe(params)) {
      req.builtCommitment = undefined;
      return next();
    }
    try {
      if (Array.isArray(params)) {
        throw new ValidationError('Request body must be a JSON object, not an array', {
          code: 'INVALID_TYPE',
          field: 'body',
          expected: 'A JSON object of named parameters'
        });
      }
      req.builtCommitment = builder(normalizeParams(params));
      next();
    } catch (error) {
      sendVerificationError(req, res, tier, error);
    }
  };
}

/**
 * The commitment validateAndBuild prepared, or null after sending a 400.
 *
 * Only absent when a parameterless probe arrived carrying a payment header.
 * Must answer 4xx and never 2xx: @x402/express skips settlement when the
 * handler responds >= 400, so the payer is not charged for a request that
 * performs no verification.
 */
function requireBuiltCommitment(req, res, tier) {
  if (req.builtCommitment) return req.builtCommitment;
  const lower = tier.toLowerCase();
  const onQuery = req.method === 'GET' || req.method === 'HEAD';
  sendVerificationError(req, res, tier, new ValidationError(onQuery ? 'Missing request parameters' : 'Missing request body', {
    code: 'MISSING_PARAMETERS',
    required: REQUIRED_BY_TIER[lower],
    missing: REQUIRED_BY_TIER[lower].map(name => ({ field: name, ...PARAM_GUIDANCE[name] })),
    hint:
      'The paid request arrived with no parameters. Repeat it with the parameters: as a JSON body with ' +
      'Content-Type: application/json on POST, or in the query string on GET. See how_to_call for both forms.'
  }));
  return null;
}

// GET, POST and HEAD all validate before the 402: OKX AI's buyer tooling
// probes and replays with GET by default, and its derived call instructions
// for this service are a GET with query parameters.
for (const [tier, builder] of Object.entries({
  basic: buildBasicCommitment,
  advanced: buildAdvancedCommitment,
  premium: buildPremiumCommitment
})) {
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  app.post(`/api/x402/verify/${tier}`, validateAndBuild(label, builder));
  app.get(`/api/x402/verify/${tier}`, validateAndBuild(label, builder));
}

/**
 * The parameter declaration OKX AI's buyer CLI reads to replay a paid call.
 *
 * `onchainos payment quote` captures a buyer's `--param` values, but
 * `payment pay` replays the paid request to the bare endpoint carrying ONLY
 * the parameters named in the challenge's top-level `outputSchema.input` —
 * a flat map of name -> {type, required, description} — using
 * `outputSchema.method`. It does not read the Bazaar extension. Without this
 * every OKX buyer's paid replay arrived with no parameters and got a 400: the
 * "no delivery after payment" OKX delisted this service for (reproduced with
 * a real buyer wallet on 2026-10-01). Shape established by quoting variants
 * with the CLI itself, which never signs.
 *
 * GET because the CLI sends planned parameters in the query string, which the
 * paid routes accept as a full alias of a POST body.
 */
function okxOutputSchema(tier) {
  const body = TIER_DISCOVERY[tier].bazaar.schema.properties.input.properties.body;
  const required = body.required || [];
  const input = {};
  for (const [name, spec] of Object.entries(body.properties)) {
    input[name] = {
      type: spec.type,
      required: required.includes(name),
      ...(spec.description ? { description: spec.description } : {})
    };
  }
  return { method: 'GET', input };
}

// Adds okxOutputSchema to the PAYMENT-REQUIRED header @x402/express emits.
// Payment matching compares only the chosen `accepts` entry, so a top-level
// field changes nothing about how a payment verifies.
function withOutputSchema(encoded, tier) {
  try {
    const challenge = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
    challenge.outputSchema = okxOutputSchema(tier);
    return Buffer.from(JSON.stringify(challenge)).toString('base64');
  } catch (error) {
    return encoded;
  }
}

app.use((req, res, next) => {
  const match = /^\/api\/x402\/verify\/(basic|advanced|premium)$/.exec(req.path);
  if (!match) return next();
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) =>
    setHeader(name, String(name).toLowerCase() === 'payment-required' ? withOutputSchema(value, match[1]) : value);
  next();
});

// Records what happened to each paid request once the response has gone out.
//
// Registered before the payment middleware so its `finish` listener sees the
// final status and the PAYMENT-RESPONSE header @x402/express sets after
// settling. Nothing recorded settlement before: the handler saved a payment
// record marked confirmed *before* settlement ran, with an empty tx hash, so
// no purchase could be tied to a transaction — or shown to have delivered.
const PAID_ROUTE = /^\/api\/x402\/verify\/(basic|advanced|premium)$/;
app.use((req, res, next) => {
  if (!hasPaymentHeader(req) || !PAID_ROUTE.test(req.path)) return next();
  res.on('finish', () => {
    recordSettlementOutcome(req, res).catch(error =>
      console.error('[x402] Failed to record settlement outcome:', error.message)
    );
  });
  next();
});

function decodePaymentResponse(header) {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
  } catch (error) {
    return null;
  }
}

async function recordSettlementOutcome(req, res) {
  const { commitmentId, paymentRecordId } = res.locals;
  const settlement = decodePaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
  const where = `${req.method} ${req.path}`;

  if (!commitmentId) {
    // Rejected before anything was created, so @x402/express did not settle.
    console.warn(`[x402] Paid ${where} answered ${res.statusCode} without a verification; not settled`);
    return;
  }

  if (res.statusCode < 400 && settlement && settlement.success !== false) {
    console.log(
      `[x402] Delivered ${commitmentId} and settled: tx ${settlement.transaction || 'unknown'} ` +
      `on ${settlement.network || 'unknown'} from ${settlement.payer || 'unknown'}`
    );
    await dataStore.updateX402Payment(paymentRecordId, {
      status: 'settled',
      transaction_hash: settlement.transaction || '',
      network: settlement.network || null,
      payer: settlement.payer || null,
      settled_at: new Date().toISOString()
    });
    return;
  }

  if (res.statusCode < 400) {
    // TEST_MODE, where no middleware settles.
    console.log(`[x402] Delivered ${commitmentId} with no settlement header (test mode?)`);
    return;
  }

  // The handler created the verification, then settlement failed and the
  // middleware replaced the delivery with an error. The buyer was not charged.
  console.error(
    `[x402] Settlement FAILED after creating ${commitmentId} (${where} -> ${res.statusCode}); ` +
    'the buyer was not charged and did not receive the delivery'
  );
  await dataStore.updateX402Payment(paymentRecordId, {
    status: 'settlement_failed',
    failed_at: new Date().toISOString()
  });
}

if (!TEST_MODE) {
  // Apply x402 payment middleware (production mode)
  app.use(
    paymentMiddleware(
      protectedRoutes,
      resourceServer,
      {
        name: 'Kinetix Verification Service',
        description: 'Enterprise-grade identity verification with on-chain attestations',
        metadata: {
          version: '1.0.0',
          category: 'verification',
          tags: ['identity', 'kyc', 'reputation', 'blockchain', 'erc-8004'],
          erc8004_token_id: ERC8004_TOKEN_ID,
          supportedNetworks: okxFacilitatorClient ? [X_LAYER_NETWORK, x402NetworkName] : [x402NetworkName],
          supportedTypes: ['consistency', 'quality', 'time_bound']
        }
      },
      undefined, // Use default paywall
      true // Enable sync with facilitator for Bazaar registration
    )
  );
} else {
  console.log('⚠ Running in TEST MODE - x402 payment validation disabled');
  console.log('  Set X402_TEST_MODE=false for production use');
}

// Initialize services
async function initializeServices() {
  // The data directories are gitignored, so they do not exist in a fresh
  // deploy image. Without this the first paid request fails on ENOENT inside
  // saveCommitment — after the caller has already been charged.
  await dataStore.ensureDirectories();

  const persistence = await dataStore.checkPersistence();
  if (persistence.usingFallbackPath) {
    console.warn('⚠ DATA_DIR is not set — commitments and attestations will be');
    console.warn('  lost on every redeploy. Mount a volume and set DATA_DIR.');
  }
  console.log(`✓ Data store at ${persistence.dataDir} (boot #${persistence.bootCount})`);

  await attestationService.initialize();
  verificationService.initialize(monitoringService, attestationService);
  monitoringService.initialize(verificationService);
  console.log('✓ Verification services initialized');
  // Note: the monitoring timer is started in start(), not here. Tests call
  // initializeServices() directly, and timers here would spawn live relay
  // queries and keep Jest alive.

  // In test mode, skip facilitator initialization
  if (TEST_MODE) {
    console.log('⚠ Facilitator initialization skipped (test mode enabled)');
    console.log('  Payment validation is bypassed for local testing');
  } else {
    // Production mode: initialize with facilitator
    try {
      await resourceServer.initialize();
      console.log('✓ Resource server initialized with facilitator');
      console.log(`  exact/${x402NetworkName} supported: ${!!resourceServer.getSupportedKind(2, x402NetworkName, 'exact')}`);
      if (okxFacilitatorClient) {
        console.log(`  exact/${X_LAYER_NETWORK} supported: ${!!resourceServer.getSupportedKind(2, X_LAYER_NETWORK, 'exact')}`);
      }
    } catch (error) {
      console.error('❌ Facilitator initialization failed:');
      console.error(`  ${error.message}`);
      console.error('  Server cannot start without facilitator in production mode');
      process.exit(1);
    }
  }
}

// Payment metadata stored on the commitment. Settlement runs after the
// handler, so the transaction is not known here; recordSettlementOutcome
// writes it to the payment record once it is.
function createPaymentMetadata(tier, req) {
  return {
    amount: pricingConfig.tiers[tier].price_usdc,
    currency: 'USDC',
    tier: tier,
    token_used: 'USDC',
    payment_method: 'x402',
    network: NETWORK_ID,
    payment_timestamp: new Date().toISOString()
  };
}

const NOT_CHARGED =
  'You were not charged: payment only settles when a verification is created. Fix the request and send it again.';

/**
 * Translate a thrown error into a response for the paid verification routes.
 *
 * Bad input from the caller must read as 400, not 500 — a 500 tells a
 * marketplace reviewer the service is broken. Server faults deliberately omit
 * `error.message`, which for an fs or RPC failure would leak container paths
 * and internal endpoints to an anonymous caller.
 *
 * Every 400 carries what to fix and how to call the endpoint correctly. OKX
 * AI delisted this service after buyers retried bare messages — `Invalid
 * Nostr pubkey "test"`, a raw bech32 checksum error — without ever learning
 * what a valid request looks like.
 */
function sendVerificationError(req, res, tier, error) {
  const lower = tier.toLowerCase();
  if (error.status === 400) {
    console.warn(`${tier} verification rejected: ${error.message}`);
    return res.status(400).json({
      error: error.message,
      // `details` duplicates `error` for clients written against the old shape.
      details: error.message,
      ...(error.responseBody || {}),
      ...error.guidance,
      charged: false,
      payment_note: NOT_CHARGED,
      how_to_call: callGuide(lower)
    });
  }
  console.error(`${tier} verification error:`, error);
  res.status(500).json({
    error: 'Verification creation failed',
    code: 'SERVER_ERROR',
    charged: false,
    payment_note: 'This was a fault on our side and you were not charged. Retrying the same request is safe.'
  });
}

/**
 * Merge caller criteria with the values this service controls.
 *
 * `overrides` is applied after the spread so a caller can never overwrite a tier
 * clamp. An absent `minimum_actions` is left absent on purpose: it is derived in
 * verificationService.createVerification, which sees these already-clamped
 * values and knows the verification_type it applies to. A caller-supplied value
 * is kept, and rejected there if it is not a positive integer.
 */
function buildCriteria(callerCriteria, overrides) {
  return { ...callerCriteria, ...overrides };
}

function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function describeCommitment(verification, commitment) {
  const criteria = verification.criteria || commitment.criteria;
  const days = criteria.duration_days;
  if (commitment.verification_type === 'quality') {
    return `${days}-day quality check (posts of ${criteria.quality_metrics?.minimum_length}+ characters)`;
  }
  return `${days}-day ${criteria.frequency || 'daily'} consistency, ${criteria.minimum_actions} posts required`;
}

function describeBaseline(baseline) {
  if (baseline.status === 'unavailable') return `Recent activity: unavailable. ${baseline.reason}`;
  return `Recent activity (${baseline.outlook.replace(/_/g, ' ')}): ${baseline.outlook_reason}`;
}

/**
 * The paid response: what the buyer receives for their payment, right now.
 *
 * It used to be only `{commitment_id, status: "monitoring"}` — the result
 * arriving days later at a URL the response never mentioned. OKX AI expects
 * a paid call to deliver, and delisted this service over it. Now the buyer
 * gets a signed certificate of the terms they bought, a baseline of the
 * agent's recent activity, and exact instructions for fetching the receipt.
 */
function buildDeliveryResponse(req, tier, commitment, verification, baseline) {
  const base = publicBaseUrl(req);
  const id = verification.verification_id;
  return {
    success: true,
    delivered: ['certificate', 'baseline'],
    summary:
      `Monitoring started for ${commitment.agent_id} (${describeCommitment(verification, commitment)}). ` +
      `${describeBaseline(baseline)} Final signed receipt expected by ${verification.final_receipt_expected_by}.`,
    commitment_id: id,
    tier,
    status: verification.status,
    monitoring_until: verification.expected_completion,
    final_receipt_expected_by: verification.final_receipt_expected_by,
    certificate: verification.certificate,
    baseline,
    next_steps: {
      status_url: `${base}/api/x402/verify/${id}/status`,
      receipt_url_template: `${base}/api/v1/attestation/{receipt_id}`,
      how_to_get_the_receipt:
        'Poll status_url (free). Once status is "verified" or "failed" it includes receipt_id; fetch the signed ' +
        'receipt from receipt_url_template. Check the certificate and receipt signatures by recovering ' +
        'signatures.kinetix_signature over signatures.canonical_hash (EIP-191) and comparing to issuer.pubkey.'
    },
    payment_confirmed: true,
    features: pricingConfig.tiers[tier].features,
    timestamp: new Date().toISOString()
  };
}

// The paid verification, for every tier and both verbs. Parameter validation
// already ran, before the payment middleware above, in validateAndBuild.
function handlePaidVerification(tier) {
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  return async (req, res) => {
    try {
      const commitment = requireBuiltCommitment(req, res, label);
      if (!commitment) return;

      commitment.payment = createPaymentMetadata(tier, req);

      const verification = await verificationService.createVerification(commitment);
      res.locals.commitmentId = verification.verification_id;

      const payment = await dataStore.saveX402Payment({
        commitment_id: verification.verification_id,
        amount: commitment.payment.amount,
        currency: commitment.payment.currency,
        tier,
        transaction_hash: ''
      });
      res.locals.paymentRecordId = payment.payment_id;

      // Bounded and never throws: a relay outage degrades the snapshot, not
      // the delivery.
      const baseline = await buildBaseline({
        pubkey: commitment.pubkey,
        verification_type: commitment.verification_type,
        criteria: verification.criteria || commitment.criteria
      });

      res.json(buildDeliveryResponse(req, tier, commitment, verification, baseline));
    } catch (error) {
      sendVerificationError(req, res, label, error);
    }
  };
}

for (const tier of Object.keys(REQUIRED_BY_TIER)) {
  app.post(`/api/x402/verify/${tier}`, handlePaidVerification(tier));
  app.get(`/api/x402/verify/${tier}`, handlePaidVerification(tier));
}

// Unknown routes: JSON, not Express's HTML page, so an agent client can read it.
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
    endpoints: {
      verify: 'POST (or GET) /api/x402/verify/premium',
      status: 'GET /api/x402/verify/{commitment_id}/status',
      receipt: 'GET /api/v1/attestation/{receipt_id}',
      health: 'GET /health'
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Request body is not valid JSON',
      code: 'INVALID_JSON',
      details: err.message,
      charged: false,
      payment_note: NOT_CHARGED,
      how_to_call: callGuide('premium')
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body too large (limit 100kb)',
      code: 'BODY_TOO_LARGE',
      charged: false
    });
  }
  const status = err.status || 500;
  if (status === 400) {
    return res.status(400).json({ error: 'Invalid request', details: err.message, charged: false });
  }
  console.error('Server error:', err);
  res.status(status).json({ error: 'Internal server error' });
});

// Start server. Railway injects $PORT and routes its public domain to it, so
// that has to win over the local-development X402_PORT.
const PORT = process.env.PORT || process.env.X402_PORT || 3001;

function start() {
  return initializeServices()
    .then(() => {
      const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n=== Kinetix x402 Verification Service ===`);
        console.log(`✓ Server listening on port ${PORT}`);
        console.log(`✓ Network: ${NETWORK_ID} (Chain ID: ${chainId})`);
        console.log(`✓ x402 Network: ${x402NetworkName}`);
        console.log(`✓ Receiving payments at: ${KINETIX_WALLET}`);
        console.log(`✓ ERC-8004 token ID: ${ERC8004_TOKEN_ID}`);
        console.log(`✓ Facilitator: ${facilitatorConfig.url || 'CDP (authenticated)'}`);
        console.log(`\nEndpoints:`);
        console.log(`  GET  /health                          - Free health check`);
        console.log(`  GET  /api/v1/attestation/:receipt_id  - Free receipt lookup`);
        console.log(`  GET  /api/x402/verify/:id/status      - Free status check`);
        console.log(`  POST|GET /api/x402/verify/basic       - $${pricingConfig.tiers.basic.price_usdc} USDC`);
        console.log(`  POST|GET /api/x402/verify/advanced    - $${pricingConfig.tiers.advanced.price_usdc} USDC`);
        console.log(`  POST|GET /api/x402/verify/premium     - $${pricingConfig.tiers.premium.price_usdc} USDC`);
        console.log(`  (no parameters -> 402 challenge + parameter schema)`);
        console.log(`\nReady for autonomous agent payments!\n`);
      });

      // Evidence collection has to run in *this* process. Each Railway service
      // has its own volume, so the Telegram bot's loop cannot see commitments
      // sold here — without this, every paid verification expires with zero
      // evidence and scores 0/failed no matter what the agent did.
      const intervalMinutes = Number(process.env.MONITORING_INTERVAL_MINUTES)
        || verificationRules.monitoring.check_interval_minutes;
      // immediate: a customer who buys a short window should not wait a full
      // interval before anything is collected.
      monitoringService.start(intervalMinutes, { immediate: true });
      console.log(`✓ Evidence collection every ${intervalMinutes} min (nak: ${clawstrApi.resolveNakPath()})`);

      // Same reasoning as the collection loop: reconciliation reads receipts
      // from this process's volume, so the bot's reconciler can never see a
      // receipt issued here. Without it an on-chain submission that failed at
      // issuance stays `pending` forever, which reads as a stuck submission to
      // anyone auditing the receipt.
      //
      // Safe because the volumes are separate. `this.running` is a per-process
      // guard, so if the two services ever shared one, their timers would race;
      // STALE_SUBMITTING_MS and terminal-status filtering are advisory, not a
      // lock.
      reconciliationService.initialize();
      const reconcileInterval = verificationRules.onchain_reconciliation?.check_interval_minutes || 180;
      reconciliationService.start(reconcileInterval);
      console.log(`✓ On-chain reconciliation every ${reconcileInterval} min`);

      // Railway sends SIGTERM on redeploy. Stop the timers so a tick cannot be
      // torn down midway through writing a commitment or a receipt.
      const shutdown = signal => {
        console.log(`\n${signal} received, stopping background work`);
        monitoringService.stop();
        reconciliationService.stop();
        server.close(() => process.exit(0));
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));

      // keepAliveTimeout must exceed the upstream proxy's idle timeout,
      // otherwise Railway reuses a connection Node has already closed and the
      // caller sees a 502.
      server.requestTimeout = 35000;
      server.headersTimeout = 40000;
      server.keepAliveTimeout = 65000;

      return server;
    });
}

// Only self-start when run directly, so tests can import the app and drive it
// over HTTP without binding a port.
if (require.main === module) {
  start().catch(error => {
    console.error('Failed to initialize services:', error);
    process.exit(1);
  });
}

module.exports = app;
module.exports.start = start;
module.exports.initializeServices = initializeServices;
// Exported for tests: the route table is the thing that regressed for seven
// OKX review rounds (GET keys missing), and asserting on it directly catches
// that in CI rather than only against a live deploy.
module.exports.protectedRoutes = protectedRoutes;
module.exports.withOutputSchema = withOutputSchema;
