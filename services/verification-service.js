// /services/verification-service.js
// Core verification orchestrator with scoring algorithms

const dataStore = require('./data-store');
const verificationRules = require('../config/verification-rules.json');
const crypto = require('crypto');
const ipfsManager = require('../utils/ipfs-manager');
const reputationService = require('../utils/erc8004-reputation');
const easService = require('../utils/eas-attestation');
const moltbookAnnounce = require('../utils/moltbook-announce');
const { ValidationError } = require('../utils/validation-error');

// Actions expected per day for each supported frequency.
const FREQUENCY_RATE_PER_DAY = { hourly: 24, daily: 1, weekly: 1 / 7 };

/**
 * How many actions a consistency commitment is expected to produce.
 *
 * `minimum_actions` is the denominator of the completion rate, so it decides what
 * a paid verification actually attests to. It is not required by any route's
 * inputSchema, so it has to be derivable: "daily for 7 days" means 7, not 1.
 *
 * Always returns a positive integer, so the denominator can never be 0
 * (-> Infinity -> a free `verified`) or undefined (-> NaN -> `failed`).
 */
function deriveMinimumActions(criteria = {}) {
  const days = Number(criteria.duration_days);
  const rate = FREQUENCY_RATE_PER_DAY[criteria.frequency] ?? FREQUENCY_RATE_PER_DAY.daily;
  if (!Number.isFinite(days) || days <= 0) return 1;
  return Math.max(1, Math.round(days * rate));
}

/**
 * The value scoring must use: the caller's, when it is a usable positive
 * integer, otherwise the derived one. Legacy commitments on disk predate the
 * default and carry no `minimum_actions` at all.
 */
function resolveMinimumActions(criteria = {}) {
  const stated = Number(criteria.minimum_actions);
  if (Number.isInteger(stated) && stated > 0) return stated;
  return deriveMinimumActions(criteria);
}

