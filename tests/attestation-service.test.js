// tests/attestation-service.test.js
// Tests for attestation receipt generation and signature verification

const { AttestationService } = require('../services/attestation-service');

describe('AttestationService', () => {
  let service;

  beforeEach(async () => {
    // Use a deterministic key for testing
    process.env.KINETIX_SIGNING_KEY = '0x' + '1'.repeat(64);
    service = new AttestationService();
    await service.initialize();
  });

  describe('generateReceipt', () => {
    it('should generate a receipt matching the schema', async () => {
      const commitment = {
        commitment_id: 'cmt_kx_test123',
        agent_id: 'test_agent',
        pubkey: '0x' + 'a'.repeat(40),
        platform_profiles: { moltbook: 'TestAgent' },
        description: 'Post daily for 7 days',
        verification_type: 'consistency',
        criteria: { frequency: 'daily', duration_days: 7 },
        difficulty: 'standard',
        created_at: '2025-02-01T00:00:00Z',
        start_date: '2025-02-01T00:00:00Z',
        end_date: '2025-02-08T00:00:00Z',
        evidence: [
          {
            evidence_id: 'ev_001',
            timestamp: '2025-02-01T09:00:00Z',
            platform: 'moltbook',
            action_type: 'post',
            action_url: 'https://www.moltbook.com/p/1',
            content_hash: 'sha256:abc123',
            verification_method: 'api_confirmed'
          }
        ],
        scoring_result: {
          status: 'verified',
          completion_rate: 100,
          quality_score: 90,
          timeliness_score: 95,
          overall_score: 94,
          actions_completed: 7,
          actions_missed: 0,
          evidence_count: 1
        }
      };

      const receipt = await service.generateReceipt(commitment);

      // Schema checks
      expect(receipt.receipt_version).toBe('1.1.0');
      expect(receipt.receipt_id).toMatch(/^rcpt_kx_/);
      expect(receipt.receipt_type).toBe('verification_attestation');
      expect(receipt.issuer.name).toBe('Kinetix');
      expect(receipt.recipient.agent_id).toBe('test_agent');
      expect(receipt.commitment.commitment_id).toBe('cmt_kx_test123');
      expect(receipt.verification_result.status).toBe('verified');
      expect(receipt.evidence).toHaveLength(1);
      expect(receipt.metadata.verification_difficulty).toBe('standard');
      expect(receipt.metadata.dispute_window_days).toBe(7);

      // Signature checks
      expect(receipt.signatures.receipt_hash).toMatch(/^sha256:/);
      expect(receipt.signatures.kinetix_signature).toBeTruthy();
      expect(receipt.signatures.signature_algorithm).toBe('ECDSA_secp256k1');
      expect(receipt.signatures.signature_scheme).toBe('eip191_personal_sign(keccak256(canonical_sorted_json))');
      expect(receipt.signatures.canonical_hash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('recipient.wallet_address', () => {
    const commitmentWith = extra => ({
      commitment_id: 'cmt_kx_wallet',
      agent_id: 'test_agent',
      platform_profiles: {},
      description: 'Test',
      verification_type: 'consistency',
      criteria: {},
      difficulty: 'trivial',
      created_at: '2025-02-01T00:00:00Z',
      start_date: '2025-02-01T00:00:00Z',
      end_date: '2025-02-02T00:00:00Z',
      evidence: [],
      scoring_result: { status: 'failed', overall_score: 0, evidence_count: 0 },
      ...extra
    });

    it('does not treat a Nostr pubkey as a wallet address', async () => {
      // This field used to alias commitment.pubkey. For Clawstr that is a Nostr
      // key: truthy, so it passed the NO_WALLET check, and EAS then rejected it
      // and recorded the non-terminal status 'failed', which reconciliation
      // retried every 3h to the cap.
      const receipt = await service.generateReceipt(
        commitmentWith({ pubkey: '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55' })
      );

      expect(receipt.recipient.wallet_address).toBe('');
      // The Nostr identity still belongs on the receipt, just not as a wallet.
      expect(receipt.recipient.pubkey).toMatch(/^304c37f5/);
    });

    it('keeps an explicitly supplied EVM address', async () => {
      const wallet = '0x821a61d2C3E02446eD03285df1618639eF25D2b9';
      const receipt = await service.generateReceipt(
        commitmentWith({ pubkey: 'npub1whatever', wallet_address: wallet })
      );

      expect(receipt.recipient.wallet_address).toBe(wallet);
    });
  });

  describe('verifyReceipt', () => {
    it('should verify a valid receipt signature', async () => {
      const commitment = {
        commitment_id: 'cmt_kx_test456',
        agent_id: 'test_agent',
        pubkey: '0x' + 'b'.repeat(40),
        platform_profiles: {},
        description: 'Test commitment',
        verification_type: 'consistency',
        criteria: {},
        difficulty: 'trivial',
        created_at: '2025-02-01T00:00:00Z',
        start_date: '2025-02-01T00:00:00Z',
        end_date: '2025-02-02T00:00:00Z',
        evidence: [],
        scoring_result: {
          status: 'failed',
          overall_score: 0,
          evidence_count: 0
        }
      };

      const receipt = await service.generateReceipt(commitment);
      const isValid = service.verifyReceipt(receipt);
      expect(isValid).toBe(true);
    });

    it('should reject a tampered receipt', async () => {
      const commitment = {
        commitment_id: 'cmt_kx_test789',
        agent_id: 'test_agent',
        pubkey: '',
        platform_profiles: {},
        description: 'Test',
        verification_type: 'consistency',
        criteria: {},
        difficulty: 'trivial',
        created_at: '2025-02-01T00:00:00Z',
        start_date: '2025-02-01T00:00:00Z',
        end_date: '2025-02-02T00:00:00Z',
        evidence: [],
        scoring_result: {
          status: 'failed',
          overall_score: 0,
          evidence_count: 0
        }
      };

      const receipt = await service.generateReceipt(commitment);

      // Tamper with the score
      receipt.verification_result.status = 'verified';
      receipt.verification_result.overall_score = 100;

      const isValid = service.verifyReceipt(receipt);
      expect(isValid).toBe(false);
    });
  });
});
