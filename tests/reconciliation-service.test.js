// tests/reconciliation-service.test.js
// Tests for the automatic ERC-8004/EAS on-chain retry/reconciliation job.
// Mocks data-store, erc8004-reputation, eas-attestation, ipfs-manager,
// erc8004-lookup — no live RPC calls, no real signing key use.
//
// IMPORTANT: reconcileOne() always runs BOTH the ERC-8004 leg
// (_reconcileErc8004) and the EAS leg (_reconcileEas) — see
// services/reconciliation-service.js. Every module either of those legs can
// reach a live network or the real KINETIX_SIGNING_KEY through MUST be
// mocked here, with no exceptions, even in tests that only care about the
// ERC-8004 outcome. An earlier version of this file mocked erc8004-reputation
// but not eas-attestation; because _reconcileEas lazily creates a default
// 'pending' eas block for any receipt missing one (P2c) and had no bearing on
// the assertions those tests cared about, EVERY test in this file silently
// fell through to the real eas-attestation.js singleton, which reads a real
// signing key from .env via `require('dotenv').config()` at module load and
// broadcast real attest() transactions to Base Sepolia. Do not remove or
// narrow the eas-attestation mock below without re-verifying this cannot
// recur — grep this file for `jest.mock` and confirm every reconciliation
// dependency listed in services/reconciliation-service.js's own requires is
// covered before running it.

jest.mock('../services/data-store');
jest.mock('../utils/erc8004-reputation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  submitAttestation: jest.fn(),
  networkName: 'base_sepolia'
}));
jest.mock('../utils/eas-attestation', () => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  submitAttestation: jest.fn(),
  networkName: 'base_sepolia',
  network: { schemaUID: '0x' + 'ab'.repeat(32) }
}));
jest.mock('../utils/ipfs-manager', () => ({
  uploadJSON: jest.fn()
}));
jest.mock('../utils/erc8004-lookup', () => ({
  resolveTokenId: jest.fn()
}));

const dataStore = require('../services/data-store');
const reputationService = require('../utils/erc8004-reputation');
const easService = require('../utils/eas-attestation');
const ipfsManager = require('../utils/ipfs-manager');
const erc8004Lookup = require('../utils/erc8004-lookup');
const { ReconciliationService } = require('../services/reconciliation-service');

function makeReceipt(overrides = {}) {
  return {
    receipt_id: 'rcpt_kx_test',
    recipient: { agent_id: 'test_agent', wallet_address: '0x' + 'a'.repeat(40), erc8004_token_id: '42' },
    reputation_context: { ipfs_uri: 'ipfs://Qm123' },
    metadata: { onchain_status: 'pending' },
    // No `eas` block by default — exercises the P2c lazy-create path (with
    // the mocked easService above, never the real one) unless a test
    // explicitly overrides it.
    ...overrides
  };
}

const ethersZeroAddress = '0x0000000000000000000000000000000000000000';

function makeEasReceipt(easOverrides = {}, overrides = {}) {
  return makeReceipt({
    eas: {
      schema_uid: null,
      attestation_uid: null,
      tx_hash: null,
      network: null,
      explorer_url: null,
      submitted_at: null,
      status: 'pending',
      ...easOverrides
    },
    ...overrides
  });
}