class VerificationService {
  constructor() {
    this.rules = verificationRules;
    this.monitoringService = null;
    this.attestationService = null;
    // In-flight scoring runs, keyed by verification id. See scoreVerification.
    this._scoringInFlight = new Map();
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [VerificationService] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize with dependencies
   */
  initialize(monitoringService, attestationService) {
    this.monitoringService = monitoringService;
    this.attestationService = attestationService;
    this._log('Initialized');
  }

  /**
   * Create a new verification from a commitment
   */
  async createVerification(commitment) {
    this._validateCommitment(commitment);

    // Pin the denominator at creation so the receipt states the target the buyer
    // was sold, rather than one re-derived at scoring time from mutated criteria.
    const criteria = { ...commitment.criteria };
    if (commitment.verification_type === 'consistency' && criteria.minimum_actions === undefined) {
      criteria.minimum_actions = deriveMinimumActions(criteria);
    }

    const difficulty = this.calculateDifficulty(commitment);
    const commitmentId = dataStore.generateId('cmt_kx_');
    const now = new Date().toISOString();

    // Calculate dates
    const startDate = commitment.start_date || now;
    let endDate;
    if (commitment.criteria.duration_days) {
      const start = new Date(startDate);
      endDate = new Date(start.getTime() + commitment.criteria.duration_days * 24 * 60 * 60 * 1000).toISOString();
    } else if (commitment.criteria.milestones) {
      // For time-bound, use last milestone deadline
      const deadlines = commitment.criteria.milestones.map(m => new Date(m.deadline));
      endDate = new Date(Math.max(...deadlines)).toISOString();
    } else {
      // Default: 7 days
      endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    const record = {
      commitment_id: commitmentId,
      agent_id: commitment.agent_id,
      pubkey: commitment.pubkey || '',
      // Optional and distinct from pubkey: the EVM address that receives the EAS
      // attestation. A Nostr agent has no such address, and omitting it makes
      // EAS skip cleanly rather than fail on an unparseable recipient.
      wallet_address: commitment.wallet_address || '',
      platform_profiles: commitment.platform_profiles || {},
      description: commitment.description,
      verification_type: commitment.verification_type,
      criteria,
      difficulty,
      status: 'active',
      evidence: [],
      created_at: now,
      start_date: startDate,
      end_date: endDate,
      payment: commitment.payment || null,
      scoring_result: null,
      erc8004_token_id: commitment.erc8004_token_id || null
    };

    await dataStore.saveCommitment(record);
    this._log(`Created verification ${commitmentId}`, { difficulty, verification_type: commitment.verification_type });

    return {
      verification_id: commitmentId,
      status: 'monitoring',
      expected_completion: endDate
    };
  }

  /**
   * Get status of a verification
   */
  async getStatus(verificationId) {
    let commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment) return null;

    // Check if expired and needs scoring
    if (commitment.status === 'active' && new Date() >= new Date(commitment.end_date)) {
      this._log(`Commitment ${verificationId} has expired, triggering scoring`);
      await this.scoreVerification(verificationId);
      commitment = await dataStore.loadCommitment(verificationId);
    }

    // One shape for both paths. This previously returned the whole commitment
    // when it had just triggered scoring and the trimmed object otherwise —
    // and only the former carried receipt_id, so a buyer who polled twice
    // could never learn the id of the receipt they had paid for.
    return {
      verification_id: commitment.commitment_id,
      status: commitment.status,
      verification_type: commitment.verification_type,
      evidence_count: commitment.evidence.length,
      created_at: commitment.created_at,
      end_date: commitment.end_date,
      scoring_result: commitment.scoring_result,
      receipt_id: commitment.receipt_id || null,
      collection: this._collectionSummary(commitment)
    };
  }

  /**
   * Public, sanitised view of how evidence collection is going.
   *
   * Without this, a commitment held back by the grace window reports plain
   * `active` past its own end_date with no explanation — indistinguishable
   * from a hung service to the buyer who paid for it, or to a marketplace
   * reviewer probing the free status route.
   *
   * Deliberately omits the raw `last_error`. It is our own message, but it
   * names relay hosts and failure modes, and this route is unauthenticated —
   * the same reason sendVerificationError does not echo error.message.
   */
  _collectionSummary(commitment) {
    const monitoring = commitment.monitoring;

    // Nothing collects for this commitment: the free API route, or a platform
    // with no collector. Saying "awaiting collection" would be a lie.
    if (!monitoring) {
      return { state: 'not_monitored' };
    }

    const summary = {
      state: 'collecting',
      last_success_at: monitoring.last_success_at || null,
      last_attempt_at: monitoring.last_attempt_at || null,
      consecutive_failures: monitoring.consecutive_failures || 0
    };

    if (commitment.status !== 'active') {
      summary.state = 'complete';
      return summary;
    }

    if (new Date() < new Date(commitment.end_date)) {
      return summary;
    }

    // Window closed but still active: scoring is being deferred. Say so, and
    // say when the wait ends, so the caller can tell a delay from a hang.
    const readiness = this._collectionReadiness(commitment);
    if (!readiness.ready) {
      const graceHours = this.rules.monitoring?.collection_grace_hours ?? 24;
      summary.state = 'awaiting_collection';
      summary.grace_expires_at = new Date(
        new Date(commitment.end_date).getTime() + graceHours * 60 * 60 * 1000
      ).toISOString();
    }

    return summary;
  }

  /**
   * Add evidence to a commitment
   */
  async addEvidence(verificationId, evidence) {
    const commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${verificationId}`);
    }

    // A scored commitment is closed. Its scoring_result and receipt are already
    // signed over the evidence array as it stood, so appending afterwards makes
    // the file disagree with the artifact a buyer can fetch.
    if (commitment.status !== 'active') {
      this._log(`Ignoring evidence for ${verificationId}: status is ${commitment.status}`);
      return commitment;
    }

    // Validate evidence
    const platform = evidence.platform;
    const validation = this._validateEvidence(evidence, platform);
    if (!validation.valid) {
      this._log(`Evidence validation failed for ${verificationId}`, validation.errors);
      return commitment;
    }

    // Generate evidence_id if not provided
    if (!evidence.evidence_id) {
      evidence.evidence_id = 'ev_' + crypto.randomBytes(3).toString('hex');
    }

    // Add to commitment
    commitment.evidence.push(evidence);
    await dataStore.saveCommitment(commitment);

    this._log(`Added evidence ${evidence.evidence_id} to ${verificationId}`);

    // Deliberately does NOT trigger scoring on expiry. Collectors add evidence
    // one item at a time (monitoring-service.js), so scoring here would fire on
    // the first item of a batch and sign a receipt over a partial evidence set
    // while the remaining items were still being appended. Expiry is handled by
    // monitoring-service.checkCommitment (after its whole batch lands) and by
    // getStatus, both of which see the complete array.
    return commitment;
  }

  /**
   * Score a verification, collapsing concurrent calls for the same id.
   *
   * The "already scored" guard below is a load-check-save sequence with an
   * await between the check and the save, so two callers arriving together
   * both read status 'active' and both proceed — issuing two attestations and,
   * for a recipient registered on ERC-8004, broadcasting `giveFeedback` twice
   * for a single payment. That is reachable from the public status route,
   * which triggers scoring for any expired commitment.
   *
   * This map serializes per id within the process. Scoring for a given
   * commitment only ever runs where its data lives — each deployment has its
   * own volume — so a cross-process lock is not needed.
   */
  async scoreVerification(verificationId) {
    const inFlight = this._scoringInFlight.get(verificationId);
    if (inFlight) {
      this._log(`Scoring already in flight for ${verificationId}, joining it`);
      return inFlight;
    }

    const run = this._scoreVerification(verificationId).finally(() => {
      this._scoringInFlight.delete(verificationId);
    });
    this._scoringInFlight.set(verificationId, run);
    return run;
  }

  async _scoreVerification(verificationId) {
    const commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${verificationId}`);
    }

