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

    let collected;
    try {
      switch (platform) {
        case 'moltbook':
          collected = { evidence: await this._collectMoltbookEvidence(commitment), ok: true };
          break;
        case 'clawstr':
          collected = await this._collectClawstrEvidence(commitment);
          break;
        // telegram, github, onchain - stubs for Phase 1
        default:
          this._log(`Platform ${platform} monitoring not yet implemented`);
          return;
      }
    } catch (error) {
      // A failed query is a service fault, not agent inactivity. Record it and
      // fall through to the expiry check anyway: scoring is still *offered*, and
      // verification-service's readiness check defers it while the grace window
      // holds. Returning here instead would mean a lasting outage never scores
      // at all, leaving a paying customer with a commitment stuck active
      // forever and no receipt.
      this._log(`Evidence collection failed for ${commitment.commitment_id}: ${error.message}`);
      const failed = await this._recordCollection(commitment.commitment_id, {
        ok: false,
        error: error.message
      });
      if (failed) await this._scoreIfEnded(failed);
      return;
    }

    const genuinelyNew = this._selectNewEvidence(commitment.evidence, collected.evidence);

    for (const ev of genuinelyNew) {
      await this.verificationService.addEvidence(commitment.commitment_id, ev);
    }

    if (genuinelyNew.length > 0) {
      this._log(`Added ${genuinelyNew.length} new evidence items to ${commitment.commitment_id}`);
    }

    // Reload before doing anything else: addEvidence above rewrote the file, so
    // the snapshot this method was handed is stale, and saves are whole-file.
    const fresh = await this._recordCollection(commitment.commitment_id, { ok: collected.ok });
    if (!fresh) return;

    await this._scoreIfEnded(fresh);
  }

  /**
   * Offer an ended commitment for scoring.
   *
   * Whether it is actually scored is verification-service's call: it owns the
   * grace window that distinguishes "the agent did nothing" from "we could not
   * reach the relays", and it has to, because getStatus scores from an
   * unauthenticated poll that never passes through here.
   */
  async _scoreIfEnded(commitment) {
    if (new Date() < new Date(commitment.end_date)) return;
    if (commitment.status !== 'active') return;

    this._log(`Commitment ${commitment.commitment_id} has ended, offering for scoring`);
    await this.verificationService.scoreVerification(commitment.commitment_id);
  }

  /**
   * Evidence not already recorded, and not duplicated within this batch.
   *
   * Keyed on action_url or event_id — whichever the platform produces. Items
   * with neither are kept rather than collapsed: they used to key on
   * `undefined`, which entered the seen-set and silently dropped every later
   * keyless item.
   */
  _selectNewEvidence(existingEvidence, newEvidence) {
    const seen = new Set(
      (existingEvidence || []).map(e => e.action_url || e.event_id).filter(Boolean)
    );

    const selected = [];
    for (const ev of newEvidence) {
      const key = ev.action_url || ev.event_id;
      if (!key) {
        selected.push(ev);
        continue;
      }
      // Relays overlap, so the same event can arrive twice in one batch and
      // would otherwise be counted as two separate actions.
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(ev);
    }
    return selected;
  }

  /**
   * Reload the commitment and stamp the outcome of this collection attempt.
   *
   * `last_success_at` is what lets scoring tell "the agent did nothing" from
   * "we could not reach the relays", which is the difference between a fair
   * `failed` and a receipt that libels a paying customer.
   *
   * @returns {Promise<Object|null>} the reloaded commitment
   */
  async _recordCollection(commitmentId, { ok, error = null }) {
    const commitment = await dataStore.loadCommitment(commitmentId);
    if (!commitment) return null;

    const previous = commitment.monitoring || {};
    commitment.monitoring = {
      last_attempt_at: new Date().toISOString(),
      last_success_at: ok ? new Date().toISOString() : (previous.last_success_at || null),
      last_error: ok ? null : error,
      consecutive_failures: ok ? 0 : (previous.consecutive_failures || 0) + 1
    };

    await dataStore.saveCommitment(commitment);
    return commitment;
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
    const rawPubkey = commitment.pubkey || commitment.platform_profiles?.clawstr;
    if (!rawPubkey) {
      this._log('No Clawstr pubkey for commitment', commitment.commitment_id);
      return { evidence: [], ok: true };
    }

    // Commitments created through the x402 gate already hold hex. Ones written
    // by discovery-service or the free API route, and any created before that
    // gate existed, may hold a raw npub. Normalising here rather than trusting
    // the stored form makes this the real boundary.
    let hexPubkey;
    try {
      hexPubkey = clawstrApi.normalizeNostrPubkey(rawPubkey);
    } catch (error) {
      // Not recoverable by retrying, so report success-with-nothing rather than
      // a collection failure that would retry this same value every tick.
      this._log(
        `Commitment ${commitment.commitment_id} has an unusable Clawstr pubkey: ${error.message}`
      );
      return { evidence: [], ok: true };
    }

    const startTs = Math.floor(new Date(commitment.start_date).getTime() / 1000);
    const endTs = Math.floor(new Date(commitment.end_date).getTime() / 1000);
    // created_at is set by the author, so a future-dated event could otherwise
    // pad a window that has not happened yet. Relays tolerate modest skew, so
    // allow a small margin rather than cutting exactly at now.
    const maxTs = Math.min(endTs, Math.floor(Date.now() / 1000) + 300);

    // Deliberately unguarded: a throw here means the query failed, and
    // checkCommitment must not score that as the agent having done nothing.
    const { events, relaysOk, relaysTotal } = await clawstrApi.getEventsByAuthor(hexPubkey, {
      since: startTs,
      until: endTs
    });

    const inWindow = events.filter(event =>
      Number.isFinite(event.created_at) &&
      event.created_at >= startTs &&
      event.created_at <= maxTs
    );
    if (inWindow.length !== events.length) {
      this._log(
        `Dropped ${events.length - inWindow.length} Clawstr events outside the ` +
        `commitment window for ${commitment.commitment_id}`
      );
    }

    const collectedAt = new Date().toISOString();
    const evidence = inWindow.map(event => ({
      timestamp: new Date(event.created_at * 1000).toISOString(),
      // The author controls `timestamp`; this one is our own clock, and is the
      // only trustworthy record of when the event was actually observed.
      collected_at: collectedAt,
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

    // A partial outage still returns events, but the set may be short. Treating
    // it as a complete collection would let the grace window expire and score a
    // customer on evidence we know is incomplete.
    return { evidence, ok: relaysOk === relaysTotal };
  }
}

module.exports = new MonitoringService();
module.exports.MonitoringService = MonitoringService;
