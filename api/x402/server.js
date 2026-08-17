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
const { resolveMonitoringTarget, SUPPORTED_PLATFORMS } = require('../../utils/monitoring-target');
const { ValidationError } = require('../../utils/validation-error');
const clawstrApi = require('../../utils/clawstr-api');

const app = express();
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

// Parse JSON bodies
app.use(express.json());

// Cap how long any single request may occupy a connection. Without this a
// stalled upstream (IPFS pin, RPC call during scoring) leaves the caller
// holding an open socket with no response; agent clients read that as a hang
// rather than a failure.
const REQUEST_TIMEOUT_MS = 30000;
app.use((req, res, next) => {
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
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// Initialize x402 resource server. facilitatorClients is an array so the
// OKX facilitator (X Layer settlement) can sit alongside the CDP facilitator
// (Base settlement) on the same resourceServer — x402ResourceServer dispatches
// each accepts[] entry to whichever registered facilitator supports its network.
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
const facilitatorClients = [facilitatorClient];
if (okxFacilitatorClient) facilitatorClients.push(okxFacilitatorClient);
const resourceServer = new x402ResourceServer(facilitatorClients);

// Register EVM scheme for each supported network. (The previous call passed
// a bare string here, which registerExactEvmScheme's real `{networks: [...]}`
// signature silently falls through to an `eip155:*` wildcard registration —
// harmless, but the explicit form below is what the signature actually expects.)
registerExactEvmScheme(resourceServer, {
  networks: okxFacilitatorClient ? [x402NetworkName, X_LAYER_NETWORK] : [x402NetworkName]
});

// Register Bazaar extension for discovery
resourceServer.registerExtension(bazaarResourceServerExtension);

// Bazaar discovery metadata
const basicDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: "example-agent-123",
    platform: "clawstr",
    platform_handle: "npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5",
    commitment_description: "Daily consistency check for 7 days"
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Unique identifier for the agent' },
      platform: {
        type: 'string',
        enum: SUPPORTED_PLATFORMS,
        description: 'Platform whose activity is monitored for evidence'
      },
      platform_handle: {
        type: 'string',
        description: 'Account identifier on that platform. For clawstr, the Nostr pubkey (npub or hex).'
      },
      wallet_address: {
        type: 'string',
        description: 'Optional EVM address to receive the on-chain EAS attestation. Omit to get a signed receipt without an EAS attestation.'
      },
      commitment_description: { type: 'string', description: 'What is being verified' }
    },
    required: ['agent_id', 'platform', 'platform_handle']
  },
  output: {
    example: {
      success: true,
      commitment_id: 'cmt_kx_abc123',
      status: 'monitoring',
      monitoring_until: '2026-02-22T12:00:00Z',
      tier: 'basic',
      payment_confirmed: true
    }
  }
});

const advancedDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: "example-agent-123",
    commitment_description: "Quality and consistency verification",
    platform: "clawstr",
    platform_handle: "npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5",
    criteria: {
      verification_type: "consistency",
      duration_days: 14,
      frequency: "daily"
    }
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Unique identifier' },
      commitment_description: { type: 'string', description: 'What is being verified' },
      platform: {
        type: 'string',
        enum: SUPPORTED_PLATFORMS,
        description: 'Platform whose activity is monitored for evidence'
      },
      platform_handle: {
        type: 'string',
        description: 'Account identifier on that platform. For clawstr, the Nostr pubkey (npub or hex).'
      },
      wallet_address: {
        type: 'string',
        description: 'Optional EVM address to receive the on-chain EAS attestation. Omit to get a signed receipt without an EAS attestation.'
      },
      criteria: {
        type: 'object',
        properties: {
          verification_type: { type: 'string', enum: ['consistency', 'quality'] },
          duration_days: { type: 'number', minimum: 1, maximum: 30 },
          frequency: { type: 'string', enum: ['daily', 'weekly'] }
        },
        required: ['verification_type', 'duration_days']
      }
    },
    required: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle']
  },
  output: {
    example: {
      success: true,
      commitment_id: 'cmt_kx_def456',
      status: 'monitoring',
      tier: 'advanced',
      payment_confirmed: true
    }
  }
});

const premiumDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: "example-agent-123",
    commitment_description: "Full verification suite",
    platform: "clawstr",
    platform_handle: "npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5",
    criteria: { duration_days: 30 },
    verification_type: "time_bound"
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Unique identifier' },
      commitment_description: { type: 'string', description: 'What is being verified' },
      platform: {
        type: 'string',
        enum: SUPPORTED_PLATFORMS,
        description: 'Platform whose activity is monitored for evidence'
      },
      platform_handle: {
        type: 'string',
        description: 'Account identifier on that platform. For clawstr, the Nostr pubkey (npub or hex).'
      },
      wallet_address: {
        type: 'string',
        description: 'Optional EVM address to receive the on-chain EAS attestation. Omit to get a signed receipt without an EAS attestation.'
      },
      verification_type: {
        type: 'string',
        enum: ['consistency', 'quality', 'time_bound'],
        description: 'Premium supports all types'
      },
      criteria: {
        type: 'object',
        properties: {
          duration_days: { type: 'number', minimum: 1, maximum: 90 }
        },
        required: ['duration_days']
      }
    },
    required: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle']
  },
  output: {
    example: {
      success: true,
      commitment_id: 'cmt_kx_ghi789',
      status: 'monitoring',
      tier: 'premium',
      features: ['advanced_scoring', 'ipfs_upload', 'erc8004_submission'],
      payment_confirmed: true
    }
  }
});

// Define protected routes with pricing
const protectedRoutes = {
  'POST /api/x402/verify/basic': {
    accepts: buildAccepts(pricingConfig.tiers.basic.price_usdc, KINETIX_WALLET),
    description: pricingConfig.tiers.basic.description,
    extensions: {
      ...basicDiscovery
    }
  },
  'POST /api/x402/verify/advanced': {
    accepts: buildAccepts(pricingConfig.tiers.advanced.price_usdc, KINETIX_WALLET),
    description: pricingConfig.tiers.advanced.description,
    extensions: {
      ...advancedDiscovery
    }
  },
  'POST /api/x402/verify/premium': {
    accepts: buildAccepts(pricingConfig.tiers.premium.price_usdc, KINETIX_WALLET),
    description: pricingConfig.tiers.premium.description,
    extensions: {
      ...premiumDiscovery
    }
  },
};

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
// are wired in as `app.post` handlers *before* the payment middleware is
// mounted below, so Express dispatches them first and a bad request never
// reaches the point where a 402 is issued. The real handlers further down
// reuse the already-validated commitment via `req.builtCommitment`.

function buildBasicCommitment(body) {
  const { agent_id, platform, platform_handle, commitment_description, erc8004_token_id, wallet_address } = body;

  if (!agent_id || !platform || !platform_handle) {
    throw new ValidationError('Missing required fields', {
      error: 'Missing required fields',
      required: ['agent_id', 'platform', 'platform_handle']
    });
  }

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

  if (!agent_id || !commitment_description || !criteria) {
    throw new ValidationError('Missing required fields', {
      error: 'Missing required fields',
      required: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle']
    });
  }

  // Checked before the spread below, which would otherwise turn a string
  // into {0:'a',1:'b',...} and hide the bad input from the service layer.
  if (typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new ValidationError('criteria must be an object');
  }

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
  return commitment;
}

function buildPremiumCommitment(body) {
  const {
    agent_id, commitment_description, criteria, verification_type,
    platform, platform_handle, erc8004_token_id, wallet_address
  } = body;

  if (!agent_id || !commitment_description || !criteria) {
    throw new ValidationError('Missing required fields', {
      error: 'Missing required fields',
      required: ['agent_id', 'commitment_description', 'criteria', 'platform', 'platform_handle']
    });
  }

  // Checked before the spread below, which would otherwise turn a string
  // into {0:'a',1:'b',...} and hide the bad input from the service layer.
  if (typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new ValidationError('criteria must be an object');
  }

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

  verificationService._validateCommitment(commitment);
  return commitment;
}

// Builds and validates the commitment, or sends the appropriate 400/500 and
// stops the chain — either way, nothing downstream (the payment middleware
// included) ever sees an invalid request.
function validateAndBuild(tier, builder) {
  return (req, res, next) => {
    try {
      req.builtCommitment = builder(req.body);
      next();
    } catch (error) {
      sendVerificationError(res, tier, error);
    }
  };
}

app.post('/api/x402/verify/basic', validateAndBuild('Basic', buildBasicCommitment));
app.post('/api/x402/verify/advanced', validateAndBuild('Advanced', buildAdvancedCommitment));
app.post('/api/x402/verify/premium', validateAndBuild('Premium', buildPremiumCommitment));

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

// Helper function to create payment metadata
function createPaymentMetadata(tier, req) {
  return {
    amount: pricingConfig.tiers[tier].price_usdc,
    currency: 'USDC',
    tier: tier,
    token_used: 'USDC',
    payment_method: 'x402',
    x402_request_id: req.headers['x-x402-request-id'] || req.headers['x402-request-id'] || 'unknown',
    network: NETWORK_ID,
    transaction_hash: req.headers['x-x402-tx-hash'] || req.headers['x402-tx-hash'] || '',
    payment_timestamp: new Date().toISOString()
  };
}

