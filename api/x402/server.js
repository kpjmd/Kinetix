const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { createFacilitatorConfig } = require('@coinbase/x402');
const { registerExactEvmScheme } = require('@x402/evm/exact/server');
const {
  bazaarResourceServerExtension,
  declareDiscoveryExtension
} = require('@x402/extensions/bazaar');
const verificationService = require('../../services/verification-service');
const attestationService = require('../../services/attestation-service');
const dataStore = require('../../services/data-store');
const pricingConfig = require('../../config/x402-pricing.json');

const app = express();
const KINETIX_WALLET = process.env.CDP_WALLET_ADDRESS || '0xD203776d8279cfcA540473a0AB6197D53c96cbaf';

// Normalize network ID format (accept both base-sepolia and base_sepolia)
const rawNetworkId = process.env.NETWORK_ID || 'base_sepolia';
const NETWORK_ID = rawNetworkId.replace('-', '_'); // Always use underscore for config lookups
const chainId = pricingConfig.network[NETWORK_ID].chain_id;

// Map to CAIP-2 network format (eip155:chainId)
// Base Mainnet (8453) -> eip155:8453, Base Sepolia (84532) -> eip155:84532
const x402NetworkName = `eip155:${chainId}`;

// Configure facilitator based on network
// Mainnet uses CDP facilitator with JWT auth, Testnet uses public x402.org facilitator
const isMainnet = chainId === 8453;
const facilitatorConfig = isMainnet
  ? createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
  : { url: process.env.X402_FACILITATOR_URL || 'https://www.x402.org/facilitator' };

// Parse JSON bodies
app.use(express.json());

// Health check (free endpoint)
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    agent: 'Kinetix',
    erc8004_token_id: NETWORK_ID === 'base_mainnet' || NETWORK_ID === 'base-mainnet' ? 16892 : 509,
    network: NETWORK_ID,
    wallet: KINETIX_WALLET,
    x402_network: x402NetworkName,
    timestamp: new Date().toISOString()
  });
});

// Initialize x402 resource server with CDP-authenticated facilitator
const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
const resourceServer = new x402ResourceServer(facilitatorClient);

// Register EVM scheme for the network
registerExactEvmScheme(resourceServer, x402NetworkName);

// Register Bazaar extension for discovery
resourceServer.registerExtension(bazaarResourceServerExtension);

// Bazaar discovery metadata
const basicDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: {
    agent_id: "example-agent-123",
    platform: "twitter",
    platform_handle: "@example_agent",
    commitment_description: "Daily consistency check for 7 days"
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Unique identifier for the agent' },
      platform: { type: 'string', description: 'Social platform (twitter, telegram, nostr)' },
      platform_handle: { type: 'string', description: 'Handle or username' },
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
    required: ['agent_id', 'commitment_description', 'criteria']
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
    criteria: { duration_days: 30 },
    verification_type: "time_bound"
  },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Unique identifier' },
      commitment_description: { type: 'string', description: 'What is being verified' },
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
    required: ['agent_id', 'commitment_description', 'criteria']
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
    accepts: {
      scheme: 'exact',
      price: `$${pricingConfig.tiers.basic.price_usdc}`,
      network: x402NetworkName,
      payTo: KINETIX_WALLET,
    },
    description: pricingConfig.tiers.basic.description,
    extensions: {
      ...basicDiscovery
    }
  },
  'POST /api/x402/verify/advanced': {
    accepts: {
      scheme: 'exact',
      price: `$${pricingConfig.tiers.advanced.price_usdc}`,
      network: x402NetworkName,
      payTo: KINETIX_WALLET,
    },
    description: pricingConfig.tiers.advanced.description,
    extensions: {
      ...advancedDiscovery
    }
  },
  'POST /api/x402/verify/premium': {
    accepts: {
      scheme: 'exact',
      price: `$${pricingConfig.tiers.premium.price_usdc}`,
      network: x402NetworkName,
      payTo: KINETIX_WALLET,
    },
    description: pricingConfig.tiers.premium.description,
    extensions: {
      ...premiumDiscovery
    }
  },
};

