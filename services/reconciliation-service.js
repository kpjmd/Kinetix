// /services/reconciliation-service.js
// Periodic + on-demand retry of stalled ERC-8004 Reputation Registry
// submissions for already-issued attestations. A different lifecycle stage
// than monitoring-service.js (which watches active commitments for new
// evidence, pre-scoring) — this acts on receipts that already exist.
//
// Uses setInterval rather than node-schedule's cron string: cron minute
// fields only range 0-59, and a `*/N * * * *` pattern silently misbehaves
// for N >= 60 (this service's default interval is 180 minutes / 3 hours).

const { ethers } = require('ethers');
const dataStore = require('./data-store');
const reputationService = require('../utils/erc8004-reputation');
const easService = require('../utils/eas-attestation');
const ipfsManager = require('../utils/ipfs-manager');
const erc8004Lookup = require('../utils/erc8004-lookup');
const { effectiveTokenId, hasEvmWallet } = require('../utils/receipt-identity');

// Once in one of these ERC-8004 states, an attestation is never retried again.
const TERMINAL_STATUSES = ['submitted', 'skipped_self_verification', 'failed_permanent'];
// EAS submission states that are terminal (no further retry). Deliberately
// does NOT include 'skipped_no_wallet' — eas-attestation.js no longer
// produces it (a missing wallet anchors at the zero address instead of
// skipping), so any receipt still carrying that status from before this
// change is re-targeted and gets its zero-address anchor on the next run.
const EAS_TERMINAL_STATUSES = ['submitted', 'failed_permanent'];
const MAX_RETRY_COUNT = 10;
// A receipt marked 'submitting' with no tx hash yet is assumed to be actively
// mid-submit by another path (issuance, or a concurrent run). Only after this
// long do we treat it as crashed-before-broadcast and safe to re-submit.
const STALE_SUBMITTING_MS = 5 * 60 * 1000;
// Guardrails on the raw signing wallet (which bypasses SafetyController):
// bound how many on-chain sends one run may make, and refuse to run when the
// wallet can't cover gas.
const MAX_SUBMISSIONS_PER_RUN = Number(process.env.RECONCILE_MAX_SUBMISSIONS_PER_RUN || 25);
const MIN_SUBMISSION_ETH = process.env.MIN_SUBMISSION_ETH || '0.0005';
// A tx was actually broadcast (or attempted) for these outcome statuses.
const ATTEMPT_STATUSES = ['submitted', 'failed', 'failed_permanent', 'submitting'];