    if (commitment.status !== 'active') {
      this._log(`Commitment ${verificationId} already scored (status: ${commitment.status})`);
      return commitment.scoring_result;
    }

    const readiness = this._collectionReadiness(commitment);
    if (!readiness.ready) {
      this._log(`Deferring scoring for ${verificationId}: ${readiness.reason}`);
      return null;
    }

    let result;
    switch (commitment.verification_type) {
      case 'consistency':
        result = this._scoreConsistency(commitment, commitment.evidence);
        break;
      case 'quality':
        result = this._scoreQuality(commitment, commitment.evidence);
        break;
      case 'time_bound':
        result = this._scoreTimeBound(commitment, commitment.evidence);
        break;
      default:
        throw new Error(`Unknown verification type: ${commitment.verification_type}`);
    }

    if (readiness.degraded) {
      // Ends up in the signed receipt. A low score reached without a confirmed
      // successful collection has to say so, or it reads as a verdict on the
      // agent when it may be a verdict on our relay connectivity.
      result.collection_degraded = true;
    }

    commitment.scoring_result = result;
    commitment.status = result.status;
    await dataStore.saveCommitment(commitment);

    this._log(`Scored verification ${verificationId}`, result);

    // Issue attestation if any score
    if (result.overall_score > 0 || result.status !== 'failed') {
      await this.issueAttestation(verificationId);
    } else {
      // Even failures get receipts
      await this.issueAttestation(verificationId);
    }

