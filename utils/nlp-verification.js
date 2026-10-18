// /utils/nlp-verification.js
// Claude tool definitions for verification operations

const { COLLECTOR_PLATFORMS } = require('./monitoring-target');
const { normalizeNostrPubkey } = require('./clawstr-api');

const VERIFICATION_TOOLS = [
  {
    name: 'verification_create',
    description: 'Create a new verification request for an agent commitment. Use when the user asks to verify, monitor, or create a proof of action.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Agent identifier (username or pubkey)'
        },
        description: {
          type: 'string',
          description: 'What the agent is committing to do'
        },
        verification_type: {
          type: 'string',
          enum: ['consistency', 'quality', 'time_bound'],
          description: 'Type of verification: consistency (regular frequency), quality (metrics-based), time_bound (deadline-based)'
        },
        platform: {
          type: 'string',
          enum: COLLECTOR_PLATFORMS,
          description: 'Platform to monitor. agent_id must be the agent\'s identity there: a Moltbook username, or a Clawstr npub/hex pubkey.'
        },
        criteria: {
          type: 'object',
          description: 'Verification criteria (varies by type)'
        }
      },
      required: ['agent_id', 'description', 'verification_type', 'platform']
    }
  },
  {
    name: 'verification_status',
    description: 'Check the status of a verification. Use when the user asks about verification progress.',
    input_schema: {
      type: 'object',
      properties: {
        verification_id: {
          type: 'string',
          description: 'Verification/commitment ID (cmt_kx_...)'
        }
      },
      required: ['verification_id']
    }
  },
  {
    name: 'verification_list_active',
    description: 'List all active verifications being monitored.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'attestation_lookup',
    description: 'Look up an attestation receipt by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        receipt_id: {
          type: 'string',
          description: 'Receipt ID (rcpt_kx_...)'
        }
      },
      required: ['receipt_id']
    }
  }
];

/**
 * Execute a verification tool
 */
async function executeVerificationTool(toolName, input, services) {
  const { verificationService } = services;
  const dataStore = require('../services/data-store');

  switch (toolName) {
    case 'verification_create':
      try {
        // Without a platform identity the commitment was created unwatchable:
        // monitoring had no profile or pubkey to fetch, and closed it.
        if (!COLLECTOR_PLATFORMS.includes(input.platform)) {
          return {
            success: false,
            error: `Unsupported platform "${input.platform}". Kinetix can monitor: ${COLLECTOR_PLATFORMS.join(', ')}`
          };
        }
        let pubkey = '';
        if (input.platform === 'clawstr') {
          try {
            pubkey = normalizeNostrPubkey(input.agent_id);
          } catch (error) {
            return {
              success: false,
              error: 'For clawstr, agent_id must be the agent\'s npub or 64-character hex pubkey'
            };
          }
        }

        const result = await verificationService.createVerification({
          agent_id: input.agent_id,
          pubkey,
          platform_profiles: { [input.platform]: input.agent_id },
          description: input.description,
          verification_type: input.verification_type,
          criteria: {
            ...input.criteria,
            // After the spread: the validated value must win over any
            // criteria.platform the model also supplied.
            platform: input.platform
          }
        });
        return {
          success: true,
          verification_id: result.verification_id,
          status: result.status,
          expected_completion: result.expected_completion
        };
      } catch (error) {
        return { success: false, error: error.message };
      }

    case 'verification_status':
      try {
        const status = await verificationService.getStatus(input.verification_id);
        if (!status) {
          return { success: false, error: 'Verification not found' };
        }
        return { success: true, ...status };
      } catch (error) {
        return { success: false, error: error.message };
      }

    case 'verification_list_active':
      try {
        const activeCommitments = await dataStore.listCommitments('active');
        return {
          success: true,
          count: activeCommitments.length,
          verifications: activeCommitments.map(c => ({
            verification_id: c.commitment_id,
            agent_id: c.agent_id,
            verification_type: c.verification_type,
            description: c.description,
            evidence_count: c.evidence.length,
            end_date: c.end_date
          }))
        };
      } catch (error) {
        return { success: false, error: error.message };
      }

    case 'attestation_lookup':
      try {
        const receipt = await dataStore.loadAttestation(input.receipt_id);
        if (!receipt) {
          return { success: false, error: 'Attestation not found' };
        }
        return {
          success: true,
          receipt_id: receipt.receipt_id,
          recipient: receipt.recipient.agent_id,
          status: receipt.verification_result.status,
          overall_score: receipt.verification_result.overall_score,
          issued_at: receipt.metadata.issued_at
        };
      } catch (error) {
        return { success: false, error: error.message };
      }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { VERIFICATION_TOOLS, executeVerificationTool };
