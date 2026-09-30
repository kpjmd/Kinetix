// /services/baseline-service.js
// The "what does this agent's recent activity look like" snapshot returned
// with a paid verification.
//
// A verification's real result — the signed receipt — cannot exist until the
// monitoring window closes, days after purchase. OKX AI expects a paid call to
// deliver something substantive in the same response, and delisted this
// service when buyers paid and received only a commitment id. The baseline is
// that something: a look at the agent's activity over the days *before* the
// purchase, plus a read of whether that pace would meet the commitment.
//
// Context only, never evidence. The window starts at purchase, and Nostr
// `created_at` is author-controlled, so pre-purchase history must not count
// toward a score (a backdated event would otherwise buy a pass). Nothing here
// is written to the commitment.
//
// Never throws. The caller is holding a paid request open; a relay outage
// must degrade the snapshot, not the delivery.

const clawstrApi = require('../utils/clawstr-api');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
// Well inside the request budget: the payment middleware still has to settle
// after the handler returns, and a buyer's client is waiting on all of it.
const DEFAULT_TIMEOUT_MS = Number(process.env.KINETIX_BASELINE_TIMEOUT_MS) || 8000;

const NOTE =
  'Snapshot of activity before this purchase, for context only. It does not count toward the ' +
  'final score: only activity inside the monitoring window does.';

/**
 * @param {Object} commitment - { pubkey, verification_type, criteria }
 * @param {Object} [options] - { lookbackDays, timeoutMs, now }
 * @returns {Promise<Object>} the baseline block for the paid response
 */
async function buildBaseline(commitment, options = {}) {
  const lookbackDays = options.lookbackDays || DEFAULT_LOOKBACK_DAYS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const now = options.now || Date.now();
  const from = now - lookbackDays * DAY_MS;

  const base = {
    lookback_days: lookbackDays,
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    note: NOTE
  };

  const platform = commitment.criteria?.platform;
  if (platform !== 'clawstr' || !commitment.pubkey) {
    return { ...base, status: 'unavailable', reason: `No baseline collector for platform "${platform}"` };
  }

  let result;
  try {
    // One attempt with a short spawn timeout, raced against a hard cap so a
    // stuck child process cannot hold the paid response past the budget.
    result = await withTimeout(
      clawstrApi.getEventsByAuthor(commitment.pubkey, {
        since: Math.floor(from / 1000),
        until: Math.floor(now / 1000),
        timeoutMs,
        attempts: 1
      }),
      timeoutMs + 500
    );
  } catch (error) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'The Nostr relays did not answer in time. Monitoring is unaffected; check status_url later.'
    };
  }

  const events = result.events.filter(e =>
    Number.isFinite(e.created_at) && e.created_at * 1000 >= from && e.created_at * 1000 <= now + 300000
  );
  // Calendar dates for display. Active days are counted in rolling 24h
  // buckets back from `now` instead: a 7x24h window touches 8 calendar dates,
  // which read as "posted on 8 of the last 7 days".
  const days = new Map();
  const activeBuckets = new Set();
  for (const e of events) {
    const t = e.created_at * 1000;
    const day = new Date(t).toISOString().slice(0, 10);
    days.set(day, (days.get(day) || 0) + 1);
    activeBuckets.add(Math.min(lookbackDays - 1, Math.max(0, Math.floor((now - t) / DAY_MS))));
  }

  const partial = result.relaysOk < result.relaysTotal;
  return {
    ...base,
    status: partial ? 'partial' : 'complete',
    relays: { answered: result.relaysOk, total: result.relaysTotal },
    events_found: events.length,
    active_days: activeBuckets.size,
    daily_counts: Object.fromEntries([...days.entries()].sort()),
    first_activity_at: events.length ? new Date(events[0].created_at * 1000).toISOString() : null,
    last_activity_at: events.length ? new Date(events[events.length - 1].created_at * 1000).toISOString() : null,
    ...outlook(commitment, events, activeBuckets.size, lookbackDays, partial)
  };
}

/**
 * Would the recent pace meet the commitment? A plain-language read, not a
 * score — the receipt is the score.
 */
function outlook(commitment, events, activeDays, lookbackDays, partial) {
  const criteria = commitment.criteria || {};
  const caveat = partial ? ' Some relays did not answer, so this may undercount.' : '';

  if (events.length === 0) {
    return {
      outlook: 'no_recent_activity',
      outlook_reason: `No posts found in the last ${lookbackDays} days.${caveat}`
    };
  }

  if (commitment.verification_type === 'quality') {
    const minLength = criteria.quality_metrics?.minimum_length;
    if (minLength !== undefined) {
      const long = events.filter(e => (e.content || '').length >= minLength).length;
      const share = long / events.length;
      return {
        outlook: share >= 0.8 ? 'on_track' : 'at_risk',
        outlook_reason:
          `${long} of ${events.length} recent posts meet the ${minLength}-character minimum.${caveat}`
      };
    }
  }

  if (criteria.frequency === 'weekly') {
    return {
      outlook: 'on_track',
      outlook_reason: `${events.length} posts in the last ${lookbackDays} days; the commitment needs at least one a week.${caveat}`
    };
  }

  // Daily consistency (the default).
  const share = activeDays / lookbackDays;
  return {
    outlook: share >= 0.8 ? 'on_track' : 'at_risk',
    outlook_reason:
      `Posted on ${activeDays} of the last ${lookbackDays} days; a daily commitment needs activity ` +
      `on nearly every day.${caveat}`
  };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

module.exports = { buildBaseline };