class ReconciliationService {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [ReconciliationService] ${message}`;
    if (data) {
      let dataStr;
      try { dataStr = JSON.stringify(data); } catch (e) { dataStr = String(data); }
      line += ` ${dataStr.length > 300 ? `${dataStr.slice(0, 300)}…` : dataStr}`;
    }
    console.log(line);
  }

  initialize() {
    this._log('Initialized');
  }

  /**
   * Start periodic reconciliation
   */
  start(intervalMinutes = 180) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcileAll().catch(error => {
        this._log('Scheduled reconciliation run failed', { error: error.message });
      });
    }, intervalMinutes * 60 * 1000);
    this._log(`Reconciliation started: checking every ${intervalMinutes} minutes`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._log('Reconciliation stopped');
    }
  }

  /**
   * Scan all attestations not yet in a terminal on-chain state and retry each.
   * @returns {Promise<{succeeded: number, skipped: number, failed: number, results: Array}>}
   */
  async reconcileAll() {
    if (this.running) {
      this._log('Reconciliation already in progress, skipping this run');
      return { succeeded: 0, skipped: 0, failed: 0, results: [] };
    }

    this.running = true;
    try {
      const all = await dataStore.listAttestations();
      // A receipt is a target if EITHER its ERC-8004 or its EAS submission is
      // still non-terminal. `!r.eas` (pre-backfill-eas-block.js receipts, or
      // any receipt issued before this repo added the eas block) counts as
      // non-terminal too — _reconcileEas lazily creates a default 'pending'
      // block for them, so every receipt eventually gets an EAS anchor.
      const targets = all.filter(r =>
        !this._isErcTerminal(r) ||
        !r.eas || !EAS_TERMINAL_STATUSES.includes(r.eas.status)
      );

      this._log(`Reconciling ${targets.length} attestation(s)`);

      // Pre-flight: refuse to run when the signing wallet can't cover gas.
      // Best-effort — never blocks the run if the check itself cannot complete.
      if (targets.length > 0 && !(await this._hasSufficientBalance())) {
        this._log('Signing wallet balance below minimum — deferring reconciliation run', {
          minEth: MIN_SUBMISSION_ETH
        });
        return { succeeded: 0, skipped: targets.length, failed: 0, results: [], deferred: 'low_balance' };
      }

      let succeeded = 0;
      let skipped = 0;
      let failed = 0;
      let attempts = 0;
      const results = [];

      for (const receipt of targets) {
        // Per-run cap: bound gas spend by limiting actual on-chain sends per run.
        if (attempts >= MAX_SUBMISSIONS_PER_RUN) {
          this._log(`Per-run submission cap (${MAX_SUBMISSIONS_PER_RUN}) reached — deferring remaining receipt(s) to next run`);
          break;
        }
        const outcome = await this.reconcileOne(receipt);
        results.push(outcome);
        if (outcome.status === 'submitted') succeeded++;
        else if (outcome.status.startsWith('skipped') || outcome.status === 'submitting' || outcome.status === 'deferred') skipped++;
        else failed++;
        // Each leg that actually attempted an on-chain send counts separately
        // toward the run cap — a receipt can send both an ERC-8004 tx and an
        // EAS tx in the same pass. Counting once per receipt (as before)
        // let a run of MAX_SUBMISSIONS_PER_RUN receipts broadcast up to 2x
        // that many transactions, which stopped being a rounding error once
        // EAS started anchoring nearly every receipt instead of skipping most.
        if (ATTEMPT_STATUSES.includes(outcome.status)) attempts++;
        if (ATTEMPT_STATUSES.includes(outcome.eas_status)) attempts++;
      }

      this._log('Reconciliation complete', { succeeded, skipped, failed, attempts });
      return { succeeded, skipped, failed, results };
    } finally {
      this.running = false;
    }
  }

  /**
   * True if the signing wallet can cover gas for submissions. Best-effort: if
   * the balance cannot be determined, returns true so the run is not blocked.
   */
  async _hasSufficientBalance() {
    try {
      await reputationService.initialize();
      if (!reputationService.provider || !reputationService.walletAddress) {
        return true; // cannot check (e.g. under test) — do not block
      }
      const balance = await reputationService.provider.getBalance(reputationService.walletAddress);
      return balance >= ethers.parseEther(MIN_SUBMISSION_ETH);
    } catch (error) {
      this._log('Pre-flight balance check failed, proceeding cautiously', { error: error.message });
      return true;
    }
  }

  /**
   * True if a receipt's ERC-8004 leg is terminal — either one of the flat
   * TERMINAL_STATUSES, or 'skipped_not_registered' when nothing could ever
   * change the outcome: no EVM wallet to resolve a token id from, and no
   * token id already known (from issuance or a prior resolve). This is
   * honest specifically because erc8004Lookup.resolveTokenId('') returns
   * null immediately — with no wallet, there is genuinely nothing left to
   * retry. A wallet-bearing recipient who simply hasn't registered yet stays
   * non-terminal, since they may register later (REPUTATION_RECEIPT.MD).
   */
  _isErcTerminal(receipt) {
    const status = receipt.metadata?.onchain_status;
    if (TERMINAL_STATUSES.includes(status)) return true;
    if (status === 'skipped_not_registered') {
      return !hasEvmWallet(receipt) && !effectiveTokenId(receipt);
    }
    return false;
  }

  /**
   * Reconcile both on-chain submissions for a receipt: the ERC-8004 Reputation
   * Registry entry and the EAS attestation. Each is independent and best-effort;
   * the returned status reflects the ERC-8004 outcome (for backward
   * compatibility), with the EAS outcome attached as eas_status/eas_detail.
   * Never throws.
   */
  async reconcileOne(receipt) {
    const ercOutcome = await this._reconcileErc8004(receipt);
    const easOutcome = await this._reconcileEas(receipt);
    if (easOutcome) {
      return { ...ercOutcome, eas_status: easOutcome.status, eas_detail: easOutcome.detail };
    }
    return ercOutcome;
  }

  /**
   * Retry the EAS attestation for a receipt whose EAS submission is not yet
   * terminal. Never throws. Returns null when there is nothing to do.
   *
   * Note: the eas-sdk sends the tx inside wait(), so unlike the ERC-8004 path
   * we cannot persist a tx hash before confirmation. We mark 'submitting' and
   * only re-attempt after a staleness window, accepting the narrow residual
   * duplicate risk of a crash during confirmation.
   */
  async _reconcileEas(receipt) {
    // Pre-backfill-eas-block.js receipts have no eas block at all. Every
    // receipt anchors on EAS now (zero-address fallback when there's no
    // wallet), so treat a missing block the same as a fresh 'pending' one
    // rather than skipping it — lazily create it instead of requiring a
    // separate backfill run.
    if (!receipt.eas) {
      receipt.eas = {
        schema_uid: null,
        attestation_uid: null,
        tx_hash: null,
        network: null,
        explorer_url: null,
        submitted_at: null,
        status: 'pending'
      };
    }
    const eas = receipt.eas;
    if (EAS_TERMINAL_STATUSES.includes(eas.status)) return null;

    const retry = eas.retry_count || 0;
    if (retry >= MAX_RETRY_COUNT) {
      if (eas.status !== 'failed_permanent') {
        eas.status = 'failed_permanent';
        try { await dataStore.saveAttestation(receipt); } catch (e) {
          this._log(`Failed to persist EAS failed_permanent for ${receipt.receipt_id}: ${e.message}`);
        }
      }
      return { status: 'failed_permanent', detail: `EAS retry cap (${MAX_RETRY_COUNT}) reached` };
    }

    // In-flight guard: if recently marked submitting, assume another path is
    // mid-submit and skip; only re-attempt once stale.
    if (eas.status === 'submitting') {
      const startedAt = eas.submitting_at ? new Date(eas.submitting_at).getTime() : 0;
      if (startedAt && (Date.now() - startedAt) < STALE_SUBMITTING_MS) {
        return { status: 'submitting', detail: 'EAS submission in progress elsewhere' };
      }
    }

    try {
      await easService.initialize();

      eas.status = 'submitting';
      eas.submitting_at = new Date().toISOString();
      await dataStore.saveAttestation(receipt);

      const result = await easService.submitAttestation(receipt);

      eas.schema_uid = easService.network.schemaUID;
      eas.attestation_uid = result.uid;
      eas.tx_hash = result.txHash;
      eas.network = easService.networkName;
      eas.explorer_url = result.explorerUrl;
      eas.submitted_at = new Date().toISOString();
      eas.status = 'submitted';
      eas.recipient = result.recipient;
      eas.anchor_mode = result.anchorMode;
      try {
        await dataStore.saveAttestation(receipt);
        await dataStore.saveEasSubmission(receipt.receipt_id, {
          status: 'success',
          network: easService.networkName,
          transaction_hash: result.txHash,
          attestation_uid: result.uid,
          schema_uid: easService.network.schemaUID,
          anchor_mode: result.anchorMode,
          recovered: true,
          submitted_at: new Date().toISOString()
        });
      } catch (persistError) {
        this._log(`EAS attestation for ${receipt.receipt_id} landed (uid ${result.uid}) but persisting failed — leaving eas.status 'submitted'`, {
          error: persistError.message
        });
      }
      this._log(`Reconciled EAS attestation for ${receipt.receipt_id}`, { uid: result.uid });
      return { status: 'submitted', detail: result.uid };
    } catch (error) {
      // NO_WALLET is no longer thrown by eas-attestation.js — a missing
      // wallet now anchors at the zero address rather than skipping. A gas
      // spike defers without burning retry budget, mirroring _recordFailure's
      // treatment of the ERC-8004 leg.
      const status = (error.code === 'GAS_CEILING' || error.message?.startsWith('GAS_CEILING:')) ? 'deferred' : 'failed';
      eas.status = status;
      if (status === 'failed') {
        eas.retry_count = retry + 1;
        if (eas.retry_count >= MAX_RETRY_COUNT) eas.status = 'failed_permanent';
      }
      try {
        await dataStore.saveAttestation(receipt);
        await dataStore.saveEasSubmission(receipt.receipt_id, {
          status: 'failed',
          error: error.message,
          attempted_at: new Date().toISOString()
        });
      } catch (trackingError) {
        this._log(`Failed to persist EAS reconciliation outcome for ${receipt.receipt_id}: ${trackingError.message}`);
      }
      return { status: eas.status, detail: error.message };
    }
  }

  /**
   * Resolve a missing token ID if possible, then retry ERC-8004 submission
   * for a single receipt. Never throws.
   * @param {Object} receipt
   * @returns {Promise<{receipt_id: string, status: string, detail?: string}>}
   */
  async _reconcileErc8004(receipt) {
    // Idempotency guard: never act on a receipt already in a terminal on-chain
    // state. reconcileAll pre-filters these, but /retry_onchain <id> calls this
    // directly — without this check it would re-submit an already-'submitted'
    // receipt, creating a duplicate on-chain feedback entry.
    if (this._isErcTerminal(receipt)) {
      return {
        receipt_id: receipt.receipt_id,
        status: receipt.metadata.onchain_status,
        detail: 'already in terminal state; nothing to do'
      };
    }

    const retryCount = receipt.metadata?.onchain_retry_count || 0;
    if (retryCount >= MAX_RETRY_COUNT) {
      // Persist the terminal state so this receipt stops being re-listed and
      // re-logged on every run (M1).
      receipt.metadata.onchain_status = 'failed_permanent';
      try {
        await dataStore.saveAttestation(receipt);
      } catch (persistError) {
        this._log(`Failed to persist failed_permanent for ${receipt.receipt_id}: ${persistError.message}`);
      }
      return {
        receipt_id: receipt.receipt_id,
        status: 'failed_permanent',
        detail: `retry cap (${MAX_RETRY_COUNT}) already reached`
      };
    }

    // Recover an interrupted in-flight submission before ever broadcasting a
    // new one. A prior attempt may have broadcast a tx that we never recorded
    // the confirmation for.
    if (receipt.metadata?.onchain_status === 'submitting') {
      if (receipt.metadata?.onchain_tx_hash) {
        const recovered = await this._recoverInFlight(receipt);
        if (recovered) return recovered; // mined or still-pending → do not re-submit
        // reverted/dropped → fall through and submit fresh
      } else {
        // Marked 'submitting' but no tx broadcast yet. If recent, another path
        // (issuance or a concurrent run) is likely mid-submit — skip to avoid a
        // duplicate. If stale, assume a crash before broadcast and re-submit.
        const startedAt = receipt.metadata?.onchain_submitting_at
          ? new Date(receipt.metadata.onchain_submitting_at).getTime()
          : 0;
        if (startedAt && (Date.now() - startedAt) < STALE_SUBMITTING_MS) {
          this._log(`Receipt ${receipt.receipt_id} is mid-submit elsewhere (no tx yet, recent) — skipping this pass`);
          return { receipt_id: receipt.receipt_id, status: 'submitting', detail: 'submission in progress elsewhere' };
        }
        this._log(`Receipt ${receipt.receipt_id} stuck 'submitting' with no tx hash — assuming crash before broadcast, re-submitting`);
      }
    }

    try {
      await reputationService.initialize();
      const network = reputationService.networkName;

      if (!effectiveTokenId(receipt)) {
        const tokenId = await erc8004Lookup.resolveTokenId(receipt.recipient?.wallet_address, network);
        if (tokenId) {
          // Written to metadata, NOT recipient — recipient.* is inside the
          // signed canonical payload and is frozen post-issuance (see the
          // comment on MUTABLE_PATHS in receipt-canonical.js). Writing here
          // used to mutate recipient.erc8004_token_id directly, silently
          // invalidating the signature and desyncing the already-pinned
          // IPFS/on-chain hashes from the stored receipt.
          receipt.metadata.resolved_erc8004_token_id = tokenId;
          receipt.metadata.resolved_erc8004_token_id_at = new Date().toISOString();
          await dataStore.saveAttestation(receipt);
          this._log(`Resolved ERC-8004 token ID ${tokenId} for ${receipt.receipt_id}`);
        }
      }

      // Still nothing to attach reputation to. Return immediately — before the
      // IPFS upload and before marking 'submitting' — instead of running the
      // full submit path only to have _mapReceiptToFeedback reject it. Before
      // this restructuring, an unregistered-but-retryable receipt (has a
      // wallet, no token id yet) re-ran the whole block every 3h — IPFS check,
      // onchain_status='submitting'+save, a NOT_REGISTERED throw, a fresh
      // failed reputation-submission record — purely to rediscover the same
      // fact it already knew coming in. Only persist when the status actually
      // changes, so an already-'skipped_not_registered' receipt stops being
      // rewritten on every pass too.
      if (!effectiveTokenId(receipt)) {
        const statusChanged = receipt.metadata.onchain_status !== 'skipped_not_registered';
        receipt.metadata.onchain_status = 'skipped_not_registered';
        if (statusChanged) {
          try {
            await dataStore.saveAttestation(receipt);
          } catch (persistError) {
            this._log(`Failed to persist skipped_not_registered for ${receipt.receipt_id}: ${persistError.message}`);
          }
        }
        return {
          receipt_id: receipt.receipt_id,
          status: 'skipped_not_registered',
          detail: hasEvmWallet(receipt)
            ? 'wallet present but not yet registered on ERC-8004; will retry'
            : 'no EVM wallet and no ERC-8004 token id; nothing to resolve'
        };
      }

      let ipfsHash = receipt.reputation_context?.ipfs_uri?.replace('ipfs://', '');
      if (!ipfsHash) {
        const uploadResult = await ipfsManager.uploadJSON(receipt, {
          name: `attestation_${receipt.receipt_id}`
        });
        ipfsHash = uploadResult.ipfsHash;
        receipt.reputation_context = receipt.reputation_context || {};
        receipt.reputation_context.ipfs_uri = `ipfs://${ipfsHash}`;
      }

      // Mark in-flight and persist BEFORE broadcasting, and record the tx hash
      // the moment it is known (via onBroadcast), so an interruption between
      // broadcast and confirmation is recoverable rather than re-submitted.
      receipt.metadata.onchain_status = 'submitting';
      receipt.metadata.onchain_submitting_at = new Date().toISOString();
      await dataStore.saveAttestation(receipt);

      const result = await reputationService.submitAttestation(receipt, ipfsHash, async (txHash) => {
        receipt.metadata.onchain_tx_hash = txHash;
        await dataStore.saveAttestation(receipt);
      });

      return await this._persistSuccess(receipt, result, ipfsHash);
    } catch (error) {
      return await this._recordFailure(receipt, error, retryCount);
    }
  }

  /**
   * Persist a confirmed successful submission. A persistence failure here must
   * NEVER downgrade the on-chain status to 'failed' — the tx already landed, so
   * we log and keep 'submitted' to avoid a duplicate re-submission next run.
   */
  async _persistSuccess(receipt, result, ipfsHash) {
    receipt.metadata.onchain_status = 'submitted';
    receipt.metadata.onchain_tx_hash = result.txHash;
    receipt.reputation_context = receipt.reputation_context || {};
    receipt.reputation_context.submission_index = result.feedbackIndex;
    receipt.reputation_context.submitted_at = new Date().toISOString();

    try {
      await dataStore.saveAttestation(receipt);
      await dataStore.saveReputationSubmission(receipt.receipt_id, {
        status: 'success',
        network: reputationService.networkName,
        transaction_hash: result.txHash,
        block_number: result.blockNumber,
        feedback_index: result.feedbackIndex,
        ipfs_hash: ipfsHash,
        ipfs_uri: `ipfs://${ipfsHash}`,
        submitted_at: new Date().toISOString()
      });
    } catch (persistError) {
      this._log(`Submission for ${receipt.receipt_id} succeeded on-chain (tx ${result.txHash}) but persisting the record failed — leaving status 'submitted' to avoid a duplicate`, {
        error: persistError.message
      });
    }

    return { receipt_id: receipt.receipt_id, status: 'submitted', detail: result.txHash };
  }

  /**
   * Recover the true outcome of an interrupted in-flight submission by its tx
   * hash, without broadcasting a new transaction.
   * @returns {Promise<Object|null>} an outcome to return, or null to re-submit
   */
  async _recoverInFlight(receipt) {
    const txHash = receipt.metadata.onchain_tx_hash;
    try {
      await reputationService.initialize();
      const check = await reputationService.checkSubmissionByHash(txHash);

      if (check.state === 'mined') {
        receipt.metadata.onchain_status = 'submitted';
        receipt.reputation_context = receipt.reputation_context || {};
        if (check.feedbackIndex != null) {
          receipt.reputation_context.submission_index = check.feedbackIndex;
        }
        receipt.reputation_context.submitted_at = receipt.reputation_context.submitted_at || new Date().toISOString();
        try {
          await dataStore.saveAttestation(receipt);
          await dataStore.saveReputationSubmission(receipt.receipt_id, {
            status: 'success',
            network: reputationService.networkName,
            transaction_hash: txHash,
            block_number: check.blockNumber,
            feedback_index: check.feedbackIndex,
            recovered: true,
            submitted_at: new Date().toISOString()
          });
        } catch (persistError) {
          this._log(`Recovered mined submission for ${receipt.receipt_id} but persisting failed`, { error: persistError.message });
        }
        this._log(`Recovered in-flight submission for ${receipt.receipt_id} — tx ${txHash} mined, marked submitted`);
        return { receipt_id: receipt.receipt_id, status: 'submitted', detail: txHash };
      }

      if (check.state === 'pending') {
        this._log(`In-flight submission for ${receipt.receipt_id} (tx ${txHash}) still pending — skipping this pass`);
        return { receipt_id: receipt.receipt_id, status: 'submitting', detail: 'still awaiting confirmation' };
      }

      // reverted or dropped → clear the stale hash and allow a fresh submit.
      this._log(`In-flight submission for ${receipt.receipt_id} (tx ${txHash}) ${check.state} — will re-submit`);
      delete receipt.metadata.onchain_tx_hash;
      receipt.metadata.onchain_status = 'pending';
      return null;
    } catch (error) {
      // Cannot determine on-chain state → do NOT re-submit (duplicate risk).
      this._log(`Could not determine in-flight state for ${receipt.receipt_id}, skipping this pass`, { error: error.message });
      return { receipt_id: receipt.receipt_id, status: 'submitting', detail: `recovery check failed: ${error.message}` };
    }
  }

  /**
   * Classify and persist a failed submission attempt.
   */
  async _recordFailure(receipt, error, retryCount) {
    // If a tx was already broadcast but confirmation failed (RPC timeout etc.),
    // do NOT mark failed — the tx may still land. Leave it in-flight so the next
    // pass recovers its true outcome by hash instead of re-submitting.
    if (receipt.metadata?.onchain_tx_hash && receipt.metadata?.onchain_status === 'submitting') {
      this._log(`Submission for ${receipt.receipt_id} broadcast (tx ${receipt.metadata.onchain_tx_hash}) but confirmation failed; leaving in-flight for recovery`, {
        error: error.message
      });
      return { receipt_id: receipt.receipt_id, status: 'submitting', detail: `awaiting confirmation: ${error.message}` };
    }

    // Prefer typed error codes; fall back to message matching for robustness.
    let status = 'failed';
    if (error.code === 'SELF_VERIFICATION' || error.message?.startsWith('SELF_VERIFICATION:')) {
      status = 'skipped_self_verification';
    } else if (error.code === 'NOT_REGISTERED' || error.message?.includes('erc8004_token_id')) {
      status = 'skipped_not_registered';
    } else if (error.code === 'GAS_CEILING' || error.message?.startsWith('GAS_CEILING:')) {
      // Transient gas spike — defer, do not fail, do not burn retry budget.
      status = 'deferred';
    } else if (error.code === 'ISSUER_NOT_REGISTERED') {
      // Kinetix's own identity record was unreadable, so nothing was submitted.
      // Operator-fixable and retryable once it is; failing it here would make a
      // config mistake permanently terminal for every receipt issued during it.
      status = 'deferred';
    }

    // B8: only a genuine submission attempt (an actual on-chain failure) burns
    // the retry budget. "recipient not registered yet", self-verification, and
    // gas-ceiling deferrals must not — otherwise a recipient who registers late
    // (or a temporary fee spike) becomes permanently terminal.
    const countsAsAttempt = status === 'failed';
    const nextRetryCount = countsAsAttempt ? retryCount + 1 : retryCount;
    if (countsAsAttempt && nextRetryCount >= MAX_RETRY_COUNT) {
      status = 'failed_permanent';
    }

    receipt.metadata.onchain_status = status;
    receipt.metadata.onchain_retry_count = nextRetryCount;

    try {
      await dataStore.saveAttestation(receipt);
      await dataStore.saveReputationSubmission(receipt.receipt_id, {
        status: 'failed',
        error: error.message,
        attempted_at: new Date().toISOString()
      });
    } catch (trackingError) {
      this._log(`Failed to persist reconciliation outcome for ${receipt.receipt_id}: ${trackingError.message}`);
    }

    return { receipt_id: receipt.receipt_id, status, detail: error.message };
  }
}

module.exports = new ReconciliationService();
module.exports.ReconciliationService = ReconciliationService;
