// tests/verification-service.test.js
// Tests for verification scoring algorithms

const { VerificationService } = require('../services/verification-service');

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
      expect(result.days_completed).toBe(3);
      expect(result.days_missed).toBe(4);
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
});