/**
 * Translate a thrown error into a response for the paid verification routes.
 *
 * Bad input from the caller must read as 400, not 500 — a 500 tells a
 * marketplace reviewer the service is broken. Server faults deliberately omit
 * `error.message`, which for an fs or RPC failure would leak container paths
 * and internal endpoints to an anonymous caller.
 */
function sendVerificationError(res, tier, error) {
  if (error.responseBody) {
    console.warn(`${tier} verification rejected: ${error.message}`);
    return res.status(error.status || 400).json(error.responseBody);
  }
  if (error.status === 400) {
    console.warn(`${tier} verification rejected: ${error.message}`);
    return res.status(400).json({ error: 'Invalid request', details: error.message });
  }
  console.error(`${tier} verification error:`, error);
  res.status(500).json({ error: 'Verification creation failed' });
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

// Basic verification endpoint. Parameter validation already ran, before the
// payment middleware above, in the `validateAndBuild('Basic', ...)` handler
// registered earlier for this same route — `req.builtCommitment` is always
// set by the time this runs.
app.post('/api/x402/verify/basic', async (req, res) => {
  try {
    const commitment = req.builtCommitment;

    // Extract payment metadata from x402 headers
    const paymentMetadata = createPaymentMetadata('basic', req);
    commitment.payment = paymentMetadata;

    const verification = await verificationService.createVerification(commitment);

    // Save payment tracking
    await dataStore.saveX402Payment({
      x402_request_id: paymentMetadata.x402_request_id,
      commitment_id: verification.verification_id,
      amount: paymentMetadata.amount,
      currency: paymentMetadata.currency,
      tier: paymentMetadata.tier,
      transaction_hash: paymentMetadata.transaction_hash
    });

    res.json({
      success: true,
      commitment_id: verification.verification_id,
      status: verification.status,
      monitoring_until: verification.expected_completion,
      tier: 'basic',
      payment_confirmed: true,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    sendVerificationError(res, 'Basic', error);
  }
});

// Advanced verification endpoint. Parameter validation already ran, before
// the payment middleware above, in the `validateAndBuild('Advanced', ...)`
// handler registered earlier for this same route — `req.builtCommitment` is
// always set by the time this runs.
app.post('/api/x402/verify/advanced', async (req, res) => {
  try {
    const commitment = req.builtCommitment;

    // Extract payment metadata
    const paymentMetadata = createPaymentMetadata('advanced', req);
    commitment.payment = paymentMetadata;

    const verification = await verificationService.createVerification(commitment);

    // Save payment tracking
    await dataStore.saveX402Payment({
      x402_request_id: paymentMetadata.x402_request_id,
      commitment_id: verification.verification_id,
      amount: paymentMetadata.amount,
      currency: paymentMetadata.currency,
      tier: paymentMetadata.tier,
      transaction_hash: paymentMetadata.transaction_hash
    });

    res.json({
      success: true,
      commitment_id: verification.verification_id,
      status: verification.status,
      monitoring_until: verification.expected_completion,
      tier: 'advanced',
      payment_confirmed: true,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    sendVerificationError(res, 'Advanced', error);
  }
});

// Premium verification endpoint. Parameter validation already ran, before
// the payment middleware above, in the `validateAndBuild('Premium', ...)`
// handler registered earlier for this same route — `req.builtCommitment` is
// always set by the time this runs.
app.post('/api/x402/verify/premium', async (req, res) => {
  try {
    const commitment = req.builtCommitment;

    // Extract payment metadata
    const paymentMetadata = createPaymentMetadata('premium', req);
    commitment.payment = paymentMetadata;

    const verification = await verificationService.createVerification(commitment);

    // Save payment tracking
    await dataStore.saveX402Payment({
      x402_request_id: paymentMetadata.x402_request_id,
      commitment_id: verification.verification_id,
      amount: paymentMetadata.amount,
      currency: paymentMetadata.currency,
      tier: paymentMetadata.tier,
      transaction_hash: paymentMetadata.transaction_hash
    });

    res.json({
      success: true,
      commitment_id: verification.verification_id,
      status: verification.status,
      monitoring_until: verification.expected_completion,
      tier: 'premium',
      payment_confirmed: true,
      features: pricingConfig.tiers.premium.features,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    sendVerificationError(res, 'Premium', error);
  }
});

// Error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 400) {
    return res.status(400).json({ error: 'Invalid request', details: err.message });
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
        console.log(`  POST /api/x402/verify/basic           - $${pricingConfig.tiers.basic.price_usdc} USDC`);
        console.log(`  POST /api/x402/verify/advanced        - $${pricingConfig.tiers.advanced.price_usdc} USDC`);
        console.log(`  POST /api/x402/verify/premium         - $${pricingConfig.tiers.premium.price_usdc} USDC`);
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
