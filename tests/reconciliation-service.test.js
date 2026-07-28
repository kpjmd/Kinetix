// tests/reconciliation-service.test.js
// Tests for the automatic ERC-8004 on-chain retry/reconciliation job.
// Mocks data-store, erc8004-reputation, ipfs-manager, erc8004-lookup — no
// live RPC calls.

jest.mock('../services/data-store');
jest.mock('../utils/erc8004-reputation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  submitAttestation: jest.fn(),
  networkName: 'base_sepolia'
}));
jest.mock('../utils/ipfs-manager', () => ({
  uploadJSON: jest.fn()
}));
jest.mock('../utils/erc8004-lookup', () => ({
  resolveTokenId: jest.fn()
}));

const dataStore = require('../services/data-store');
const reputationService = require('../utils/erc8004-reputation');
const ipfsManager = require('../utils/ipfs-manager');
const erc8004Lookup = require('../utils/erc8004-lookup');
const { ReconciliationService } = require('../services/reconciliation-service');

function makeReceipt(overrides = {}) {
  return {
    receipt_id: 'rcpt_kx_test',
    recipient: { agent_id: 'test_agent', wallet_address: '0x' + 'a'.repeat(40), erc8004_token_id: '42' },
    reputation_context: { ipfs_uri: 'ipfs://Qm123' },
    metadata: { onchain_status: 'pending' },
    ...overrides
  };
}

