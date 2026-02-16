// /api/routes/verification.js
// REST endpoints for verification services

const { Router } = require('express');
const verificationTypes = require('../../skills/verification/types.json');
const pricing = require('../../skills/verification/pricing.json');
const tokenomics = require('../../config/tokenomics.json');
const verificationRules = require('../../config/verification-rules.json');

/**
 * Create verification routes
 */
function createVerificationRoutes(services) {
  const router = Router();
  const { verificationService, attestationService } = services;
  const dataStore = require('../../services/data-store');

  /**
   * GET /api/v1/manifest
   * Machine-readable service manifest
   */
  router.get('/manifest', (req, res) => {
    res.json({
      service: {
        name: 'Kinetix Protocol',
        version: '1.0.0',
        description: 'Reputation verification infrastructure for AI agents'
      },
      verification_types: verificationTypes.verification_types.map(vt => ({
        id: vt.id,
        name: vt.name,
        description: vt.description,
        scoring: vt.scoring,
        criteria_schema: getCriteriaSchema(vt.id)
      })),
      pricing: {
        usdc: pricing.pricing.usdc,
        kinetix: pricing.pricing.kinetix,
        difficulty_multipliers: pricing.difficulty_multipliers
      },
      supported_platforms: Object.keys(verificationRules.evidence_requirements),
      token: tokenomics.token,
      issuer: {
        pubkey: attestationService.signingWallet?.address || 'not_initialized',
        platform_profiles: {
          moltbook: 'https://www.moltbook.com/u/Kinetix',
          clawstr: 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5'
        }
      },
      endpoints: {
        verify: 'POST /api/v1/verify',
        status: 'GET /api/v1/verification/:id/status',
        attestation: 'GET /api/v1/attestation/:receipt_id',
        manifest: 'GET /api/v1/manifest'
      }
    });
  });

  /**
   * POST /api/v1/verify
   * Create a new verification request
   */
  router.post('/verify', async (req, res, next) => {
    try {
      const { agent_id, pubkey, platform_profiles, commitment, payment } = req.body;

      if (!agent_id || !commitment || !commitment.description || !commitment.type) {
        return res.status(400).json({
          error: 'Missing required fields: agent_id, commitment.description, commitment.type'
        });
      }

      const result = await verificationService.createVerification({
        agent_id,
        pubkey: pubkey || '',
        platform_profiles: platform_profiles || {},
        description: commitment.description,
        verification_type: commitment.type,
        criteria: commitment.criteria || {},
        payment: payment || null,
        start_date: commitment.start_date
      });

      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/v1/verification/:id/status
   * Check verification progress
   */
  router.get('/verification/:id/status', async (req, res, next) => {
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

  /**
   * GET /api/v1/attestation/:receipt_id
   * Retrieve an attestation receipt
   */
  router.get('/attestation/:receipt_id', async (req, res, next) => {
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

  return router;
}

/**
 * Helper: Get criteria schema for a verification type
 */
function getCriteriaSchema(type) {
  switch (type) {
    case 'consistency':
      return {
        frequency: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'custom'], required: true },
        duration_days: { type: 'number', required: true },
        platform: { type: 'string', required: true },
        action_type: { type: 'string', default: 'post' },
        minimum_actions: { type: 'number', required: true },
        grace_period_hours: { type: 'number', default: 24 },
        content_requirements: {
          type: 'object',
          properties: {
            min_length: { type: 'number' },
            required_tags: { type: 'array' },
            forbidden_content: { type: 'array' }
          }
        }
      };
    case 'quality':
      return {
        platform: { type: 'string', required: true },
        action_type: { type: 'string', required: true },
        quality_metrics: {
          type: 'object',
          properties: {
            response_time_minutes: { type: 'number' },
            minimum_length: { type: 'number' },
            required_format: { type: 'string' },
            satisfaction_threshold: { type: 'number' },
            technical_accuracy: { type: 'boolean' }
          }
        },
        minimum_samples: { type: 'number', required: true },
        duration_days: { type: 'number', required: true }
      };
    case 'time_bound':
      return {
        milestones: {
          type: 'array',
          required: true,
          items: {
            milestone_id: { type: 'string', required: true },
            description: { type: 'string' },
            deadline: { type: 'string', format: 'ISO8601', required: true },
            required_deliverable: { type: 'string' },
            grace_period_hours: { type: 'number', default: 0 }
          }
        },
        allow_early_completion: { type: 'boolean', default: true },
        penalty_per_late_hour: { type: 'number', default: 1 }
      };
    default:
      return {};
  }
}

module.exports = createVerificationRoutes;
