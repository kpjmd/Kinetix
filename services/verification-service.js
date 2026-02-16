// /services/verification-service.js
// Core verification orchestrator with scoring algorithms

const dataStore = require('./data-store');
const verificationRules = require('../config/verification-rules.json');
const crypto = require('crypto');
const ipfsManager = require('../utils/ipfs-manager');
const reputationService = require('../utils/erc8004-reputation');

class VerificationService {
  constructor() {
    this.rules = verificationRules;
    this.monitoringService = null;
    this.attestationService = null;
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
      platform_profiles: commitment.platform_profiles || {},
      description: commitment.description,
      verification_type: commitment.verification_type,
      criteria: commitment.criteria,
      difficulty,
      status: 'active',
      evidence: [],
      created_at: now,
      start_date: startDate,
      end_date: endDate,
      payment: commitment.payment || null,
      scoring_result: null
    };

    await dataStore.saveCommitment(record);
    this._log(`Created verification ${commitmentId}`, { difficulty, verification_type: commitment.verification_type });

    // Register with monitoring service
    if (this.monitoringService) {
      this.monitoringService.registerCommitment(commitmentId);
    }

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
    const commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment) return null;

    // Check if expired and needs scoring
    if (commitment.status === 'active' && new Date() >= new Date(commitment.end_date)) {
      this._log(`Commitment ${verificationId} has expired, triggering scoring`);
      await this.scoreVerification(verificationId);
      return await dataStore.loadCommitment(verificationId);
    }

    return {
      verification_id: commitment.commitment_id,
      status: commitment.status,
      verification_type: commitment.verification_type,
      evidence_count: commitment.evidence.length,
      created_at: commitment.created_at,
      end_date: commitment.end_date,
      scoring_result: commitment.scoring_result
    };
  }

  /**
   * Add evidence to a commitment
   */
  async addEvidence(verificationId, evidence) {
    const commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${verificationId}`);
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

    // Check if commitment period ended -> trigger scoring
    if (new Date() >= new Date(commitment.end_date) && commitment.status === 'active') {
      this._log(`Commitment ${verificationId} period ended, triggering scoring`);
      await this.scoreVerification(verificationId);
    }

    return commitment;
  }

  /**
   * Score a verification
   */
  async scoreVerification(verificationId) {
    const commitment = await dataStore.loadCommitment(verificationId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${verificationId}`);
    }

    if (commitment.status !== 'active') {
      this._log(`Commitment ${verificationId} already scored (status: ${commitment.status})`);
      return commitment.scoring_result;
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

    // Week 2 Track B: Auto-submit to IPFS and Reputation Registry
    // Wrapped in try-catch so attestation issuance never fails
    try {
      // Step 1: Upload attestation to IPFS
      this._log(`Uploading attestation ${receipt.receipt_id} to IPFS...`);
      const { ipfsHash, gatewayUrl } = await ipfsManager.uploadJSON(receipt, {
        name: `attestation-${receipt.receipt_id}`
      });
      this._log(`Uploaded to IPFS: ${ipfsHash}`);

      // Step 2: Submit to Reputation Registry
      this._log(`Submitting attestation ${receipt.receipt_id} to Reputation Registry...`);
      await reputationService.initialize();
      const result = await reputationService.submitAttestation(receipt, ipfsHash);
      this._log(`Submitted to Reputation Registry`, result);

      // Step 3: Update receipt with on-chain data
      receipt.reputation_context.ipfs_uri = `ipfs://${ipfsHash}`;
      receipt.reputation_context.submission_index = result.feedbackIndex;
      receipt.reputation_context.submitted_at = new Date().toISOString();
      receipt.metadata.onchain_status = 'submitted';
      await dataStore.saveAttestation(receipt);

      // Step 4: Track submission
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

      this._log(`Successfully submitted attestation ${receipt.receipt_id} to on-chain reputation`);
    } catch (error) {
      // Log but don't fail - attestation is still valid without on-chain submission
      this._log(`Reputation submission failed (attestation still valid)`, {
        error: error.message,
        stack: error.stack
      });

      // Track failed submission
      try {
        await dataStore.saveReputationSubmission(receipt.receipt_id, {
          status: 'failed',
          error: error.message,
          attempted_at: new Date().toISOString()
        });
      } catch (trackingError) {
        this._log(`Failed to track submission error: ${trackingError.message}`);
      }
    }

    return receipt;
  }

  /**
   * Score consistency verification
   * Direct port from VERIFICATION_CRITERIA.MD
   */
  _scoreConsistency(commitment, evidence) {
    const required = commitment.criteria.minimum_actions;
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
        days_completed: 0,
        days_missed: required,
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
      days_completed: completed,
      days_missed: required - completed,
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

    let onTimeCount = 0;

    for (let i = 1; i < evidence.length; i++) {
      const timeSinceLast = (new Date(evidence[i].timestamp) - new Date(evidence[i - 1].timestamp)) / 3600000;

      if (timeSinceLast <= expectedInterval + gracePeriod) {
        onTimeCount++;
      }
    }

    const totalIntervals = evidence.length - 1;
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

  _validateCommitment(commitment) {
    if (!commitment.agent_id) throw new Error('agent_id is required');
    if (!commitment.description) throw new Error('description is required');
    if (!commitment.verification_type) throw new Error('verification_type is required');
    if (!['consistency', 'quality', 'time_bound'].includes(commitment.verification_type)) {
      throw new Error(`Invalid verification_type: ${commitment.verification_type}`);
    }
    if (!commitment.criteria) throw new Error('criteria is required');
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