    return result;
  }

  /**
   * Issue attestation for completed verification
   */
  async issueAttestation(verificationId) {
    const commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment.scoring_result) {
      throw new Error(`Cannot issue attestation: commitment ${verificationId} not scored`);
    }

    const receipt = await this.attestationService.generateReceipt(commitment);
    await dataStore.saveAttestation(receipt);

    commitment.status = 'attested';
    commitment.receipt_id = receipt.receipt_id;
    await dataStore.saveCommitment(commitment);

    this._log(`Issued attestation ${receipt.receipt_id} for ${verificationId}`);

    // On-chain anchoring: IPFS upload feeds both the ERC-8004 submission and
    // (optionally) the EAS attestation's ipfsUri field. Neither on-chain path
    // may block or fail attestation issuance — the receipt above is already saved.
    let ipfsHash = null;
    let gatewayUrl = null;
    try {
      this._log(`Uploading attestation ${receipt.receipt_id} to IPFS...`);
      const uploadResult = await ipfsManager.uploadJSON(receipt, {
        name: `attestation-${receipt.receipt_id}`
      });
      ipfsHash = uploadResult.ipfsHash;
      gatewayUrl = uploadResult.gatewayUrl;
      receipt.reputation_context.ipfs_uri = `ipfs://${ipfsHash}`;
      await dataStore.saveAttestation(receipt);
      this._log(`Uploaded to IPFS: ${ipfsHash}`);
    } catch (error) {
      this._log(`IPFS upload failed (attestation still valid; on-chain submissions proceed without it where possible)`, {
        error: error.message
      });
    }

    // Week 2 Track B (ERC-8004) + EAS: independent, best-effort. Run SEQUENTIALLY,
    // not concurrently — both are signed by the same wallet, so parallel sends
    // race on nonce (one would fail NONCE_EXPIRED) and race on concurrent writes
    // to this same receipt file. Each method never throws.
    await this._submitToReputationRegistry(receipt, ipfsHash, gatewayUrl);
    await this._submitToEAS(receipt);
    await this._announceOnMoltbook(receipt);

    return receipt;
  }

  /**
   * Best-effort Moltbook announcement of the completed verification. Never
   * throws — receipt issuance must not depend on Moltbook being reachable.
   */
  async _announceOnMoltbook(receipt) {
    try {
      await moltbookAnnounce.announceVerification(receipt);
    } catch (error) {
      this._log(`Moltbook announcement failed (non-fatal)`, { error: error.message });
    }
  }

  /**
   * Best-effort ERC-8004 Reputation Registry submission. Never throws —
   * failures (including "recipient not registered on ERC-8004") are logged
   * and tracked so the reconciliation job can retry later.
   */
  async _submitToReputationRegistry(receipt, ipfsHash, gatewayUrl) {
    if (!ipfsHash) {
      this._log(`Skipping Reputation Registry submission for ${receipt.receipt_id} — no IPFS hash available`);
      try {
        await dataStore.saveReputationSubmission(receipt.receipt_id, {
          status: 'failed',
          error: 'IPFS upload failed; feedbackURI unavailable',
          attempted_at: new Date().toISOString()
        });
      } catch (trackingError) {
        this._log(`Failed to track submission error: ${trackingError.message}`);
      }
      return;
    }

    try {
      this._log(`Submitting attestation ${receipt.receipt_id} to Reputation Registry...`);
      await reputationService.initialize();

      // Mark in-flight and record the tx hash at broadcast, so an interruption
      // between broadcast and confirmation is recoverable by reconciliation
      // rather than re-submitted (which would double-write on-chain).
      receipt.metadata.onchain_status = 'submitting';
      receipt.metadata.onchain_submitting_at = new Date().toISOString();
      await dataStore.saveAttestation(receipt);

      const result = await reputationService.submitAttestation(receipt, ipfsHash, async (txHash) => {
        receipt.metadata.onchain_tx_hash = txHash;
        await dataStore.saveAttestation(receipt);
      });
      this._log(`Submitted to Reputation Registry`, result);

      // Success — a persistence failure here must NOT downgrade the status to
      // 'failed' (the tx already landed); log and keep 'submitted'.
      receipt.reputation_context.submission_index = result.feedbackIndex;
      receipt.reputation_context.submitted_at = new Date().toISOString();
      receipt.metadata.onchain_status = 'submitted';
      receipt.metadata.onchain_tx_hash = result.txHash;
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
          gateway_url: gatewayUrl,
          submitted_at: new Date().toISOString()
        });
      } catch (persistError) {
        this._log(`Reputation submission for ${receipt.receipt_id} landed on-chain (tx ${result.txHash}) but persisting the record failed — leaving status 'submitted'`, {
          error: persistError.message
        });
      }

      this._log(`Successfully submitted attestation ${receipt.receipt_id} to on-chain reputation`);
    } catch (error) {
      // If a tx was broadcast, leave it in-flight for reconciliation to recover
      // by hash — do NOT mark failed, or the retry would create a duplicate.
      if (receipt.metadata?.onchain_tx_hash && receipt.metadata?.onchain_status === 'submitting') {
        this._log(`Reputation submission for ${receipt.receipt_id} broadcast (tx ${receipt.metadata.onchain_tx_hash}) but confirmation failed; leaving in-flight`, {
          error: error.message
        });
        return;
      }

      // No tx broadcast — reset to a retryable state so reconciliation picks it up.
      this._log(`Reputation submission failed (attestation still valid)`, {
        error: error.message,
        stack: error.stack
      });
      receipt.metadata.onchain_status = 'pending';

      try {
        await dataStore.saveAttestation(receipt);
        await dataStore.saveReputationSubmission(receipt.receipt_id, {
          status: 'failed',
          error: error.message,
          attempted_at: new Date().toISOString()
        });
      } catch (trackingError) {
        this._log(`Failed to track submission error: ${trackingError.message}`);
      }
    }
  }

  /**
   * Best-effort EAS attestation submission — chain-anchored proof that needs
   * no recipient pre-registration on ERC-8004 (or anywhere else). Never throws.
   */
  async _submitToEAS(receipt) {
    try {
      this._log(`Submitting attestation ${receipt.receipt_id} to EAS...`);
      await easService.initialize();
      const result = await easService.submitAttestation(receipt);
      this._log(`Submitted to EAS`, result);

      receipt.eas.schema_uid = easService.network.schemaUID;
      receipt.eas.attestation_uid = result.uid;
      receipt.eas.tx_hash = result.txHash;
      receipt.eas.network = easService.networkName;
      receipt.eas.explorer_url = result.explorerUrl;
      receipt.eas.submitted_at = new Date().toISOString();
      receipt.eas.status = 'submitted';
      // Which recipient the attestation actually names on-chain: a real EVM
      // wallet ("recipient"), or the zero address when the recipient has none
      // ("unattributed" — still fully verifiable via receiptHash/score/ipfsUri).
      receipt.eas.recipient = result.recipient;
      receipt.eas.anchor_mode = result.anchorMode;

      // Success — a persistence failure here must NOT downgrade eas.status to
      // 'failed' (the attestation already landed on-chain); log and keep it.
      try {
        await dataStore.saveAttestation(receipt);
        await dataStore.saveEasSubmission(receipt.receipt_id, {
          status: 'success',
          network: easService.networkName,
          transaction_hash: result.txHash,
          attestation_uid: result.uid,
          schema_uid: easService.network.schemaUID,
          anchor_mode: result.anchorMode,
          submitted_at: new Date().toISOString()
        });
      } catch (persistError) {
        this._log(`EAS attestation for ${receipt.receipt_id} landed on-chain (uid ${result.uid}) but persisting the record failed — leaving eas.status 'submitted'`, {
          error: persistError.message
        });
      }

      this._log(`Successfully submitted attestation ${receipt.receipt_id} to EAS`);
    } catch (error) {
      // Log but don't fail - attestation is still valid without an EAS entry.
      // NO_WALLET is no longer thrown by eas-attestation.js (a missing wallet
      // now anchors at the zero address instead of skipping), so the only
      // paths left here are a transient gas spike — deferred, not terminal,
      // so it doesn't burn the retry budget — or a genuine failure.
      const status = (error.code === 'GAS_CEILING' || error.message?.startsWith('GAS_CEILING:')) ? 'pending' : 'failed';
      this._log(`EAS submission failed (attestation still valid)`, {
        error: error.message,
        status
      });

      try {
        receipt.eas.status = status;
        await dataStore.saveAttestation(receipt);
        await dataStore.saveEasSubmission(receipt.receipt_id, {
          status: 'failed',
          error: error.message,
          attempted_at: new Date().toISOString()
        });
      } catch (trackingError) {
        this._log(`Failed to track EAS submission error: ${trackingError.message}`);
      }
    }
  }

  /**
   * Score consistency verification
   * Direct port from VERIFICATION_CRITERIA.MD
   */
  _scoreConsistency(commitment, evidence) {
    // Never read minimum_actions raw: it is absent on every commitment created
    // before it was defaulted, and 0 would make completion_rate Infinity.
    const required = resolveMinimumActions(commitment.criteria);
    const completedEvidence = evidence.filter(e => this._meetsRequirements(e, commitment.criteria));
    const completed = completedEvidence.length;

    // Short-circuit for zero completion
    if (completed === 0) {
      return {
        status: this._getStatus(0),
        completion_rate: 0,
        timeliness_score: 0,
        quality_score: 0,
        overall_score: 0,
        // actions, not days: these count evidence items. A 1-day commitment
        // legitimately completes 3 actions, which as `days_completed: 3` beside
        // `duration_days: 1` read as a contradiction in a signed receipt.
        actions_required: required,
        actions_completed: 0,
        actions_missed: required,
        evidence_count: evidence.length
      };
    }

    const completionRate = Math.min(100, (completed / required) * 100);
    const timelinessScore = this._calculateTimeliness(commitment, evidence);
    const qualityScore = this._calculateConsistencyQuality(evidence, commitment.criteria.content_requirements);

    const weights = this.rules.scoring_weights.consistency;
    const overallScore = (
      completionRate * weights.completion_rate +
      timelinessScore * weights.timeliness +
      qualityScore * weights.quality
    );

    return {
      status: this._getStatus(overallScore),
      completion_rate: Math.round(completionRate),
      timeliness_score: Math.round(timelinessScore),
      quality_score: Math.round(qualityScore),
      overall_score: Math.round(overallScore),
      // The target is stated explicitly rather than left implicit in the
      // completion rate, so a receipt says what it was scored against.
      actions_required: required,
      actions_completed: completed,
      // Clamped: exceeding the target is normal now that collection returns the
      // whole window, and a negative "missed" count in a signed receipt reads
      // as a bug to anyone auditing it.
      actions_missed: Math.max(0, required - completed),
      evidence_count: evidence.length
    };
  }

  /**
   * Score quality verification
   */
  _scoreQuality(commitment, evidence) {
    const metrics = commitment.criteria.quality_metrics;
    const samples = evidence.length;

    if (samples < commitment.criteria.minimum_samples) {
      return {
        status: 'failed',
        reason: `Insufficient samples: ${samples}/${commitment.criteria.minimum_samples}`,
        overall_score: 0,
        evidence_count: samples
      };
    }

    const metricScores = {};

    // Response time score
    if (metrics.response_time_minutes !== undefined) {
      const onTimeCount = evidence.filter(e =>
        e.response_time_minutes && e.response_time_minutes <= metrics.response_time_minutes
      ).length;
      metricScores.response_time = (onTimeCount / samples) * 100;
    }

    // Length/completeness score
    if (metrics.minimum_length !== undefined) {
      const sufficientLengthCount = evidence.filter(e =>
        e.content_length && e.content_length >= metrics.minimum_length
      ).length;
      metricScores.completeness = (sufficientLengthCount / samples) * 100;
    }

    // Format compliance score
    if (metrics.required_format) {
      const formatCompliantCount = evidence.filter(e =>
        e.format === metrics.required_format
      ).length;
      metricScores.format = (formatCompliantCount / samples) * 100;
    }

    // Satisfaction score
    if (metrics.satisfaction_threshold !== undefined) {
      const withRatings = evidence.filter(e => e.satisfaction_rating !== undefined);
      if (withRatings.length > 0) {
        const avgSatisfaction = withRatings.reduce((sum, e) => sum + e.satisfaction_rating, 0) / withRatings.length;
        metricScores.satisfaction = (avgSatisfaction / 5) * 100;
      }
    }

    // Technical accuracy
    if (metrics.technical_accuracy) {
      const accurateCount = evidence.filter(e => e.accuracy_verified).length;
      metricScores.accuracy = (accurateCount / samples) * 100;
    }

    // Weighted overall score
    const weights = this._getMetricWeights(metrics);
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    const overallScore = Object.keys(metricScores).reduce((sum, metric) => {
      return sum + (metricScores[metric] * weights[metric]);
    }, 0) / totalWeight;

    return {
      status: this._getStatus(overallScore),
      quality_score: Math.round(overallScore),
      metric_breakdown: metricScores,
      samples_evaluated: samples,
      overall_score: Math.round(overallScore),
      evidence_count: evidence.length
    };
  }

  /**
   * Score time-bound verification
   */
  _scoreTimeBound(commitment, evidence) {
    const milestones = commitment.criteria.milestones;
    const penaltyRate = commitment.criteria.penalty_per_late_hour || 1;

    const milestoneScores = [];

    milestones.forEach(milestone => {
      const delivery = evidence.find(e => e.milestone_id === milestone.milestone_id);

      if (!delivery) {
        milestoneScores.push({
          milestone_id: milestone.milestone_id,
          score: 0,
          status: 'missed',
          hours_late: 'N/A'
        });
        return;
      }

      const deadline = new Date(milestone.deadline);
      const delivered = new Date(delivery.timestamp);
      const gracePeriod = (milestone.grace_period_hours || 0) * 60 * 60 * 1000;

      const hoursEarly = (deadline - delivered) / 3600000;
      const hoursLate = (delivered - deadline - gracePeriod) / 3600000;

      let score = 100;

      if (hoursLate > 0) {
        // Late delivery
        const penalty = Math.min(100, hoursLate * penaltyRate);
        score = Math.max(0, 100 - penalty);

        milestoneScores.push({
          milestone_id: milestone.milestone_id,
          score: Math.round(score),
          status: 'late',
          hours_late: Math.round(hoursLate)
        });
      } else if (hoursEarly > 0) {
        // Early delivery (bonus)
        const bonus = Math.min(
          this.rules.scoring_weights.time_bound.early_bonus_max,
          hoursEarly * this.rules.scoring_weights.time_bound.early_bonus_per_hour
        );
        score = Math.min(
          this.rules.scoring_weights.time_bound.max_score_with_bonus,
          100 + bonus
        );

        milestoneScores.push({
          milestone_id: milestone.milestone_id,
          score: Math.round(score),
          status: 'early',
          hours_early: Math.round(hoursEarly)
        });
      } else {
        // On time
        milestoneScores.push({
          milestone_id: milestone.milestone_id,
          score: 100,
          status: 'on_time'
        });
      }
    });

    // Average milestone scores
    const avgScore = milestoneScores.reduce((sum, m) => sum + m.score, 0) / milestones.length;
    const completedCount = milestoneScores.filter(m => m.score > 0).length;
    const completionRate = (completedCount / milestones.length) * 100;

    return {
      status: this._getStatus(avgScore),
      timeliness_score: Math.round(avgScore),
      completion_rate: Math.round(completionRate),
      milestones_completed: completedCount,
      milestones_total: milestones.length,
      milestone_details: milestoneScores,
      overall_score: Math.round(avgScore),
      evidence_count: evidence.length
    };
  }

  /**
   * Calculate difficulty level
   */
  calculateDifficulty(commitment) {
    let difficultyScore = 0;

    // Duration factor
    const days = commitment.criteria.duration_days || commitment.criteria.milestones?.length || 1;
    if (days <= 3) difficultyScore += 1;
    else if (days <= 14) difficultyScore += 2;
    else if (days <= 30) difficultyScore += 3;
    else difficultyScore += 4;

    // Frequency factor
    if (commitment.criteria.frequency === 'hourly') difficultyScore += 2;
    else if (commitment.criteria.frequency === 'daily') difficultyScore += 1;

    // Quality requirements
    if (commitment.criteria.quality_metrics) {
      difficultyScore += Math.min(2, Object.keys(commitment.criteria.quality_metrics).length);
    }

    // Multi-platform
    if (commitment.criteria.platforms?.length > 1) difficultyScore += 1;

    // Map to level
    for (const [level, config] of Object.entries(this.rules.difficulty_thresholds)) {
      if (difficultyScore <= config.max_score) return level;
    }
    return 'expert';
  }

  // --- Helper methods ---

  _getStatus(score) {
    if (score >= this.rules.thresholds.verified) return 'verified';
    if (score >= this.rules.thresholds.partial) return 'partial';
    return 'failed';
  }

  _meetsRequirements(evidence, criteria) {
    if (!criteria.content_requirements) return true;

    const req = criteria.content_requirements;

    // Check min_length
    if (req.min_length && evidence.content_length < req.min_length) {
      return false;
    }

    // Check required_tags
    if (req.required_tags && Array.isArray(req.required_tags)) {
      const hasTags = req.required_tags.every(tag =>
        evidence.content_tags?.includes(tag)
      );
      if (!hasTags) return false;
    }

    // Check forbidden_content
    if (req.forbidden_content && Array.isArray(req.forbidden_content)) {
      const hasForbidden = req.forbidden_content.some(term =>
        evidence.content_text?.toLowerCase().includes(term)
      );
      if (hasForbidden) return false;
    }

    return true;
  }

  _calculateTimeliness(commitment, evidence) {
    if (evidence.length < 2) return 100;

    const expectedInterval = this._getExpectedInterval(commitment.criteria.frequency);
    const gracePeriod = commitment.criteria.grace_period_hours || this.rules.grace_periods.consistency_daily_hours;

    // Evidence is appended across collection runs, and each run re-queries the
    // whole window, so the persisted array is not globally ordered. Out of order
    // it yields a negative interval, which passes the check below and scores a
    // missed deadline as on-time.
    const ordered = [...evidence].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    let onTimeCount = 0;

    for (let i = 1; i < ordered.length; i++) {
      const timeSinceLast = (new Date(ordered[i].timestamp) - new Date(ordered[i - 1].timestamp)) / 3600000;

      if (timeSinceLast <= expectedInterval + gracePeriod) {
        onTimeCount++;
      }
    }

    const totalIntervals = ordered.length - 1;
    return (onTimeCount / totalIntervals) * 100;
  }

  _getExpectedInterval(frequency) {
    switch (frequency) {
      case 'hourly': return 1;
      case 'daily': return 24;
      case 'weekly': return 168;
      default: return 24;
    }
  }

  _calculateConsistencyQuality(evidence, requirements) {
    if (!requirements) return 100;

    let qualitySum = 0;

    evidence.forEach(e => {
      let score = 100;

      if (requirements.min_length && e.content_length < requirements.min_length) {
        score -= 20;
      }

      if (requirements.required_tags && Array.isArray(requirements.required_tags)) {
        const hasTags = requirements.required_tags.every(tag => e.content_tags?.includes(tag));
        if (!hasTags) score -= 30;
      }

      if (requirements.forbidden_content && Array.isArray(requirements.forbidden_content)) {
        const hasForbidden = requirements.forbidden_content.some(term =>
          e.content_text?.toLowerCase().includes(term)
        );
        if (hasForbidden) score -= 50;
      }

      qualitySum += Math.max(0, score);
    });

    return evidence.length > 0 ? qualitySum / evidence.length : 0;
  }

  _getMetricWeights(metrics) {
    const highWeightMetrics = this.rules.scoring_weights.quality.high_weight_metrics;
    const highWeightMultiplier = this.rules.scoring_weights.quality.high_weight_multiplier;

    const weights = {};
    let baseWeight = 1;

    if (metrics.response_time_minutes !== undefined) weights.response_time = baseWeight;
    if (metrics.minimum_length !== undefined) weights.completeness = baseWeight;
    if (metrics.required_format) weights.format = baseWeight;
    if (metrics.satisfaction_threshold !== undefined) {
      weights.satisfaction = highWeightMetrics.includes('satisfaction') ? baseWeight * highWeightMultiplier : baseWeight;
    }
    if (metrics.technical_accuracy) {
      weights.accuracy = highWeightMetrics.includes('accuracy') ? baseWeight * highWeightMultiplier : baseWeight;
    }

    return weights;
  }

  /**
   * Whether a commitment can be scored yet, given how evidence collection went.
   *
   * A relay outage yields the same empty evidence array as an agent that did
   * nothing, and scoring that difference away means signing a receipt saying a
   * paying customer was inactive. So scoring waits for a collection that
   * succeeded after the window closed.
   *
   * It cannot wait forever — the customer paid and is owed a receipt — so after
   * a grace period it scores anyway and flags the result as degraded.
   *
   * This lives here, not in monitoring-service, because getStatus scores from
   * an unauthenticated poll and would otherwise walk straight past the wait.
   *
   * @returns {{ready: boolean, degraded?: boolean, reason?: string}}
   */
  _collectionReadiness(commitment) {
    // No monitoring block at all: either nothing collects for this commitment
    // (the free API route, an unsupported platform) or it predates this field.
    // Waiting would strand it, so score immediately as before.
    if (!commitment.monitoring) return { ready: true };

    const endDate = new Date(commitment.end_date);
    const lastSuccess = commitment.monitoring.last_success_at
      ? new Date(commitment.monitoring.last_success_at)
      : null;

    if (lastSuccess && lastSuccess >= endDate) {
      return { ready: true };
    }

    const graceHours = this.rules.monitoring?.collection_grace_hours ?? 24;
    const deadline = new Date(endDate.getTime() + graceHours * 60 * 60 * 1000);
    if (new Date() >= deadline) {
      return {
        ready: true,
        degraded: true,
        reason: `no successful collection within ${graceHours}h of the window closing`
      };
    }

    return {
      ready: false,
      reason:
        `no successful collection since the window closed ` +
        `(${commitment.monitoring.consecutive_failures || 0} consecutive failures, ` +
        `grace expires ${deadline.toISOString()})`
    };
  }

  _validateCommitment(commitment) {
    if (!commitment.agent_id) throw new ValidationError('agent_id is required');
    if (!commitment.description) throw new ValidationError('description is required');
    if (!commitment.verification_type) throw new ValidationError('verification_type is required');
    if (!['consistency', 'quality', 'time_bound'].includes(commitment.verification_type)) {
      throw new ValidationError(`Invalid verification_type: ${commitment.verification_type}`);
    }
    if (!commitment.criteria) throw new ValidationError('criteria is required');
    if (typeof commitment.criteria !== 'object' || Array.isArray(commitment.criteria)) {
      throw new ValidationError('criteria must be an object');
    }
    // Guarded here rather than at the callers: a non-numeric duration reaches
    // `new Date(NaN).toISOString()` in createVerification and throws a
    // RangeError, and a negative one silently yields an end_date in the past.
    if (commitment.criteria.duration_days !== undefined) {
      const days = Number(commitment.criteria.duration_days);
      if (!Number.isFinite(days) || days <= 0) {
        throw new ValidationError('criteria.duration_days must be a positive number');
      }
    }
    // minimum_actions is the completion-rate denominator, and the paid routes
    // spread caller criteria straight through. A 0 makes the rate Infinity,
    // which clamps to 100 and buys a `verified` receipt for one action.
    if (commitment.criteria.minimum_actions !== undefined) {
      const actions = Number(commitment.criteria.minimum_actions);
      if (!Number.isInteger(actions) || actions <= 0) {
        throw new ValidationError('criteria.minimum_actions must be a positive integer');
      }
    }
  }

  _validateEvidence(evidence, platform) {
    const requirements = this.rules.evidence_requirements[platform];
    if (!requirements) {
      return { valid: false, errors: [`Unknown platform: ${platform}`] };
    }

    const errors = [];
    for (const field of requirements.required_fields) {
      if (!evidence[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

module.exports = new VerificationService();
module.exports.VerificationService = VerificationService;
module.exports.deriveMinimumActions = deriveMinimumActions;
module.exports.resolveMinimumActions = resolveMinimumActions;