describe('ReconciliationService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    dataStore.saveAttestation.mockResolvedValue(undefined);
    dataStore.saveReputationSubmission.mockResolvedValue(undefined);
    dataStore.saveEasSubmission.mockResolvedValue(undefined);
    // Every unmocked EAS submission attempt in these tests must fail loudly
    // and instantly, rather than silently falling through to a real network
    // call — see the file-header warning above.
    easService.submitAttestation.mockRejectedValue(
      new Error('easService.submitAttestation was not stubbed for this test')
    );
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

    it('resolves a missing token ID via erc8004-lookup before submitting, without mutating recipient', async () => {
      const receipt = makeReceipt({ recipient: { agent_id: 'a', wallet_address: '0x' + 'b'.repeat(40), erc8004_token_id: null } });
      erc8004Lookup.resolveTokenId.mockResolvedValue('99');
      reputationService.submitAttestation.mockResolvedValue({ feedbackIndex: '1', txHash: '0xdef', blockNumber: 1 });

      const outcome = await service.reconcileOne(receipt);

      expect(erc8004Lookup.resolveTokenId).toHaveBeenCalledWith(receipt.recipient.wallet_address, 'base_sepolia');
      // recipient.* is inside the signed canonical payload and must never be
      // mutated post-issuance — the resolved token lands in a dedicated
      // mutable metadata field instead (utils/receipt-identity.js).
      expect(receipt.recipient.erc8004_token_id).toBe(null);
      expect(receipt.metadata.resolved_erc8004_token_id).toBe('99');
      expect(receipt.metadata.resolved_erc8004_token_id_at).toEqual(expect.any(String));
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

    // P3: skipped_not_registered used to be flatly terminal-or-not depending
    // on a static list that didn't include it, causing it to be re-attempted
    // (and its whole submit path re-run) forever, contradicting the "Terminal"
    // claim in REPUTATION_RECEIPT.MD. _isErcTerminal now makes it terminal
    // only when nothing could ever change the outcome.
    it('P3: returns skipped_not_registered immediately, without a submission attempt, for a wallet-less recipient', async () => {
      const receipt = makeReceipt({
        recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null },
        metadata: { onchain_status: 'pending' }
      });
      erc8004Lookup.resolveTokenId.mockResolvedValue(null);

      const outcome = await service.reconcileOne(receipt);

      expect(outcome.status).toBe('skipped_not_registered');
      expect(receipt.metadata.onchain_status).toBe('skipped_not_registered');
      // Returns before the IPFS branch and before ever marking 'submitting'.
      expect(ipfsManager.uploadJSON).not.toHaveBeenCalled();
      expect(reputationService.submitAttestation).not.toHaveBeenCalled();
    });

    it('P3: still retries a wallet-bearing recipient whose token id has not resolved yet', async () => {
      const receipt = makeReceipt({
        recipient: { agent_id: 'a', wallet_address: '0x' + 'c'.repeat(40), erc8004_token_id: null },
        metadata: { onchain_status: 'skipped_not_registered' }
      });
      erc8004Lookup.resolveTokenId.mockResolvedValue(null);

      const outcome = await service.reconcileOne(receipt);

      expect(erc8004Lookup.resolveTokenId).toHaveBeenCalledWith(receipt.recipient.wallet_address, 'base_sepolia');
      expect(outcome.status).toBe('skipped_not_registered');
      expect(reputationService.submitAttestation).not.toHaveBeenCalled();
    });

    it('P3b: does not re-persist an already skipped_not_registered receipt with no wallet (no write amplification)', async () => {
      // Exercises _reconcileErc8004 directly rather than reconcileOne: since
      // Phase 3, the EAS leg attempts (and persists) on every receipt
      // regardless of the ERC-8004 outcome, which is a separate concern
      // (covered in the EAS-specific tests below) and would otherwise mask
      // whether THIS leg is still write-amplifying.
      const receipt = makeReceipt({
        recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null },
        metadata: { onchain_status: 'skipped_not_registered' }
      });
      erc8004Lookup.resolveTokenId.mockResolvedValue(null);

      await service._reconcileErc8004(receipt);

      expect(dataStore.saveAttestation).not.toHaveBeenCalled();
    });

    describe('_isErcTerminal', () => {
      it('treats skipped_not_registered as terminal when there is no wallet and no token', () => {
        const receipt = makeReceipt({
          recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null },
          metadata: { onchain_status: 'skipped_not_registered' }
        });
        expect(service._isErcTerminal(receipt)).toBe(true);
      });

      it('treats skipped_not_registered as non-terminal when a wallet is present', () => {
        const receipt = makeReceipt({
          recipient: { agent_id: 'a', wallet_address: '0x' + 'd'.repeat(40), erc8004_token_id: null },
          metadata: { onchain_status: 'skipped_not_registered' }
        });
        expect(service._isErcTerminal(receipt)).toBe(false);
      });

      it('treats skipped_not_registered as non-terminal when a token id is already known', () => {
        const receipt = makeReceipt({
          recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null },
          metadata: { onchain_status: 'skipped_not_registered', resolved_erc8004_token_id: '7' }
        });
        expect(service._isErcTerminal(receipt)).toBe(false);
      });
    });
  });

  describe('_reconcileEas', () => {
    it('lazily creates a default eas block and submits when a receipt has none', async () => {
      const receipt = makeReceipt(); // no eas field
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: '0x' + 'a'.repeat(40), anchorMode: 'recipient'
      });

      const outcome = await service._reconcileEas(receipt);

      expect(outcome.status).toBe('submitted');
      expect(receipt.eas.status).toBe('submitted');
      expect(receipt.eas.attestation_uid).toBe('0xuid');
    });

    it('does not attempt when eas.status is already submitted', async () => {
      const receipt = makeEasReceipt({ status: 'submitted' });
      const outcome = await service._reconcileEas(receipt);
      expect(outcome).toBeNull();
      expect(easService.submitAttestation).not.toHaveBeenCalled();
    });

    it('does not attempt when eas.status is failed_permanent', async () => {
      const receipt = makeEasReceipt({ status: 'failed_permanent' });
      const outcome = await service._reconcileEas(receipt);
      expect(outcome).toBeNull();
      expect(easService.submitAttestation).not.toHaveBeenCalled();
    });

    // Regression lock: skipped_no_wallet used to be in EAS_TERMINAL_STATUSES.
    // It no longer is (eas-attestation.js never produces it any more — a
    // missing wallet anchors at the zero address instead of skipping) — any
    // receipt still carrying it from before this change must be re-targeted.
    it('DOES retry a receipt still carrying the legacy skipped_no_wallet status', async () => {
      const receipt = makeEasReceipt({ status: 'skipped_no_wallet' });
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: ethersZeroAddress, anchorMode: 'unattributed'
      });

      const outcome = await service._reconcileEas(receipt);

      expect(easService.submitAttestation).toHaveBeenCalled();
      expect(outcome.status).toBe('submitted');
    });

    it('records the zero-address anchor mode for a wallet-less recipient', async () => {
      const receipt = makeEasReceipt({}, { recipient: { agent_id: 'a', wallet_address: '', erc8004_token_id: null } });
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: ethersZeroAddress, anchorMode: 'unattributed'
      });

      await service._reconcileEas(receipt);

      expect(receipt.eas.anchor_mode).toBe('unattributed');
      expect(receipt.eas.recipient).toBe(ethersZeroAddress);
      expect(receipt.eas.status).toBe('submitted');
    });

    it('escalates to failed_permanent once the EAS retry cap is reached, without attempting', async () => {
      const receipt = makeEasReceipt({ status: 'failed', retry_count: 10 });
      const outcome = await service._reconcileEas(receipt);
      expect(outcome.status).toBe('failed_permanent');
      expect(receipt.eas.status).toBe('failed_permanent');
      expect(easService.submitAttestation).not.toHaveBeenCalled();
    });

    it('increments retry_count on a generic EAS failure without hitting the cap', async () => {
      const receipt = makeEasReceipt({ status: 'failed', retry_count: 3 });
      easService.submitAttestation.mockRejectedValue(new Error('rpc timeout'));

      const outcome = await service._reconcileEas(receipt);

      expect(outcome.status).toBe('failed');
      expect(receipt.eas.retry_count).toBe(4);
      expect(dataStore.saveEasSubmission).toHaveBeenCalledWith(
        'rcpt_kx_test',
        expect.objectContaining({ status: 'failed' })
      );
    });

    it('defers (without burning retry budget) on a gas-ceiling error', async () => {
      const receipt = makeEasReceipt({ status: 'failed', retry_count: 3 });
      const err = new Error('GAS_CEILING: gas price too high');
      err.code = 'GAS_CEILING';
      easService.submitAttestation.mockRejectedValue(err);

      const outcome = await service._reconcileEas(receipt);

      expect(outcome.status).toBe('deferred');
      expect(receipt.eas.retry_count).toBe(3);
    });

    it('treats a recent "submitting" mark as in-flight elsewhere and does not re-attempt', async () => {
      const receipt = makeEasReceipt({ status: 'submitting', submitting_at: new Date().toISOString() });
      const outcome = await service._reconcileEas(receipt);
      expect(outcome.status).toBe('submitting');
      expect(easService.submitAttestation).not.toHaveBeenCalled();
    });

    it('re-attempts a stale "submitting" mark past STALE_SUBMITTING_MS', async () => {
      const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const receipt = makeEasReceipt({ status: 'submitting', submitting_at: staleTime });
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: '0x' + 'a'.repeat(40), anchorMode: 'recipient'
      });

      const outcome = await service._reconcileEas(receipt);

      expect(easService.submitAttestation).toHaveBeenCalled();
      expect(outcome.status).toBe('submitted');
    });

    it('keeps eas.status "submitted" when the post-success persistence save fails', async () => {
      const receipt = makeEasReceipt();
      easService.submitAttestation.mockResolvedValue({
        uid: '0xuid', txHash: '0xtx', explorerUrl: 'https://explorer/0xuid',
        recipient: '0x' + 'a'.repeat(40), anchorMode: 'recipient'
      });
      // First saveAttestation call (marking 'submitting') succeeds; the
      // post-success save fails.
      dataStore.saveAttestation
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('disk full'));

      const outcome = await service._reconcileEas(receipt);

      expect(outcome.status).toBe('submitted');
      expect(receipt.eas.status).toBe('submitted');
    });
  });

  describe('reconcileAll', () => {
    it('only reconciles attestations not already terminal on BOTH the ERC-8004 and EAS legs', async () => {
      // All given an already-terminal, already-submitted eas block so only
      // the ERC-8004 dimension is under test here — the P2c "no eas block
      // yet" case (every receipt is a target regardless of ERC-8004 status)
      // has its own test below.
      const submitted = makeEasReceipt({ status: 'submitted' }, { receipt_id: 'a', metadata: { onchain_status: 'submitted' } });
      const skippedSelf = makeEasReceipt({ status: 'submitted' }, { receipt_id: 'b', metadata: { onchain_status: 'skipped_self_verification' } });
      const pending = makeEasReceipt({ status: 'submitted' }, { receipt_id: 'c', metadata: { onchain_status: 'pending' } });
      // P3: terminal only because there is no wallet and no token — excluded.
      const skippedNoWalletEver = makeEasReceipt({ status: 'submitted' }, {
        receipt_id: 'd',
        recipient: { agent_id: 'd', wallet_address: '', erc8004_token_id: null },
        metadata: { onchain_status: 'skipped_not_registered' }
      });
      // P3: same status, but a wallet exists — still a target.
      const skippedWithWallet = makeEasReceipt({ status: 'submitted' }, {
        receipt_id: 'e',
        recipient: { agent_id: 'e', wallet_address: '0x' + 'f'.repeat(40), erc8004_token_id: null },
        metadata: { onchain_status: 'skipped_not_registered' }
      });

      dataStore.listAttestations.mockResolvedValue([submitted, skippedSelf, pending, skippedNoWalletEver, skippedWithWallet]);
      jest.spyOn(service, 'reconcileOne').mockResolvedValue({ receipt_id: 'x', status: 'submitted' });

      const result = await service.reconcileAll();

      expect(service.reconcileOne).toHaveBeenCalledTimes(2);
      expect(service.reconcileOne).toHaveBeenCalledWith(pending);
      expect(service.reconcileOne).toHaveBeenCalledWith(skippedWithWallet);
      expect(service.reconcileOne).not.toHaveBeenCalledWith(skippedNoWalletEver);
      expect(result.succeeded).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('P2c: still targets a receipt whose ERC-8004 leg is terminal but which has no eas block yet', async () => {
      // Pre-backfill-eas-block.js receipts (or any receipt issued before this
      // repo added the eas block) have no `eas` field at all. Every receipt
      // anchors on EAS now, so a missing block must not be read as "nothing
      // to do" just because the ERC-8004 leg already finished.
      const ercTerminalNoEas = makeReceipt({
        receipt_id: 'f',
        metadata: { onchain_status: 'submitted' }
        // no eas field
      });
      dataStore.listAttestations.mockResolvedValue([ercTerminalNoEas]);
      jest.spyOn(service, 'reconcileOne').mockResolvedValue({ receipt_id: 'f', status: 'submitted' });

      await service.reconcileAll();

      expect(service.reconcileOne).toHaveBeenCalledWith(ercTerminalNoEas);
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
