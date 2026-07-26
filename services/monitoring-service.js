// /services/monitoring-service.js
// Periodic evidence collection from platforms
//
// Uses setInterval rather than node-schedule's cron string: cron minute fields
// only range 0-59, so the previous `*/${intervalMinutes} * * * *` rule was
// already degenerate at this service's default of 60 (it collapsed to "minute 0"
// and only looked hourly by accident) and silently misbehaves for anything
// larger. reconciliation-service.js made the same move for the same reason.

const moltbookApi = require('../utils/moltbook-api');
const clawstrApi = require('../utils/clawstr-api');
const dataStore = require('./data-store');
const rules = require('../config/verification-rules.json');
const crypto = require('crypto');

// A tick re-reads every commitment JSON file, so an unbounded active set turns
// each run into an O(all commitments) scan plus one network fetch per item.
const MAX_PER_RUN = Number(process.env.MONITOR_MAX_PER_RUN) || 50;

class MonitoringService {
  constructor() {
    this.timer = null;
    this.running = false;
    this.verificationService = null;
  }

  _log(message, data = null) {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [MonitoringService] ${message}`;
    if (data) {
      let dataStr;
      try { dataStr = JSON.stringify(data); } catch (e) { dataStr = String(data); }
      line += ` ${dataStr.length > 300 ? `${dataStr.slice(0, 300)}…` : dataStr}`;
    }
    console.log(line);
  }

  /**
   * Initialize with verification service reference
   */
  initialize(verificationService) {
    if (!verificationService) {
      throw new Error('MonitoringService.initialize requires a verification service');
    }
    this.verificationService = verificationService;
    this._log('Initialized');
  }

  /**
   * Start periodic monitoring.
   *
   * @param {number} intervalMinutes
   * @param {Object} [options]
   * @param {boolean} [options.immediate=false] - run one tick right away rather
   *   than waiting a full interval. Off by default so a tick never collides
   *   with a cold start that is still opening sockets.
   */
  async start(intervalMinutes = 60, { immediate = false } = {}) {
    // Without this the interval callback throws on this.verificationService
    // inside a timer, where the only thing that catches it is the per-commitment
    // handler in checkAllActive — so it would log once per commitment forever
    // instead of failing loudly at startup.
    if (!this.verificationService) {
      throw new Error('MonitoringService.start called before initialize');
    }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      throw new Error(`Invalid monitoring interval: ${intervalMinutes}`);
    }
    if (this.timer) {
      this._log('Monitoring already started, ignoring duplicate start');
      return;
    }

    this.timer = setInterval(() => {
      this.checkAllActive().catch(error => {
        this._log(`Scheduled monitoring run failed: ${error.message}`);
      });
    }, intervalMinutes * 60 * 1000);
    // The listening socket (x402) or the bot client keeps the process alive;
    // this timer should never be the reason it stays up.
    if (typeof this.timer.unref === 'function') this.timer.unref();

    this._log(`Monitoring started: checking every ${intervalMinutes} minutes`);

    if (immediate) {
      await this.checkAllActive().catch(error => {
        this._log(`Initial monitoring run failed: ${error.message}`);
      });
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._log('Monitoring stopped');
    }
  }

  /**
   * Check all active commitments for new evidence
   */
  async checkAllActive() {
    // Each commitment costs a network fetch, so a slow run can outlast its
    // interval. Overlapping runs would double-collect and race on saveCommitment.
    if (this.running) {
      this._log('Previous monitoring run still in progress, skipping this tick');
      return;
    }
    this.running = true;

    try {
      const activeCommitments = await dataStore.listCommitments('active');

      const maxActive = rules.monitoring?.max_active_commitments;
      if (maxActive && activeCommitments.length > maxActive) {
        this._log(
          `WARNING: ${activeCommitments.length} active commitments exceeds ` +
          `max_active_commitments (${maxActive})`
        );
      }

      // Soonest-expiring first: under the per-run cap these are the ones about
      // to be scored, so they must never be starved by long-running commitments.
      const queue = [...activeCommitments].sort(
        (a, b) => new Date(a.end_date) - new Date(b.end_date)
      );
      const batch = queue.slice(0, MAX_PER_RUN);

      if (queue.length > batch.length) {
        this._log(
          `Checking ${batch.length} of ${queue.length} active commitments ` +
          `(capped at MONITOR_MAX_PER_RUN=${MAX_PER_RUN}); ` +
          `${queue.length - batch.length} deferred to the next run`
        );
      } else {
        this._log(`Checking ${batch.length} active commitments`);
      }

      for (const commitment of batch) {
        try {
          await this.checkCommitment(commitment);
        } catch (error) {
          this._log(`Error checking commitment ${commitment.commitment_id}: ${error.message}`);
        }
      }
    } finally {
      this.running = false;
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