describe('ReconciliationService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    dataStore.saveAttestation.mockResolvedValue(undefined);
    dataStore.saveReputationSubmission.mockResolvedValue(undefined);
    service = new ReconciliationService();
  });

  describe('reconcileOne', () => {
    it('submits successfully when the token ID and IPFS hash are already present', async () => {
      const receipt = makeReceipt();
      reputationService.submitAttestation.mockResolvedValue({
        feedbackIndex: '3',
        txHash: '0xabc',
        blockNumber: 123
      });

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('submitted');
      expect(receipt.metadata.onchain_status).toBe('submitted');
      expect(erc8004Lookup.resolveTokenId).not.toHaveBeenCalled();
      expect(ipfsManager.uploadJSON).not.toHaveBeenCalled();
      expect(dataStore.saveReputationSubmission).toHaveBeenCalledWith(
        'rcpt_kx_test',
        expect.objectContaining({ status: 'success' })
      );
    });

    it('resolves a missing token ID via erc8004-lookup before submitting', async () => {
      const receipt = makeReceipt({ recipient: { agent_id: 'a', wallet_address: '0x' + 'b'.repeat(40), erc8004_token_id: null } });
      erc8004Lookup.resolveTokenId.mockResolvedValue('99');
      reputationService.submitAttestation.mockResolvedValue({ feedbackIndex: '1', txHash: '0xdef', blockNumber: 1 });

      const outcome = await service.reconcileOne(receipt);

      expect(erc8004Lookup.resolveTokenId).toHaveBeenCalledWith(receipt.recipient.wallet_address, 'base_sepolia');
      expect(receipt.recipient.erc8004_token_id).toBe('99');
      expect(outcome.status).toBe('submitted');
    });

    it('uploads to IPFS when no ipfs_uri is present yet', async () => {
      const receipt = makeReceipt({ reputation_context: {} });
      ipfsManager.uploadJSON.mockResolvedValue({ ipfsHash: 'Qmxyz', gatewayUrl: 'https://gw/Qmxyz' });
      reputationService.submitAttestation.mockResolvedValue({ feedbackIndex: '1', txHash: '0xdef', blockNumber: 1 });

      const outcome = await service.reconcileOne(receipt);

      expect(ipfsManager.uploadJSON).toHaveBeenCalled();
      expect(receipt.reputation_context.ipfs_uri).toBe('ipfs://Qmxyz');
      expect(outcome.status).toBe('submitted');
    });

    it('marks self-verification receipts as skipped_self_verification', async () => {
      const receipt = makeReceipt();
      reputationService.submitAttestation.mockRejectedValue(new Error('SELF_VERIFICATION: not allowed'));

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('skipped_self_verification');
      expect(receipt.metadata.onchain_status).toBe('skipped_self_verification');
    });

    it('marks unregistered recipients as skipped_not_registered', async () => {
      const receipt = makeReceipt();
      reputationService.submitAttestation.mockRejectedValue(
        new Error('Recipient "x" has no erc8004_token_id. They must be registered on ERC-8004.')
      );

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('skipped_not_registered');
    });

    it('does not retry once the retry cap has been reached', async () => {
      const receipt = makeReceipt({ metadata: { onchain_status: 'failed', onchain_retry_count: 10 } });

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('failed_permanent');
      expect(reputationService.initialize).not.toHaveBeenCalled();
    });

    it('does not burn retry budget when Kinetix\'s own identity is unreadable', async () => {
      // This fired on the x402 service, whose volume had no identity record.
      // Untyped it fell through to `failed`, counted as a submission attempt,
      // and would have escalated every receipt issued during the outage to
      // terminal failed_permanent after ten runs — for an operator-fixable
      // config problem where nothing was ever submitted.
      const receipt = makeReceipt({ metadata: { onchain_status: 'pending', onchain_retry_count: 3 } });
      const err = new Error('Kinetix not registered on base_mainnet. Run registration first.');
      err.code = 'ISSUER_NOT_REGISTERED';
      reputationService.submitAttestation.mockRejectedValue(err);

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('deferred');
      expect(receipt.metadata.onchain_retry_count).toBe(3);
      expect(receipt.metadata.onchain_status).not.toBe('failed_permanent');
    });

    it('escalates to failed_permanent once a generic failure reaches the retry cap', async () => {
      const receipt = makeReceipt({ metadata: { onchain_status: 'failed', onchain_retry_count: 9 } });
      reputationService.submitAttestation.mockRejectedValue(new Error('network error'));

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('failed_permanent');
      expect(receipt.metadata.onchain_retry_count).toBe(10);
    });
  });

  describe('reconcileAll', () => {
    it('only reconciles attestations not already in a terminal state', async () => {
      const submitted = makeReceipt({ receipt_id: 'a', metadata: { onchain_status: 'submitted' } });
      const skippedSelf = makeReceipt({ receipt_id: 'b', metadata: { onchain_status: 'skipped_self_verification' } });
      const pending = makeReceipt({ receipt_id: 'c', metadata: { onchain_status: 'pending' } });

      dataStore.listAttestations.mockResolvedValue([submitted, skippedSelf, pending]);
      jest.spyOn(service, 'reconcileOne').mockResolvedValue({ receipt_id: 'c', status: 'submitted' });

      const result = await service.reconcileAll();

      expect(service.reconcileOne).toHaveBeenCalledTimes(1);
      expect(service.reconcileOne).toHaveBeenCalledWith(pending);
      expect(result.succeeded).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('tallies succeeded/skipped/failed correctly', async () => {
      const receipts = [
        makeReceipt({ receipt_id: 'a', metadata: { onchain_status: 'pending' } }),
        makeReceipt({ receipt_id: 'b', metadata: { onchain_status: 'pending' } }),
        makeReceipt({ receipt_id: 'c', metadata: { onchain_status: 'pending' } })
      ];
      dataStore.listAttestations.mockResolvedValue(receipts);
      jest.spyOn(service, 'reconcileOne')
        .mockResolvedValueOnce({ receipt_id: 'a', status: 'submitted' })
        .mockResolvedValueOnce({ receipt_id: 'b', status: 'skipped_not_registered' })
        .mockResolvedValueOnce({ receipt_id: 'c', status: 'failed' });

      const result = await service.reconcileAll();

      expect(result.succeeded).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('skips a run already in progress instead of overlapping', async () => {
      dataStore.listAttestations.mockResolvedValue([makeReceipt()]);
      jest.spyOn(service, 'reconcileOne').mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ receipt_id: 'x', status: 'submitted' }), 20))
      );

      const first = service.reconcileAll();
      const second = await service.reconcileAll();

      expect(second).toEqual({ succeeded: 0, skipped: 0, failed: 0, results: [] });
      await first;
    });
  });
});
