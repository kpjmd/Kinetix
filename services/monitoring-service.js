// /services/monitoring-service.js
// Periodic evidence collection from platforms

const schedule = require('node-schedule');
const moltbookApi = require('../utils/moltbook-api');
const clawstrApi = require('../utils/clawstr-api');
const dataStore = require('./data-store');
const crypto = require('crypto');

class MonitoringService {
  constructor() {
    this.job = null;
    this.verificationService = null;
    this.registeredCommitments = new Set();
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [MonitoringService] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  /**
   * Initialize with verification service reference
   */
  initialize(verificationService) {
    this.verificationService = verificationService;
    this._log('Initialized');
  }

  /**
   * Register a commitment for monitoring
   */
  registerCommitment(commitmentId) {
    this.registeredCommitments.add(commitmentId);
    this._log(`Registered commitment ${commitmentId} for monitoring`);
  }

  /**
   * Start periodic monitoring
   */
  async start(intervalMinutes = 60) {
    const cronRule = `*/${intervalMinutes} * * * *`;
    this.job = schedule.scheduleJob(cronRule, async () => {
      await this.checkAllActive();
    });
    this._log(`Monitoring started: checking every ${intervalMinutes} minutes`);
  }

  stop() {
    if (this.job) {
      this.job.cancel();
      this.job = null;
      this._log('Monitoring stopped');
    }
  }

  /**
   * Check all active commitments for new evidence
   */
  async checkAllActive() {
    const activeCommitments = await dataStore.listCommitments('active');
    this._log(`Checking ${activeCommitments.length} active commitments`);

    for (const commitment of activeCommitments) {
      try {
        await this.checkCommitment(commitment);
      } catch (error) {
        this._log(`Error checking commitment ${commitment.commitment_id}: ${error.message}`);
      }
    }
  }

  /**
   * Check a single commitment for new evidence
   */
  async checkCommitment(commitment) {
    const platform = commitment.criteria.platform;

    let newEvidence = [];
    switch (platform) {
      case 'moltbook':
        newEvidence = await this._collectMoltbookEvidence(commitment);
        break;
      case 'clawstr':
        newEvidence = await this._collectClawstrEvidence(commitment);
        break;
      // telegram, github, onchain - stubs for Phase 1
      default:
        this._log(`Platform ${platform} monitoring not yet implemented`);
        return;
    }

    // Filter out already-recorded evidence
    const existingUrls = new Set(commitment.evidence.map(e => e.action_url || e.event_id));
    const genuinelyNew = newEvidence.filter(e =>
      !existingUrls.has(e.action_url || e.event_id)
    );

    // Add each new evidence item
    for (const ev of genuinelyNew) {
      await this.verificationService.addEvidence(commitment.commitment_id, ev);
    }

    if (genuinelyNew.length > 0) {
      this._log(`Added ${genuinelyNew.length} new evidence items to ${commitment.commitment_id}`);
    }

    // Check if commitment has expired -> trigger scoring
    if (new Date() >= new Date(commitment.end_date)) {
      if (commitment.status === 'active') {
        this._log(`Commitment ${commitment.commitment_id} has ended, triggering scoring`);
        await this.verificationService.scoreVerification(commitment.commitment_id);
      }
    }
  }

  /**
   * Collect evidence from Moltbook
   */
  async _collectMoltbookEvidence(commitment) {
    const agentProfile = commitment.platform_profiles?.moltbook;
    if (!agentProfile) {
      this._log('No Moltbook profile for commitment', commitment.commitment_id);
      return [];
    }

    try {
      // Search for posts by the agent
      const results = await moltbookApi.search(agentProfile, 'posts', 50);
      const posts = results.posts || results.results || results || [];

      // Filter to posts after commitment start date
      const startDate = new Date(commitment.start_date);
      const relevantPosts = posts.filter(post => {
        const postDate = new Date(post.created_at || post.timestamp);
        return postDate >= startDate;
      });

      // Convert to evidence format
      return relevantPosts.map(post => ({
        timestamp: post.created_at || post.timestamp,
        platform: 'moltbook',
        action_type: commitment.criteria.action_type || 'post',
        action_url: `https://www.moltbook.com/posts/${post.id}`,
        content_hash: 'sha256:' + crypto.createHash('sha256')
          .update(post.content || '').digest('hex').slice(0, 32),
        content_length: (post.content || '').length,
        content_tags: post.tags || [],
        content_text: post.content || '',
        verification_method: 'api_confirmed'
      }));
    } catch (error) {
      this._log(`Moltbook evidence collection error: ${error.message}`);
      return [];
    }
  }

  /**
   * Collect evidence from Clawstr
   */
  async _collectClawstrEvidence(commitment) {
    const agentPubkey = commitment.pubkey || commitment.platform_profiles?.clawstr;
    if (!agentPubkey) {
      this._log('No Clawstr pubkey for commitment', commitment.commitment_id);
      return [];
    }

    try {
      // Get events from the relevant subclaw
      const subclaw = commitment.criteria.subclaw || '/c/ai-freedom';
      const events = await clawstrApi.getFeed(subclaw, 50);

      // Filter to events by this agent since start date
      const startTimestamp = Math.floor(new Date(commitment.start_date).getTime() / 1000);

      // Handle hex pubkey (starts with 0x) or npub format
      let pubkeyToMatch = agentPubkey;
      if (agentPubkey.startsWith('0x')) {
        pubkeyToMatch = agentPubkey.slice(2); // Remove 0x prefix
      } else if (agentPubkey.startsWith('npub')) {
        // For now, just use the npub as-is
        // A full implementation would decode bech32 to hex
        this._log('Warning: npub format not yet fully supported, matching may fail');
      }

      const relevantEvents = events.filter(event =>
        (event.pubkey === pubkeyToMatch || event.pubkey === agentPubkey) &&
        event.created_at >= startTimestamp
      );

      // Convert to evidence format
      return relevantEvents.map(event => ({
        timestamp: new Date(event.created_at * 1000).toISOString(),
        platform: 'clawstr',
        action_type: commitment.criteria.action_type || 'post',
        event_id: event.id,
        signature: event.sig || '',
        content_hash: 'sha256:' + crypto.createHash('sha256')
          .update(event.content || '').digest('hex').slice(0, 32),
        content_length: (event.content || '').length,
        content_text: event.content || '',
        verification_method: 'nostr_signature'
      }));
    } catch (error) {
      this._log(`Clawstr evidence collection error: ${error.message}`);
      return [];
    }
  }
}

module.exports = new MonitoringService();
module.exports.MonitoringService = MonitoringService;
