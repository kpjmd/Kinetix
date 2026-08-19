// tests/verification-service.test.js
// Tests for verification scoring algorithms

jest.mock('../services/data-store');

const dataStore = require('../services/data-store');
const {
  VerificationService,
  deriveMinimumActions,
  resolveMinimumActions
} = require('../services/verification-service');

describe('VerificationService', () => {
  let service;

  beforeEach(() => {
    service = new VerificationService();
  });

  describe('_scoreConsistency', () => {
    it('should score perfect completion as verified', () => {
      const commitment = {
        criteria: {
          frequency: 'daily',
          minimum_actions: 7,
          grace_period_hours: 24
        }
      };
      const evidence = Array.from({ length: 7 }, (_, i) => ({
        timestamp: new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000).toISOString(),
        content_length: 150
      }));

      const result = service._scoreConsistency(commitment, evidence);
      expect(result.status).toBe('verified');
      expect(result.completion_rate).toBe(100);
      expect(result.overall_score).toBeGreaterThanOrEqual(70);
    });

    it('should score partial completion correctly', () => {
      const commitment = {
        criteria: {
          frequency: 'daily',
          minimum_actions: 7,
          grace_period_hours: 24
        }
      };
      const evidence = Array.from({ length: 3 }, (_, i) => ({
        timestamp: new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000).toISOString(),
        content_length: 150
      }));

      const result = service._scoreConsistency(commitment, evidence);
      expect(result.status).toBe('partial');
      expect(result.actions_completed).toBe(3);
      expect(result.actions_missed).toBe(4);
    });

    it('should score zero completion as failed', () => {
      const commitment = {
        criteria: {
          frequency: 'daily',
          minimum_actions: 7
        }
      };
      const result = service._scoreConsistency(commitment, []);
      expect(result.status).toBe('failed');
      expect(result.overall_score).toBe(0);
    });
  });

  describe('_scoreQuality', () => {
    it('should fail if insufficient samples', () => {
      const commitment = {
        criteria: {
          minimum_samples: 10,
          quality_metrics: { response_time_minutes: 30 }
        }
      };
      const evidence = Array.from({ length: 5 }, () => ({
        response_time_minutes: 20
      }));
      const result = service._scoreQuality(commitment, evidence);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Insufficient samples');
    });

    it('should score quality metrics correctly', () => {
      const commitment = {
        criteria: {
          minimum_samples: 5,
          quality_metrics: {
            response_time_minutes: 30,
            minimum_length: 100
          }
        }
      };
      const evidence = Array.from({ length: 10 }, () => ({
        response_time_minutes: 20,
        content_length: 150
      }));
      const result = service._scoreQuality(commitment, evidence);
      expect(result.status).toBe('verified');
      expect(result.overall_score).toBeGreaterThanOrEqual(70);
    });
  });

  describe('_scoreTimeBound', () => {
    it('should score on-time delivery as verified', () => {
      const commitment = {
        criteria: {
          milestones: [
            { milestone_id: 'm1', deadline: '2025-02-05T17:00:00Z' },
            { milestone_id: 'm2', deadline: '2025-02-10T17:00:00Z' }
          ],
          penalty_per_late_hour: 1
        }
      };
      const evidence = [
        { milestone_id: 'm1', timestamp: '2025-02-05T15:00:00Z' },
        { milestone_id: 'm2', timestamp: '2025-02-10T16:00:00Z' }
      ];
      const result = service._scoreTimeBound(commitment, evidence);
      expect(result.status).toBe('verified');
      expect(result.timeliness_score).toBeGreaterThan(100); // early bonus
    });

    it('should apply late penalties', () => {
      const commitment = {
        criteria: {
          milestones: [
            {
              milestone_id: 'm1',
              deadline: '2025-02-05T17:00:00Z',
              grace_period_hours: 0
            }
          ],
          penalty_per_late_hour: 2
        }
      };
      const evidence = [
        { milestone_id: 'm1', timestamp: '2025-02-06T17:00:00Z' } // 24 hours late
      ];
      const result = service._scoreTimeBound(commitment, evidence);
      expect(result.overall_score).toBeLessThan(70);
    });

    it('should score missed milestones as zero', () => {
      const commitment = {
        criteria: {
          milestones: [
            { milestone_id: 'm1', deadline: '2025-02-05T17:00:00Z' },
            { milestone_id: 'm2', deadline: '2025-02-10T17:00:00Z' }
          ],
          penalty_per_late_hour: 1
        }
      };
      const evidence = [
        { milestone_id: 'm1', timestamp: '2025-02-05T15:00:00Z' }
      ];
      const result = service._scoreTimeBound(commitment, evidence);
      expect(result.milestones_completed).toBe(1);
      expect(result.overall_score).toBeLessThan(70);
    });
  });

  describe('calculateDifficulty', () => {
    it('should classify short/simple as trivial', () => {
      const result = service.calculateDifficulty({
        criteria: { duration_days: 2 }
      });
      expect(result).toBe('trivial');
    });

    it('should classify weekly daily posting as standard', () => {
      const result = service.calculateDifficulty({
        criteria: { duration_days: 7, frequency: 'daily' }
      });
      expect(result).toBe('standard');
    });

    it('should classify long multi-metric as challenging/expert', () => {
      const result = service.calculateDifficulty({
        criteria: {
          duration_days: 30,
          frequency: 'daily',
          quality_metrics: { response_time: 30, accuracy: true }
        }
      });
      expect(['challenging', 'expert']).toContain(result);
    });
  });

  // minimum_actions is the completion-rate denominator and is not required by
  // any route's inputSchema, so scoring must never read it raw.
  describe('minimum_actions', () => {
    const evidenceFor = count =>
      Array.from({ length: count }, (_, i) => ({
        timestamp: new Date(Date.now() - (count - 1 - i) * 24 * 60 * 60 * 1000).toISOString(),
        content_length: 150
      }));

    it('derives a target from duration and frequency, not a bare 1', () => {
      expect(deriveMinimumActions({ duration_days: 7, frequency: 'daily' })).toBe(7);
      expect(deriveMinimumActions({ duration_days: 2, frequency: 'hourly' })).toBe(48);
      expect(deriveMinimumActions({ duration_days: 7, frequency: 'weekly' })).toBe(1);
    });

    it('never derives a zero or negative denominator', () => {
      expect(deriveMinimumActions({ duration_days: 0.1, frequency: 'weekly' })).toBe(1);
      expect(deriveMinimumActions({})).toBe(1);
      expect(resolveMinimumActions({ minimum_actions: 0, duration_days: 7, frequency: 'daily' })).toBe(7);
      expect(resolveMinimumActions({ minimum_actions: -5, duration_days: 7, frequency: 'daily' })).toBe(7);
    });

    it('scores a legacy commitment with no minimum_actions instead of NaN', () => {
      // Commitments created before the default exists carry no minimum_actions.
      // Reading it raw gave completed/undefined -> NaN -> _getStatus(NaN) ->
      // 'failed', serialized as null: a paid verification that collected real
      // evidence and reported nothing.
      const commitment = { criteria: { frequency: 'daily', duration_days: 7 } };

      const result = service._scoreConsistency(commitment, evidenceFor(7));

      expect(Number.isNaN(result.overall_score)).toBe(false);
      expect(result.completion_rate).toBe(100);
      expect(result.status).toBe('verified');
    });

    it('does not let minimum_actions: 0 buy a verified receipt', () => {
      // completed/0 is Infinity, which Math.min clamps to 100.
      const commitment = { criteria: { frequency: 'daily', duration_days: 7, minimum_actions: 0 } };

      const result = service._scoreConsistency(commitment, evidenceFor(1));

      expect(result.completion_rate).toBeLessThan(100);
      expect(result.status).not.toBe('verified');
    });

    it('states the target it scored against, in actions rather than days', () => {
      // These fields always counted evidence items. As days_completed they
      // produced `days_completed: 3` beside `duration_days: 1` in a signed
      // receipt, which reads as a contradiction to anyone auditing it.
      const result = service._scoreConsistency(
        { criteria: { frequency: 'daily', duration_days: 1, minimum_actions: 1 } },
        evidenceFor(3)
      );

      expect(result.actions_required).toBe(1);
      expect(result.actions_completed).toBe(3);
      expect(result).not.toHaveProperty('days_completed');
      expect(result).not.toHaveProperty('days_missed');
    });

    it('states the target even when nothing was collected', () => {
      const result = service._scoreConsistency(
        { criteria: { frequency: 'daily', duration_days: 7 } },
        []
      );
      expect(result.actions_required).toBe(7);
      expect(result.actions_completed).toBe(0);
    });

    it('never reports a negative actions_missed when the target is exceeded', () => {
      // Collection returns the whole window, so overshooting the target is
      // normal — and required - completed went negative in a signed receipt.
      const result = service._scoreConsistency(
        { criteria: { frequency: 'daily', duration_days: 3, minimum_actions: 3 } },
        evidenceFor(12)
      );
      expect(result.actions_missed).toBe(0);
      expect(result.completion_rate).toBe(100);
    });

    it('reports a numeric actions_missed when the commitment collected nothing', () => {
      const result = service._scoreConsistency(
        { criteria: { frequency: 'daily', duration_days: 7 } },
        []
      );
      expect(result.actions_missed).toBe(7);
    });

    it('rejects a non-positive minimum_actions at creation', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'consistency',
        criteria: { duration_days: 7, minimum_actions: 0 }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/minimum_actions/);
    });
  });

  // _scoreTimeBound/_scoreQuality read criteria.milestones/quality_metrics/
  // minimum_samples with no guard — these must be caught here, pre-payment,
  // or a paying buyer gets a post-payment scoring crash instead of a 400.
  describe('type-specific criteria validation', () => {
    it('rejects time_bound with no milestones', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'time_bound',
        criteria: { duration_days: 30 }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/milestones/);
    });

    it('rejects time_bound with an empty milestones array', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'time_bound',
        criteria: { milestones: [] }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/milestones/);
    });

    it('rejects a milestone missing milestone_id', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'time_bound',
        criteria: { milestones: [{ deadline: '2026-09-01T00:00:00Z' }] }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/milestone_id/);
    });

    it('rejects a milestone with an unparseable deadline', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'time_bound',
        criteria: { milestones: [{ milestone_id: 'm1', deadline: 'not-a-date' }] }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/deadline/);
    });

    it('accepts a valid time_bound commitment', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'time_bound',
        criteria: { milestones: [{ milestone_id: 'm1', deadline: '2026-09-01T00:00:00Z' }] }
      };
      expect(() => service._validateCommitment(commitment)).not.toThrow();
    });

    it('rejects quality with no quality_metrics', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'quality',
        criteria: { duration_days: 14, minimum_samples: 5 }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/quality_metrics/);
    });

    it('rejects quality with no minimum_samples', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'quality',
        criteria: { duration_days: 14, quality_metrics: { response_time_minutes: 30 } }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/minimum_samples/);
    });

    it('rejects a non-positive minimum_samples', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'quality',
        criteria: { duration_days: 14, quality_metrics: { response_time_minutes: 30 }, minimum_samples: 0 }
      };
      expect(() => service._validateCommitment(commitment)).toThrow(/minimum_samples/);
    });

    it('accepts a valid quality commitment', () => {
      const commitment = {
        agent_id: 'a', description: 'd', verification_type: 'quality',
        criteria: { duration_days: 14, quality_metrics: { response_time_minutes: 30 }, minimum_samples: 5 }
      };
      expect(() => service._validateCommitment(commitment)).not.toThrow();
    });
  });

  describe('_calculateTimeliness', () => {
    it('is unaffected by the order evidence was appended in', () => {
      // Each collection run re-queries the whole window and appends, so the
      // persisted array is not globally ordered. Out of order, a late post
      // yields a negative interval, which used to count as on-time.
      const commitment = { criteria: { frequency: 'daily', grace_period_hours: 0 } };
      const day = 24 * 60 * 60 * 1000;
      const base = Date.parse('2026-01-01T00:00:00Z');
      // The 4th item is 5 days after the 3rd: one genuinely missed deadline.
      const ordered = [0, 1, 2, 7].map(d => ({ timestamp: new Date(base + d * day).toISOString() }));

      const inOrder = service._calculateTimeliness(commitment, ordered);
      const shuffled = service._calculateTimeliness(commitment, [ordered[3], ordered[0], ordered[2], ordered[1]]);

      expect(inOrder).toBeCloseTo((2 / 3) * 100);
      expect(shuffled).toBe(inOrder);
    });

    it('does not mutate the caller evidence array', () => {
      const evidence = [
        { timestamp: '2026-01-03T00:00:00Z' },
        { timestamp: '2026-01-01T00:00:00Z' }
      ];
      service._calculateTimeliness({ criteria: { frequency: 'daily' } }, evidence);
      expect(evidence[0].timestamp).toBe('2026-01-03T00:00:00Z');
    });
  });

  // A relay outage produces the same empty evidence array as an inactive agent.
  // Scoring must be able to tell them apart, or a paid receipt says a customer
  // did nothing when in fact we could not look.
  describe('_collectionReadiness', () => {
    const hoursAgo = h => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

    it('scores immediately when nothing tracks collection for this commitment', () => {
      // The free API route and unsupported platforms never write a monitoring
      // block; waiting on one would strand them forever.
      expect(service._collectionReadiness({ end_date: hoursAgo(1) }).ready).toBe(true);
    });

    it('scores as soon as a collection succeeded after the window closed', () => {
      const readiness = service._collectionReadiness({
        end_date: hoursAgo(2),
        monitoring: { last_success_at: hoursAgo(1) }
      });
      expect(readiness).toEqual({ ready: true });
    });

    it('waits while collection keeps failing inside the grace window', () => {
      const readiness = service._collectionReadiness({
        end_date: hoursAgo(2),
        monitoring: { last_success_at: hoursAgo(5), consecutive_failures: 3 }
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toMatch(/3 consecutive failures/);
    });

    it('scores anyway once the grace window expires, flagged as degraded', () => {
      // The customer paid and is owed a receipt; it just has to be honest that
      // the evidence set may be incomplete.
      const readiness = service._collectionReadiness({
        end_date: hoursAgo(30),
        monitoring: { last_success_at: null, consecutive_failures: 9 }
      });
      expect(readiness.ready).toBe(true);
      expect(readiness.degraded).toBe(true);
    });
  });

  // The status route is unauthenticated and is what a buyer — or an OKX
  // reviewer — polls. A deferred commitment must not look like a hung one.
  describe('_collectionSummary', () => {
    const hoursAgo = h => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    const hoursAhead = h => new Date(Date.now() + h * 60 * 60 * 1000).toISOString();

    it('says nothing is monitoring when nothing is', () => {
      // The free API route creates commitments no collector ever touches.
      const summary = service._collectionSummary({ status: 'active', end_date: hoursAhead(1) });
      expect(summary).toEqual({ state: 'not_monitored' });
    });

    it('reports collecting while the window is still open', () => {
      const summary = service._collectionSummary({
        status: 'active',
        end_date: hoursAhead(5),
        monitoring: { last_success_at: hoursAgo(1), last_attempt_at: hoursAgo(1), consecutive_failures: 0 }
      });
      expect(summary.state).toBe('collecting');
      expect(summary.last_success_at).toEqual(expect.any(String));
    });

    it('explains a deferral, with the deadline, instead of just saying active', () => {
      const summary = service._collectionSummary({
        status: 'active',
        end_date: hoursAgo(2),
        monitoring: { last_success_at: hoursAgo(6), last_attempt_at: hoursAgo(0.1), consecutive_failures: 4 }
      });
      expect(summary.state).toBe('awaiting_collection');
      expect(summary.consecutive_failures).toBe(4);
      expect(Date.parse(summary.grace_expires_at)).toBeGreaterThan(Date.now());
    });

    it('reports complete once the commitment has been scored', () => {
      const summary = service._collectionSummary({
        status: 'verified',
        end_date: hoursAgo(2),
        monitoring: { last_success_at: hoursAgo(1), last_attempt_at: hoursAgo(1), consecutive_failures: 0 }
      });
      expect(summary.state).toBe('complete');
      expect(summary.grace_expires_at).toBeUndefined();
    });

    it('never exposes the raw collection error to an anonymous caller', () => {
      // It names relay hosts and failure modes; this route needs no auth.
      const summary = service._collectionSummary({
        status: 'active',
        end_date: hoursAgo(1),
        monitoring: {
          last_success_at: null,
          last_attempt_at: hoursAgo(0.1),
          consecutive_failures: 2,
          last_error: 'failed to connect to wss://relay.internal.example'
        }
      });
      expect(JSON.stringify(summary)).not.toMatch(/relay\.internal|wss:\/\//);
      expect(summary.last_error).toBeUndefined();
    });
  });

  describe('addEvidence', () => {
    const activeCommitment = () => ({
      commitment_id: 'cmt_kx_test',
      status: 'active',
      // Already expired: the window has closed but scoring has not run yet,
      // which is exactly the state the final collection tick sees.
      end_date: new Date(Date.now() - 1000).toISOString(),
      evidence: []
    });

    const item = id => ({ platform: 'clawstr', event_id: id, timestamp: new Date().toISOString(), signature: 'sig' });

    beforeEach(() => {
      jest.clearAllMocks();
      dataStore.saveCommitment.mockResolvedValue(undefined);
    });

    it('does not score an expired commitment while a batch is still landing', async () => {
      // Collectors add one item at a time. Scoring here fired on the first item
      // and signed a receipt over a 1-item evidence array while items 2..N were
      // still being appended, so the receipt disagreed with the stored file.
      const commitment = activeCommitment();
      dataStore.loadCommitment.mockResolvedValue(commitment);
      const scoreSpy = jest.spyOn(service, 'scoreVerification').mockResolvedValue(undefined);

      for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
        await service.addEvidence('cmt_kx_test', item(id));
      }

      expect(scoreSpy).not.toHaveBeenCalled();
      expect(commitment.evidence).toHaveLength(5);
    });

    it('refuses to append to a commitment that has already been scored', async () => {
      const commitment = { ...activeCommitment(), status: 'verified' };
      dataStore.loadCommitment.mockResolvedValue(commitment);

      await service.addEvidence('cmt_kx_test', item('e1'));

      expect(commitment.evidence).toHaveLength(0);
      expect(dataStore.saveCommitment).not.toHaveBeenCalled();
    });
  });
});
