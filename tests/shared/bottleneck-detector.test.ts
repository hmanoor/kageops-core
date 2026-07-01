import { describe, it, expect } from 'vitest';
import {
  findCriticalPath,
  findBlockingDependencies,
  findIdleGaps,
  findSlowOperations,
  findResourceContention,
  analyzeBottlenecks,
  calculateEfficiency,
  formatBottleneckReport,
  type TimelineEntry,
} from '../../src/shared/bottleneck-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(
  id: string,
  label: string,
  startTime: number,
  durationMs: number,
  dependsOn: readonly string[] = [],
  parentId: string | null = null
): TimelineEntry {
  return {
    id,
    label,
    startTime,
    endTime: startTime + durationMs,
    durationMs,
    parentId,
    dependsOn,
  };
}

// ---------------------------------------------------------------------------
// findCriticalPath
// ---------------------------------------------------------------------------

describe('findCriticalPath', () => {
  it('returns longest dependency chain', () => {
    // A(100ms) -> B(200ms) -> C(300ms) is the critical path (longest)
    // D(50ms) is independent (shorter)
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 100, 200, ['A']),
      entry('C', 'Task C', 300, 300, ['B']),
      entry('D', 'Task D', 0, 50),
    ];

    const path = findCriticalPath(entries);
    expect(path).toContain('A');
    expect(path).toContain('B');
    expect(path).toContain('C');
    // The path should end with C (longest chain)
    expect(path[path.length - 1]).toBe('C');
  });

  it('handles entries with no dependencies', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 1000),
      entry('B', 'Task B', 0, 500),
      entry('C', 'Task C', 0, 200),
    ];

    const path = findCriticalPath(entries);
    // Critical path should be the longest — A (1000ms)
    expect(path).toContain('A');
    expect(path.length).toBeGreaterThanOrEqual(1);
  });

  it('handles single entry', () => {
    const entries: readonly TimelineEntry[] = [entry('A', 'Task A', 0, 500)];
    const path = findCriticalPath(entries);
    expect(path).toEqual(['A']);
  });
});

// ---------------------------------------------------------------------------
// findBlockingDependencies
// ---------------------------------------------------------------------------

describe('findBlockingDependencies', () => {
  it('identifies entries that block multiple downstream tasks', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Setup', 0, 2000),
      entry('B', 'Task B', 2000, 500, ['A']),
      entry('C', 'Task C', 2000, 300, ['A']),
      entry('D', 'Task D', 2000, 400, ['A']),
    ];

    const findings = findBlockingDependencies(entries);
    expect(findings.length).toBeGreaterThan(0);
    const blocker = findings.find((f) => f.affectedEntries.includes('A'));
    expect(blocker).toBeDefined();
    expect(blocker!.type).toBe('blocking-dependency');
  });

  it('returns empty array for fully independent entries', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 0, 200),
    ];

    const findings = findBlockingDependencies(entries);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findIdleGaps
// ---------------------------------------------------------------------------

describe('findIdleGaps', () => {
  it('detects gaps larger than 500ms', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 2000, 100), // 1900ms gap after A
    ];

    const findings = findIdleGaps(entries);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.type).toBe('idle-gap');
    expect(findings[0]!.impactMs).toBe(1900);
  });

  it('ignores small gaps under 500ms', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 200, 100), // 100ms gap — too small
    ];

    const findings = findIdleGaps(entries);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findSlowOperations
// ---------------------------------------------------------------------------

describe('findSlowOperations', () => {
  it('flags entries above threshold', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Fast', 0, 100),
      entry('B', 'Slow', 0, 8000),
    ];

    const findings = findSlowOperations(entries, 5000);
    expect(findings.length).toBe(1);
    expect(findings[0]!.affectedEntries).toContain('B');
  });

  it('assigns correct severity based on duration', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Very slow', 0, 12000),  // >10s → high
      entry('B', 'Slow', 0, 7000),        // >5s → medium
      entry('C', 'Borderline', 0, 3500),  // >3s, at default threshold 5000 → skip
    ];

    const findings = findSlowOperations(entries, 5000);
    const high = findings.find((f) => f.affectedEntries.includes('A'));
    const medium = findings.find((f) => f.affectedEntries.includes('B'));

    expect(high!.severity).toBe('high');
    expect(medium!.severity).toBe('medium');
    // C is below 5000ms threshold so should not appear
    expect(findings.find((f) => f.affectedEntries.includes('C'))).toBeUndefined();
  });

  it('uses default threshold of 5000ms', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Above default', 0, 6000),
      entry('B', 'Below default', 0, 4000),
    ];

    const findings = findSlowOperations(entries);
    expect(findings.length).toBe(1);
    expect(findings[0]!.affectedEntries).toContain('A');
  });
});

