// tests/verification-service-eas.test.js
// Tests for VerificationService's on-chain submission orchestration
// (_submitToEAS, _submitToReputationRegistry, issueAttestation's ordering).
//
// A separate file from tests/verification-service.test.js rather than an
// addition to it: jest.mock is file-scoped, and that file deliberately mocks
// only ../services/data-store (its scoring-algorithm tests never reach the
// on-chain path at all). Mocking eas-attestation/erc8004-reputation/
// ipfs-manager there too would be silent overkill for what it tests, so this
// file exists instead — see also the safety-incident comment in
// tests/x402-server.test.js for why every module in this call chain MUST be
// mocked, with no exceptions, before this file is ever run.

jest.mock('../services/data-store');
jest.mock('../utils/eas-attestation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  submitAttestation: jest.fn(),
  networkName: 'base_sepolia',
  network: { schemaUID: '0x' + 'ab'.repeat(32) }
}));
jest.mock('../utils/erc8004-reputation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  submitAttestation: jest.fn(),
  networkName: 'base_sepolia'
}));
jest.mock('../utils/ipfs-manager', () => ({
  uploadJSON: jest.fn()
}));
jest.mock('../utils/moltbook-announce', () => ({
  announceVerification: jest.fn().mockResolvedValue(undefined)
}));

const dataStore = require('../services/data-store');
const easService = require('../utils/eas-attestation');
const reputationService = require('../utils/erc8004-reputation');
const ipfsManager = require('../utils/ipfs-manager');
const { VerificationService } = require('../services/verification-service');
// Real, unmocked — generateReceipt/signing is pure local computation (EIP-191
// personal_sign over a canonical hash), never a network call. Jest sets
// NODE_ENV=test by default, so if no valid KINETIX_SIGNING_KEY is present
// this falls back to an ephemeral in-memory wallet rather than failing.
const { AttestationService } = require('../services/attestation-service');

function makeReceipt(overrides = {}) {
  return {
    receipt_id: 'rcpt_kx_test',
    recipient: { agent_id: 'test_agent', wallet_address: '0x' + 'a'.repeat(40), erc8004_token_id: null },
    commitment: { verification_type: 'consistency' },
    verification_result: { overall_score: 90, status: 'verified' },
    reputation_context: { ipfs_uri: 'ipfs://Qm123' },
    metadata: { onchain_status: 'pending' },
    eas: {
      schema_uid: null, attestation_uid: null, tx_hash: null,
      network: null, explorer_url: null, submitted_at: null, status: 'pending'
    },
    ...overrides
  };
}

