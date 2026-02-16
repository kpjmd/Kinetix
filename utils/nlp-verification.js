// /utils/nlp-verification.js
// Claude tool definitions for verification operations

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
          description: 'Platform to monitor (moltbook, clawstr, telegram, etc.)'
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
        const result = await verificationService.createVerification({
          agent_id: input.agent_id,
          description: input.description,
          verification_type: input.verification_type,
          criteria: {
            platform: input.platform,
            ...input.criteria
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
