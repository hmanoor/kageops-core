export type BottleneckType =
  | 'critical-path'
  | 'blocking-dependency'
  | 'resource-contention'
  | 'slow-operation'
  | 'idle-gap';

export interface BottleneckFinding {
  readonly type: BottleneckType;
  readonly severity: 'high' | 'medium' | 'low';
  readonly description: string;
  readonly affectedEntries: readonly string[];
  readonly impactMs: number;
  readonly suggestion: string;
}

export interface TimelineEntry {
  readonly id: string;
  readonly label: string;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly parentId: string | null;
  readonly dependsOn: readonly string[];
}

export interface BottleneckAnalysis {
  readonly findings: readonly BottleneckFinding[];
  readonly criticalPath: readonly string[];
  readonly totalIdleMs: number;
  readonly totalBlockedMs: number;
  readonly efficiency: number;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function completedEntries(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  return entries.filter((e) => e.durationMs !== null && e.endTime !== null);
}

function buildIndexMap(entries: readonly TimelineEntry[]): Map<string, TimelineEntry> {
  const map = new Map<string, TimelineEntry>();
  for (const e of entries) {
    map.set(e.id, e);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1. findCriticalPath
// ---------------------------------------------------------------------------

export function findCriticalPath(entries: readonly TimelineEntry[]): readonly string[] {
  if (entries.length === 0) return [];

  const index = buildIndexMap(entries);

  // longest path (in ms) to reach end of each node
  const longestEnd = new Map<string, number>();

  // topological sort via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // who depends on me

  for (const e of entries) {
    if (!inDegree.has(e.id)) inDegree.set(e.id, 0);
    if (!dependents.has(e.id)) dependents.set(e.id, []);
    for (const dep of e.dependsOn) {
      inDegree.set(e.id, (inDegree.get(e.id) ?? 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(e.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const predecessor = new Map<string, string | null>();
  for (const e of entries) predecessor.set(e.id, null);

  const topo: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topo.push(cur);
    for (const next of dependents.get(cur) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }

  // If not all entries reachable (cycle), append remaining
  const visited = new Set(topo);
  for (const e of entries) {
    if (!visited.has(e.id)) topo.push(e.id);
  }

  // DP: longest end time through dependency chain
  for (const id of topo) {
    const entry = index.get(id);
    if (!entry) continue;
    const dur = entry.durationMs ?? 0;
    let best = entry.startTime + dur;
    for (const dep of entry.dependsOn) {
      const depEnd = longestEnd.get(dep) ?? 0;
      const candidate = depEnd + dur;
      if (candidate > best) best = candidate;
    }
    longestEnd.set(id, best);
  }

  // Find the node with the highest longestEnd
  let maxEnd = -Infinity;
  let tail: string | null = null;
  for (const [id, end] of longestEnd) {
    if (end > maxEnd) {
      maxEnd = end;
      tail = id;
    }
  }

  if (tail === null) return [];

  // Reconstruct path by backtracking through dependencies
  // Pick the dependency whose longestEnd is the biggest (greedy)
  const path: string[] = [];
  let cur: string | null = tail;
  const seen = new Set<string>();

  while (cur !== null) {
    if (seen.has(cur)) break;
    seen.add(cur);
    path.unshift(cur);
    const entry = index.get(cur);
    if (!entry || entry.dependsOn.length === 0) break;
    let bestDep: string | null = null;
    let bestDepEnd = -Infinity;
    for (const dep of entry.dependsOn) {
      const depEnd = longestEnd.get(dep) ?? 0;
      if (depEnd > bestDepEnd) {
        bestDepEnd = depEnd;
        bestDep = dep;
      }
    }
    cur = bestDep;
  }

  return path;
}

// ---------------------------------------------------------------------------
// 2. findBlockingDependencies
// ---------------------------------------------------------------------------

export function findBlockingDependencies(
  entries: readonly TimelineEntry[]
): readonly BottleneckFinding[] {
  if (entries.length === 0) return [];

  const index = buildIndexMap(entries);

  // Count how many entries depend on each entry
  const blockedBy = new Map<string, string[]>(); // blocker -> [dependents]

  for (const e of entries) {
    for (const dep of e.dependsOn) {
      if (!blockedBy.has(dep)) blockedBy.set(dep, []);
      blockedBy.get(dep)!.push(e.id);
    }
  }

  const findings: BottleneckFinding[] = [];

  for (const [blockerId, dependentIds] of blockedBy) {
    if (dependentIds.length < 2) continue;

    const blocker = index.get(blockerId);
    if (!blocker) continue;

    const blockerEnd = blocker.endTime ?? blocker.startTime + (blocker.durationMs ?? 0);

    // Total wait: sum of (blocker end - dependent start) where blocker ends after dependent starts
    let totalWait = 0;
    for (const depId of dependentIds) {
      const dep = index.get(depId);
      if (!dep) continue;
      const wait = blockerEnd - dep.startTime;
      if (wait > 0) totalWait += wait;
    }

    const severity = dependentIds.length >= 4 ? 'high' : dependentIds.length >= 3 ? 'medium' : 'low';

    findings.push({
      type: 'blocking-dependency',
      severity,
      description: `"${blocker.label}" blocks ${dependentIds.length} downstream tasks`,
      affectedEntries: [blockerId, ...dependentIds],
      impactMs: totalWait,
      suggestion: `Optimize or parallelize "${blocker.label}" to unblock ${dependentIds.length} dependent tasks`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 3. findIdleGaps
// ---------------------------------------------------------------------------

const IDLE_GAP_THRESHOLD_MS = 500;

export function findIdleGaps(entries: readonly TimelineEntry[]): readonly BottleneckFinding[] {
  const done = completedEntries(entries);
  if (done.length < 2) return [];

  // Sort by startTime
  const sorted = [...done].sort((a, b) => a.startTime - b.startTime);

  const findings: BottleneckFinding[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const prevEnd = prev.endTime!;
    const gap = cur.startTime - prevEnd;

    if (gap > IDLE_GAP_THRESHOLD_MS) {
      const severity = gap > 5000 ? 'high' : gap > 2000 ? 'medium' : 'low';
      findings.push({
        type: 'idle-gap',
        severity,
        description: `Idle gap of ${gap}ms between "${prev.label}" and "${cur.label}"`,
        affectedEntries: [prev.id, cur.id],
        impactMs: gap,
        suggestion: 'Consider pipelining tasks or starting the next task earlier to reduce idle time',
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 4. findSlowOperations
// ---------------------------------------------------------------------------

const DEFAULT_SLOW_THRESHOLD_MS = 5000;

export function findSlowOperations(
  entries: readonly TimelineEntry[],
  thresholdMs: number = DEFAULT_SLOW_THRESHOLD_MS
): readonly BottleneckFinding[] {
  const findings: BottleneckFinding[] = [];

  for (const e of entries) {
    const dur = e.durationMs;
    if (dur === null) continue;
    if (dur < thresholdMs) continue;

    const severity = dur > 10000 ? 'high' : dur > 5000 ? 'medium' : 'low';

    findings.push({
      type: 'slow-operation',
      severity,
      description: `"${e.label}" took ${dur}ms (threshold: ${thresholdMs}ms)`,
      affectedEntries: [e.id],
      impactMs: dur - thresholdMs,
      suggestion: `Profile and optimize "${e.label}" — consider caching, batching, or parallelization`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 5. findResourceContention
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 3;

export function findResourceContention(
  entries: readonly TimelineEntry[],
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY
): readonly BottleneckFinding[] {
  const done = completedEntries(entries);
  if (done.length === 0) return [];

  // Collect all start/end events
  type Event = { readonly time: number; readonly id: string; readonly type: 'start' | 'end' };
  const events: Event[] = [];

  for (const e of done) {
    events.push({ time: e.startTime, id: e.id, type: 'start' });
    events.push({ time: e.endTime!, id: e.id, type: 'end' });
  }

  events.sort((a, b) => a.time - b.time || (a.type === 'end' ? -1 : 1));

  const findings: BottleneckFinding[] = [];
  const active = new Set<string>();
  let contentionStart = 0;
  let inContention = false;
  let contentionIds: string[] = [];

  for (const ev of events) {
    if (ev.type === 'start') {
      active.add(ev.id);
      if (active.size > maxConcurrency && !inContention) {
        inContention = true;
        contentionStart = ev.time;
        contentionIds = [...active];
      }
    } else {
      if (inContention && active.size > maxConcurrency) {
        // still in contention, update list
        contentionIds = [...active];
      }
      if (inContention && active.size <= maxConcurrency) {
        const duration = ev.time - contentionStart;
        const severity = active.size + 1 > maxConcurrency + 2 ? 'high' : 'medium';
        findings.push({
          type: 'resource-contention',
          severity,
          description: `${contentionIds.length} operations ran concurrently (max: ${maxConcurrency}) for ${duration}ms`,
          affectedEntries: contentionIds,
          impactMs: duration,
          suggestion: `Limit concurrency to ${maxConcurrency} to avoid resource contention`,
        });
        inContention = false;
        contentionIds = [];
      }
      active.delete(ev.id);
    }
  }

  // Close any open contention period
  if (inContention && contentionIds.length > 0) {
    const lastTime = events[events.length - 1]?.time ?? contentionStart;
    const duration = lastTime - contentionStart;
    findings.push({
      type: 'resource-contention',
      severity: 'medium',
      description: `${contentionIds.length} operations ran concurrently (max: ${maxConcurrency}) for ${duration}ms`,
      affectedEntries: contentionIds,
      impactMs: duration,
      suggestion: `Limit concurrency to ${maxConcurrency} to avoid resource contention`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 6. calculateEfficiency
// ---------------------------------------------------------------------------

export function calculateEfficiency(entries: readonly TimelineEntry[]): number {
  const done = completedEntries(entries);
  if (done.length === 0) return 0;

  const totalActive = done.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  const minStart = Math.min(...done.map((e) => e.startTime));
  const maxEnd = Math.max(...done.map((e) => e.endTime!));
  const wallTime = maxEnd - minStart;

  if (wallTime <= 0) return 0;

  return Math.min(1, totalActive / wallTime);
}

// ---------------------------------------------------------------------------
// 7. analyzeBottlenecks
// ---------------------------------------------------------------------------

export function analyzeBottlenecks(
  entries: readonly TimelineEntry[],
  options?: { slowThresholdMs?: number; maxConcurrency?: number }
): BottleneckAnalysis {
  const slowThreshold = options?.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  const criticalPath = findCriticalPath(entries);

  const blocking = findBlockingDependencies(entries);
  const gaps = findIdleGaps(entries);
  const slow = findSlowOperations(entries, slowThreshold);
  const contention = findResourceContention(entries, maxConcurrency);

  const findings: readonly BottleneckFinding[] = [...blocking, ...gaps, ...slow, ...contention];

  const totalIdleMs = gaps.reduce((s, f) => s + f.impactMs, 0);
  const totalBlockedMs = blocking.reduce((s, f) => s + f.impactMs, 0);
  const efficiency = calculateEfficiency(entries);

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const medCount = findings.filter((f) => f.severity === 'medium').length;

  const summary =
    findings.length === 0
      ? 'No bottlenecks detected. Pipeline looks healthy.'
      : `Found ${findings.length} bottleneck(s): ${highCount} high, ${medCount} medium severity. ` +
        `Efficiency: ${(efficiency * 100).toFixed(1)}%. ` +
        `Total idle: ${totalIdleMs}ms, blocked: ${totalBlockedMs}ms.`;

  return {
    findings,
    criticalPath,
    totalIdleMs,
    totalBlockedMs,
    efficiency,
    summary,
  };
}

// ---------------------------------------------------------------------------
// 8. formatBottleneckReport
// ---------------------------------------------------------------------------

export function formatBottleneckReport(analysis: BottleneckAnalysis): string {
  const lines: string[] = [];

  lines.push('# Bottleneck Analysis Report');
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(analysis.summary);
  lines.push('');
  lines.push(`- **Efficiency**: ${(analysis.efficiency * 100).toFixed(1)}%`);
  lines.push(`- **Total Idle Time**: ${analysis.totalIdleMs}ms`);
  lines.push(`- **Total Blocked Time**: ${analysis.totalBlockedMs}ms`);
  lines.push(`- **Findings**: ${analysis.findings.length}`);
  lines.push('');

  // Critical path
  lines.push('## Critical Path');
  lines.push('');
  if (analysis.criticalPath.length === 0) {
    lines.push('_No critical path identified._');
  } else {
    lines.push(analysis.criticalPath.join(' → '));
  }
  lines.push('');

  // Group findings by type
  const types: BottleneckType[] = [
    'blocking-dependency',
    'slow-operation',
    'idle-gap',
    'resource-contention',
    'critical-path',
  ];

  const typeLabels: Record<BottleneckType, string> = {
    'blocking-dependency': 'Blocking Dependencies',
    'slow-operation': 'Slow Operations',
    'idle-gap': 'Idle Gaps',
    'resource-contention': 'Resource Contention',
    'critical-path': 'Critical Path Issues',
  };

  for (const type of types) {
    const group = analysis.findings.filter((f) => f.type === type);
    if (group.length === 0) continue;

    lines.push(`## ${typeLabels[type]}`);
    lines.push('');

    for (const f of group) {
      const severityIcon = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢';
      lines.push(`### ${severityIcon} [${f.severity.toUpperCase()}] ${f.description}`);
      lines.push('');
      lines.push(`- **Impact**: ${f.impactMs}ms`);
      lines.push(`- **Affected**: ${f.affectedEntries.join(', ')}`);
      lines.push(`- **Suggestion**: ${f.suggestion}`);
      lines.push('');
    }
  }

  if (analysis.findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('_No bottlenecks detected._');
    lines.push('');
  }

  return lines.join('\n');
}
