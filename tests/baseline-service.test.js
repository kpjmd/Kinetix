// tests/baseline-service.test.js
// The baseline snapshot rides inside a paid response, so it must never throw
// and never outlast its time budget, whatever the relays do.

const clawstrApi = require('../utils/clawstr-api');
const { buildBaseline } = require('../services/baseline-service');

const HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';
const NOW = Date.parse('2026-09-30T12:00:00Z');
const HOUR = 3600;
const nowSec = NOW / 1000;

function commitment(criteria = {}, verification_type = 'consistency') {
  return { pubkey: HEX, verification_type, criteria: { platform: 'clawstr', ...criteria } };
}

function stubEvents(events, relaysOk = 3) {
  return jest.spyOn(clawstrApi, 'getEventsByAuthor').mockResolvedValue({ events, relaysOk, relaysTotal: 3 });
}

afterEach(() => jest.restoreAllMocks());

describe('buildBaseline', () => {
  it('queries only the look-back window, once, with a short timeout', async () => {
    const spy = stubEvents([]);
    await buildBaseline(commitment(), { now: NOW, timeoutMs: 5000 });

    expect(spy).toHaveBeenCalledWith(HEX, {
      since: nowSec - 7 * 24 * HOUR,
      until: nowSec,
      timeoutMs: 5000,
      attempts: 1
    });
  });

  it('counts active days in rolling 24h buckets, never more days than the window', async () => {
    // One post in each of the 7 rolling days, plus one at the very start of
    // the window, which lands on an 8th calendar date.
    const events = [];
    for (let d = 0; d < 7; d++) events.push({ id: `e${d}`, created_at: nowSec - d * 24 * HOUR - HOUR, content: 'x' });
    events.push({ id: 'edge', created_at: nowSec - 7 * 24 * HOUR + 60, content: 'x' });
    stubEvents(events.sort((a, b) => a.created_at - b.created_at));

    const baseline = await buildBaseline(commitment({ frequency: 'daily' }), { now: NOW });

    expect(baseline.active_days).toBe(7);
    expect(Object.keys(baseline.daily_counts)).toHaveLength(8);
    expect(baseline.outlook).toBe('on_track');
    expect(baseline.outlook_reason).toMatch(/7 of the last 7 days/);
  });

  it('flags a sparse daily poster as at risk', async () => {
    stubEvents([{ id: 'a', created_at: nowSec - HOUR, content: 'x' }]);
    const baseline = await buildBaseline(commitment({ frequency: 'daily' }), { now: NOW });

    expect(baseline.outlook).toBe('at_risk');
  });

  it('reports no recent activity rather than a verdict when nothing was found', async () => {
    stubEvents([]);
    const baseline = await buildBaseline(commitment(), { now: NOW });

    expect(baseline.status).toBe('complete');
    expect(baseline.outlook).toBe('no_recent_activity');
    expect(baseline.last_activity_at).toBeNull();
  });

  it('judges quality on post length', async () => {
    stubEvents([
      { id: 'a', created_at: nowSec - HOUR, content: 'x'.repeat(300) },
      { id: 'b', created_at: nowSec - 2 * HOUR, content: 'short' }
    ]);
    const baseline = await buildBaseline(
      commitment({ quality_metrics: { minimum_length: 200 } }, 'quality'),
      { now: NOW }
    );

    expect(baseline.outlook).toBe('at_risk');
    expect(baseline.outlook_reason).toMatch(/1 of 2 recent posts/);
  });

  it('marks a partial relay answer and says it may undercount', async () => {
    stubEvents([{ id: 'a', created_at: nowSec - HOUR, content: 'x' }], 2);
    const baseline = await buildBaseline(commitment({ frequency: 'weekly' }), { now: NOW });

    expect(baseline.status).toBe('partial');
    expect(baseline.outlook_reason).toMatch(/may undercount/);
  });

  it('never throws on a relay failure', async () => {
    jest.spyOn(clawstrApi, 'getEventsByAuthor').mockRejectedValue(new Error('boom'));
    const baseline = await buildBaseline(commitment(), { now: NOW });

    expect(baseline.status).toBe('unavailable');
  });

  it('gives up at the time cap even if the query never returns', async () => {
    jest.spyOn(clawstrApi, 'getEventsByAuthor').mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const baseline = await buildBaseline(commitment(), { now: NOW, timeoutMs: 50 });

    expect(baseline.status).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('has nothing to say for a platform without a collector', async () => {
    const spy = stubEvents([]);
    const baseline = await buildBaseline({ pubkey: HEX, criteria: { platform: 'telegram' } }, { now: NOW });

    expect(baseline.status).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });
});
