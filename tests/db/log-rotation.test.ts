/**
 * Log rotation and cleanup tests (TD-007)
 */

import { describe, it, expect } from 'vitest';
import {
  createDefaultPolicy,
  shouldRotate,
  identifyExpiredRows,
  planRotation,
  buildDeleteQuery,
  buildArchiveQuery,
  createRotationSchedule,
  updateScheduleAfterRun,
  formatRotationReport,
  formatLogStats,
  estimateRowSize,
  createArchiveEntry,
  type LogStats,
  type RotationPolicy,
  type RotationResult,
  type RotationSchedule,
} from '../../src/db/log-rotation';

// ── Helpers ──────────────────────────────────────────

function makeStats(overrides?: Partial<LogStats>): LogStats {
  // Use dynamic timestamps so "within limits" stays within the 30-day
  // default policy regardless of when the test runs.
  const now = Date.now();
  return {
    totalRows: 50_000,
    oldestEntry: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    newestEntry: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    estimatedSizeMb: 100,
    agentBreakdown: { Scout: 20_000, Forge: 30_000 },
    ...overrides,
  };
}

function makeResult(overrides?: Partial<RotationResult>): RotationResult {
  return {
    deletedRows: 1000,
    archivedRows: 1000,
    freedSizeMb: 2.5,
    durationMs: 350,
    timestamp: '2026-04-11T12:00:00Z',
    ...overrides,
  };
}

// ── createDefaultPolicy ──────────────────────────────

describe('createDefaultPolicy', () => {
  it('returns sensible defaults', () => {
    const policy = createDefaultPolicy();
    expect(policy.maxAgeDays).toBe(30);
    expect(policy.maxRows).toBe(100_000);
    expect(policy.maxSizeMb).toBe(500);
    expect(policy.archiveBeforeDelete).toBe(true);
    expect(policy.compressArchive).toBe(false);
  });

  it('applies overrides immutably', () => {
    const policy = createDefaultPolicy({ maxAgeDays: 7, compressArchive: true });
    expect(policy.maxAgeDays).toBe(7);
    expect(policy.compressArchive).toBe(true);
    expect(policy.maxRows).toBe(100_000);
  });
});

// ── shouldRotate ─────────────────────────────────────

describe('shouldRotate', () => {
  const policy = createDefaultPolicy();

  it('returns not needed when within limits', () => {
    const result = shouldRotate(makeStats(), policy);
    expect(result.needed).toBe(false);
  });

  it.each([
    ['row count', makeStats({ totalRows: 200_000 })],
    ['size', makeStats({ estimatedSizeMb: 600 })],
  ])('detects threshold breach: %s', (_label, stats) => {
    const result = shouldRotate(stats, policy);
    expect(result.needed).toBe(true);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('detects age threshold breach', () => {
    const old = makeStats({ oldestEntry: '2025-01-01T00:00:00Z' });
    const result = shouldRotate(old, createDefaultPolicy({ maxAgeDays: 30 }));
    expect(result.needed).toBe(true);
  });
});

// ── identifyExpiredRows ──────────────────────────────

describe('identifyExpiredRows', () => {
  it('returns 0 when no entries', () => {
    const stats = makeStats({ totalRows: 0, oldestEntry: null });
    expect(identifyExpiredRows(stats, 30, '2026-04-11T00:00:00Z')).toBe(0);
  });

  it('estimates expired row count proportionally', () => {
    const stats = makeStats({
      totalRows: 1000,
      oldestEntry: '2026-03-01T00:00:00Z',
      newestEntry: '2026-04-10T00:00:00Z',
    });
    const expired = identifyExpiredRows(stats, 10, '2026-04-11T00:00:00Z');
    expect(expired).toBeGreaterThan(0);
    expect(expired).toBeLessThanOrEqual(1000);
  });

  it('returns 0 when nothing expired', () => {
    const stats = makeStats({
      totalRows: 100,
      oldestEntry: '2026-04-10T00:00:00Z',
      newestEntry: '2026-04-11T00:00:00Z',
    });
    expect(identifyExpiredRows(stats, 30, '2026-04-11T00:00:00Z')).toBe(0);
  });
});

// ── planRotation ─────────────────────────────────────

describe('planRotation', () => {
  it('plans archive when archiveBeforeDelete is true', () => {
    const policy = createDefaultPolicy({ maxAgeDays: 1 });
    const stats = makeStats();
    const plan = planRotation(stats, policy);
    expect(plan.archiveCount).toBe(plan.deleteCount);
  });

  it('skips archive when archiveBeforeDelete is false', () => {
    const policy = createDefaultPolicy({ archiveBeforeDelete: false, maxAgeDays: 1 });
    const plan = planRotation(makeStats(), policy);
    expect(plan.archiveCount).toBe(0);
  });
});

// ── SQL builders ─────────────────────────────────────

describe('buildDeleteQuery', () => {
  it('produces valid SQL with table name and age', () => {
    const sql = buildDeleteQuery('agent_logs', 30);
    expect(sql).toContain('DELETE FROM agent_logs');
    expect(sql).toContain('30 days');
  });
});

describe('buildArchiveQuery', () => {
  it('produces a SELECT query with date filter', () => {
    const sql = buildArchiveQuery('agent_logs', 7);
    expect(sql).toContain('SELECT * FROM agent_logs');
    expect(sql).toContain('7 days');
  });
});

// ── Schedule ─────────────────────────────────────────

describe('createRotationSchedule', () => {
  it('creates an enabled schedule with nextRun set', () => {
    const schedule = createRotationSchedule(createDefaultPolicy(), 24);
    expect(schedule.enabled).toBe(true);
    expect(schedule.intervalHours).toBe(24);
    expect(schedule.lastRun).toBeNull();
    expect(schedule.nextRun).not.toBeNull();
  });
});

describe('updateScheduleAfterRun', () => {
  it('updates lastRun and nextRun immutably', () => {
    const schedule = createRotationSchedule(createDefaultPolicy(), 12);
    const result = makeResult();
    const updated = updateScheduleAfterRun(schedule, result);
    expect(updated.lastRun).toBe(result.timestamp);
    expect(updated.nextRun).not.toBe(schedule.nextRun);
    expect(updated).not.toBe(schedule);
  });
});

// ── Formatters ───────────────────────────────────────

describe('formatRotationReport', () => {
  it('produces markdown with all metrics', () => {
    const report = formatRotationReport(makeResult());
    expect(report).toContain('## Log Rotation Report');
    expect(report).toContain('1,000');
    expect(report).toContain('2.50 MB');
  });
});

describe('formatLogStats', () => {
  it('produces markdown with agent breakdown', () => {
    const output = formatLogStats(makeStats());
    expect(output).toContain('## Agent Log Statistics');
    expect(output).toContain('Scout');
    expect(output).toContain('Forge');
  });
});

// ── Utility functions ────────────────────────────────

describe('estimateRowSize', () => {
  it.each([
    [0, 100, 0],
    [1000, 10, 10.24],
  ])('rows=%i sizeMb=%i => %f KB', (rows, mb, expected) => {
    expect(estimateRowSize(rows, mb)).toBeCloseTo(expected, 1);
  });
});

describe('createArchiveEntry', () => {
  it('returns a valid archive entry', () => {
    const entry = createArchiveEntry(
      'arc-001',
      500,
      { start: '2026-03-01', end: '2026-03-15' },
      1024000,
    );
    expect(entry.archiveId).toBe('arc-001');
    expect(entry.rowCount).toBe(500);
    expect(entry.sizeBytes).toBe(1024000);
    expect(entry.createdAt).toBeTruthy();
  });
});