describe('VerificationService on-chain submission', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    dataStore.saveAttestation.mockResolvedValue(undefined);
    dataStore.saveEasSubmission.mockResolvedValue(undefined);
    dataStore.saveReputationSubmission.mockResolvedValue(undefined);
    service = new VerificationService();
  });

  describe('_submitToEAS', () => {
    it('populates eas.* on a successful submission, including recipient/anchor_mode', async () => {
      const receipt = makeReceipt();
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: '0x' + 'a'.repeat(40), anchorMode: 'recipient'
      });

      await service._submitToEAS(receipt);

      expect(receipt.eas.status).toBe('submitted');
      expect(receipt.eas.attestation_uid).toBe('0xuid');
      expect(receipt.eas.tx_hash).toBe('0xtx');
      expect(receipt.eas.recipient).toBe('0x' + 'a'.repeat(40));
      expect(receipt.eas.anchor_mode).toBe('recipient');
      expect(dataStore.saveEasSubmission).toHaveBeenCalledWith(
        'rcpt_kx_test',
        expect.objectContaining({ status: 'success', anchor_mode: 'recipient' })
      );
    });

    it('records the zero-address anchor mode for a wallet-less recipient', async () => {
      const receipt = makeReceipt({ recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null } });
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: '0x0000000000000000000000000000000000000000', anchorMode: 'unattributed'
      });

      await service._submitToEAS(receipt);

      expect(receipt.eas.status).toBe('submitted');
      expect(receipt.eas.anchor_mode).toBe('unattributed');
      expect(receipt.eas.recipient).toBe('0x0000000000000000000000000000000000000000');
    });

    it('marks eas.status "failed" on a generic error, and never throws', async () => {
      const receipt = makeReceipt();
      easService.submitAttestation.mockRejectedValue(new Error('rpc timeout'));

      await expect(service._submitToEAS(receipt)).resolves.toBeUndefined();

      expect(receipt.eas.status).toBe('failed');
      expect(dataStore.saveEasSubmission).toHaveBeenCalledWith(
        'rcpt_kx_test',
        expect.objectContaining({ status: 'failed' })
      );
    });

    it('marks eas.status "pending" (not "failed") on a gas-ceiling error, so it is retried rather than penalized', async () => {
      const receipt = makeReceipt();
      const err = new Error('GAS_CEILING: gas price too high');
      err.code = 'GAS_CEILING';
      easService.submitAttestation.mockRejectedValue(err);

      await service._submitToEAS(receipt);

      expect(receipt.eas.status).toBe('pending');
    });

    it('never produces skipped_no_wallet — that status is no longer reachable from this path', async () => {
      // Historical regression check: eas-attestation.js used to throw
      // NO_WALLET synchronously, which this method mapped to
      // 'skipped_no_wallet'. It no longer throws that at all (zero-address
      // fallback instead), so nothing here should ever produce that status.
      const receipt = makeReceipt({ recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null } });
      easService.submitAttestation.mockRejectedValue(new Error('some other unrelated failure'));

      await service._submitToEAS(receipt);

      expect(receipt.eas.status).not.toBe('skipped_no_wallet');
      expect(receipt.eas.status).toBe('failed');
    });

    it('keeps eas.status "submitted" when the post-success persistence save fails', async () => {
      const receipt = makeReceipt();
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: '0x' + 'a'.repeat(40), anchorMode: 'recipient'
      });
      dataStore.saveAttestation.mockRejectedValueOnce(new Error('disk full'));

      await service._submitToEAS(receipt);

      expect(receipt.eas.status).toBe('submitted');
    });
  });

  describe('issueAttestation ordering', () => {
    it('submits to the Reputation Registry before EAS, to avoid a nonce race on the shared signing wallet', async () => {
      const commitment = {
        commitment_id: 'cmt_kx_test',
        agent_id: 'test_agent',
        pubkey: '',
        wallet_address: '0x' + 'a'.repeat(40),
        platform_profiles: {},
        erc8004_token_id: null,
        description: 'test',
        verification_type: 'consistency',
        criteria: {},
        created_at: new Date().toISOString(),
        start_date: new Date().toISOString(),
        end_date: new Date().toISOString(),
        evidence: [],
        scoring_result: { overall_score: 90, status: 'verified' }
      };

      dataStore.loadCommitment.mockResolvedValue(commitment);
      dataStore.saveCommitment.mockResolvedValue(undefined);
      ipfsManager.uploadJSON.mockResolvedValue({ ipfsHash: 'Qmxyz', gatewayUrl: 'https://gw/Qmxyz' });

      service.attestationService = new AttestationService();
      await service.attestationService.initialize();

      const callOrder = [];
      reputationService.submitAttestation.mockImplementation(async () => {
        callOrder.push('erc8004');
        const err = new Error('no erc8004_token_id');
        err.code = 'NOT_REGISTERED';
        throw err;
      });
      easService.submitAttestation.mockImplementation(async () => {
        callOrder.push('eas');
        return {
          uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
          recipient: '0x' + 'a'.repeat(40), anchorMode: 'recipient'
        };
      });

      await service.issueAttestation('cmt_kx_test');

      expect(callOrder).toEqual(['erc8004', 'eas']);
    });
  });
});