// ---------------------------------------------------------------------------
// findResourceContention
// ---------------------------------------------------------------------------

describe('findResourceContention', () => {
  it('detects periods where too many operations overlap', () => {
    // 4 operations all overlap at t=0..100, max concurrency = 3
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Op A', 0, 1000),
      entry('B', 'Op B', 0, 1000),
      entry('C', 'Op C', 0, 1000),
      entry('D', 'Op D', 0, 1000),
    ];

    const findings = findResourceContention(entries, 3);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.type).toBe('resource-contention');
  });

  it('does not flag concurrency at or below the max', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Op A', 0, 500),
      entry('B', 'Op B', 0, 500),
      entry('C', 'Op C', 0, 500),
    ];

    const findings = findResourceContention(entries, 3);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeBottlenecks
// ---------------------------------------------------------------------------

describe('analyzeBottlenecks', () => {
  it('combines findings from all detectors', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Setup', 0, 3000),
      entry('B', 'Task B', 3000, 6000, ['A']), // slow (>5s)
      entry('C', 'Task C', 3000, 400, ['A']),
      entry('D', 'Task D', 4000, 400, ['A']),   // gap between C end and D start
    ];

    const analysis = analyzeBottlenecks(entries, { slowThresholdMs: 5000 });
    expect(analysis.findings.length).toBeGreaterThan(0);
    expect(analysis.criticalPath.length).toBeGreaterThan(0);
  });

  it('calculates efficiency correctly', () => {
    // Two sequential tasks with no gaps
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 500),
      entry('B', 'Task B', 500, 500),
    ];

    const analysis = analyzeBottlenecks(entries);
    // totalActive = 1000ms, wallTime = 1000ms → efficiency ~1.0
    expect(analysis.efficiency).toBeCloseTo(1.0, 1);
  });

  it('returns zero efficiency for empty input', () => {
    const analysis = analyzeBottlenecks([]);
    expect(analysis.efficiency).toBe(0);
    expect(analysis.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// calculateEfficiency
// ---------------------------------------------------------------------------

describe('calculateEfficiency', () => {
  it('returns 1.0 when there are no gaps (sequential with no overlap)', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 300),
      entry('B', 'Task B', 300, 300),
      entry('C', 'Task C', 600, 400),
    ];

    const eff = calculateEfficiency(entries);
    expect(eff).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for empty input', () => {
    expect(calculateEfficiency([])).toBe(0);
  });

  it('caps at 1.0 for overlapping tasks', () => {
    // Two tasks run at same time — sum of durations > wall time
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 1000),
      entry('B', 'Task B', 0, 1000),
    ];

    const eff = calculateEfficiency(entries);
    expect(eff).toBeLessThanOrEqual(1.0);
    expect(eff).toBeGreaterThan(0);
  });

  it('returns value < 1 when idle gaps exist', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 1000, 100), // 900ms idle
    ];

    const eff = calculateEfficiency(entries);
    expect(eff).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// formatBottleneckReport
// ---------------------------------------------------------------------------

describe('formatBottleneckReport', () => {
  it('includes critical path section', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 100, 6000, ['A']),
    ];

    const analysis = analyzeBottlenecks(entries, { slowThresholdMs: 5000 });
    const report = formatBottleneckReport(analysis);

    expect(report).toContain('Critical Path');
    expect(report).toContain('A');
    expect(report).toContain('B');
  });

  it('includes summary stats', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 500),
      entry('B', 'Task B', 500, 500),
    ];

    const analysis = analyzeBottlenecks(entries);
    const report = formatBottleneckReport(analysis);

    expect(report).toContain('Efficiency');
    expect(report).toContain('Summary');
  });

  it('shows "no bottlenecks" message for clean pipelines', () => {
    const entries: readonly TimelineEntry[] = [
      entry('A', 'Task A', 0, 100),
      entry('B', 'Task B', 100, 100),
    ];

    const analysis = analyzeBottlenecks(entries);
    const report = formatBottleneckReport(analysis);

    expect(report).toContain('No bottlenecks');
  });
});