// Check if we should use test mode (no facilitator validation)
const TEST_MODE = process.env.X402_TEST_MODE === 'true' || process.env.TESTNET_MODE === 'true';

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
          erc8004_token_id: NETWORK_ID === 'base_mainnet' || NETWORK_ID === 'base-mainnet' ? 16892 : 509,
          supportedNetworks: [x402NetworkName],
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
  await attestationService.initialize();
  verificationService.initialize(null, attestationService);
  console.log('✓ Verification services initialized');

  // In test mode, skip facilitator initialization
  if (TEST_MODE) {
    console.log('⚠ Facilitator initialization skipped (test mode enabled)');
    console.log('  Payment validation is bypassed for local testing');
  } else {
    // Production mode: initialize with facilitator
    try {
      await resourceServer.initialize();
      console.log('✓ Resource server initialized with facilitator');
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

// Basic verification endpoint
app.post('/api/x402/verify/basic', async (req, res) => {
  try {
    const { agent_id, platform, platform_handle, commitment_description } = req.body;

    if (!agent_id || !platform || !platform_handle) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agent_id', 'platform', 'platform_handle']
      });
    }

    // Extract payment metadata from x402 headers
    const paymentMetadata = createPaymentMetadata('basic', req);

    // Create commitment
    const commitment = {
      agent_id,
      platform,
      platform_handle,
      description: commitment_description || `Basic verification for ${agent_id}`,
      verification_type: 'consistency',
      criteria: {
        frequency: 'daily',
        duration_days: pricingConfig.tiers.basic.max_duration_days,
        minimum_actions: 1
      },
      payment: paymentMetadata
    };

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
    console.error('Basic verification error:', error);
    res.status(500).json({ error: 'Verification creation failed', details: error.message });
  }
});

// Advanced verification endpoint
app.post('/api/x402/verify/advanced', async (req, res) => {
  try {
    const { agent_id, commitment_description, criteria } = req.body;

    if (!agent_id || !commitment_description || !criteria) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agent_id', 'commitment_description', 'criteria']
      });
    }

    // Extract payment metadata
    const paymentMetadata = createPaymentMetadata('advanced', req);

    // Create commitment with monitoring
    const commitment = {
      agent_id,
      description: commitment_description,
      verification_type: criteria.verification_type || 'consistency',
      criteria: {
        duration_days: Math.min(criteria.duration_days || 7, pricingConfig.tiers.advanced.max_duration_days),
        frequency: criteria.frequency || 'daily',
        ...criteria
      },
      payment: paymentMetadata
    };

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
    console.error('Advanced verification error:', error);
    res.status(500).json({ error: 'Verification creation failed', details: error.message });
  }
});

// Premium verification endpoint
app.post('/api/x402/verify/premium', async (req, res) => {
  try {
    const { agent_id, commitment_description, criteria, verification_type } = req.body;

    if (!agent_id || !commitment_description || !criteria) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agent_id', 'commitment_description', 'criteria']
      });
    }

    // Extract payment metadata
    const paymentMetadata = createPaymentMetadata('premium', req);

    // Create premium commitment (supports all verification types)
    const commitment = {
      agent_id,
      description: commitment_description,
      verification_type: verification_type || 'consistency',
      criteria: {
        duration_days: Math.min(criteria.duration_days || 7, pricingConfig.tiers.premium.max_duration_days),
        ...criteria
      },
      payment: paymentMetadata
    };

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
    console.error('Premium verification error:', error);
    res.status(500).json({ error: 'Verification creation failed', details: error.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Start server
const PORT = process.env.X402_PORT || 3001;

initializeServices()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n=== Kinetix x402 Verification Service ===`);
      console.log(`✓ Server listening on port ${PORT}`);
      console.log(`✓ Network: ${NETWORK_ID} (Chain ID: ${chainId})`);
      console.log(`✓ x402 Network: ${x402NetworkName}`);
      console.log(`✓ Receiving payments at: ${KINETIX_WALLET}`);
      console.log(`✓ Facilitator: ${facilitatorConfig.url}`);
      console.log(`\nEndpoints:`);
      console.log(`  GET  /health                      - Free health check`);
      console.log(`  POST /api/x402/verify/basic       - $${pricingConfig.tiers.basic.price_usdc} USDC`);
      console.log(`  POST /api/x402/verify/advanced    - $${pricingConfig.tiers.advanced.price_usdc} USDC`);
      console.log(`  POST /api/x402/verify/premium     - $${pricingConfig.tiers.premium.price_usdc} USDC`);
      console.log(`\nReady for autonomous agent payments!\n`);
    });
  })
  .catch(error => {
    console.error('Failed to initialize services:', error);
    process.exit(1);
  });

module.exports = app;
