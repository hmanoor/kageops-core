/**
 * KageOps Agent Log Rotation and Cleanup (TD-007)
 *
 * Pure functions for managing agent_logs table size via
 * time-based expiry, row-count limits, and size thresholds.
 */

// ── Types ────────────────────────────────────────────

export interface RotationPolicy {
  readonly maxAgeDays: number;
  readonly maxRows: number;
  readonly maxSizeMb: number;
  readonly archiveBeforeDelete: boolean;
  readonly compressArchive: boolean;
}

export interface RotationResult {
  readonly deletedRows: number;
  readonly archivedRows: number;
  readonly freedSizeMb: number;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface LogStats {
  readonly totalRows: number;
  readonly oldestEntry: string | null;
  readonly newestEntry: string | null;
  readonly estimatedSizeMb: number;
  readonly agentBreakdown: Readonly<Record<string, number>>;
}

export interface RotationSchedule {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly lastRun: string | null;
  readonly nextRun: string | null;
  readonly policy: RotationPolicy;
}

export interface ArchiveEntry {
  readonly archiveId: string;
  readonly rowCount: number;
  readonly dateRange: { readonly start: string; readonly end: string };
  readonly createdAt: string;
  readonly sizeBytes: number;
}

// ── Constants ────────────────────────────────────────

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_SIZE_MB = 500;
const ESTIMATED_ROW_SIZE_KB = 2;

// ── Functions ────────────────────────────────────────

export function createDefaultPolicy(
  overrides?: Partial<RotationPolicy>,
): RotationPolicy {
  return {
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    maxRows: DEFAULT_MAX_ROWS,
    maxSizeMb: DEFAULT_MAX_SIZE_MB,
    archiveBeforeDelete: true,
    compressArchive: false,
    ...overrides,
  };
}

export function shouldRotate(
  stats: LogStats,
  policy: RotationPolicy,
): { readonly needed: boolean; readonly reason: string } {
  if (stats.totalRows >= policy.maxRows) {
    return { needed: true, reason: `Row count ${stats.totalRows} exceeds limit ${policy.maxRows}` };
  }
  if (stats.estimatedSizeMb >= policy.maxSizeMb) {
    return { needed: true, reason: `Size ${stats.estimatedSizeMb}MB exceeds limit ${policy.maxSizeMb}MB` };
  }
  if (stats.oldestEntry !== null) {
    const ageMs = new Date().getTime() - new Date(stats.oldestEntry).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > policy.maxAgeDays) {
      return { needed: true, reason: `Oldest entry is ${Math.round(ageDays)} days old, exceeds ${policy.maxAgeDays} day limit` };
    }
  }
  return { needed: false, reason: 'All thresholds within limits' };
}

export function identifyExpiredRows(
  stats: LogStats,
  maxAgeDays: number,
  now: string,
): number {
  if (stats.oldestEntry === null || stats.totalRows === 0) {
    return 0;
  }
  const nowMs = new Date(now).getTime();
  const oldestMs = new Date(stats.oldestEntry).getTime();
  const newestMs = stats.newestEntry
    ? new Date(stats.newestEntry).getTime()
    : nowMs;
  const totalSpanMs = newestMs - oldestMs;
  if (totalSpanMs <= 0) {
    return 0;
  }
  const cutoffMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const expiredSpanMs = cutoffMs - oldestMs;
  if (expiredSpanMs <= 0) {
    return 0;
  }
  const fraction = Math.min(expiredSpanMs / totalSpanMs, 1);
  return Math.round(stats.totalRows * fraction);
}

export function planRotation(
  stats: LogStats,
  policy: RotationPolicy,
): {
  readonly deleteCount: number;
  readonly archiveCount: number;
  readonly estimatedFreedMb: number;
} {
  const now = new Date().toISOString();
  const expiredRows = identifyExpiredRows(stats, policy.maxAgeDays, now);
  const excessRows = Math.max(0, stats.totalRows - policy.maxRows);
  const deleteCount = Math.max(expiredRows, excessRows);
  const archiveCount = policy.archiveBeforeDelete ? deleteCount : 0;
  const estimatedFreedMb = (deleteCount * ESTIMATED_ROW_SIZE_KB) / 1024;
  return { deleteCount, archiveCount, estimatedFreedMb };
}

export function buildDeleteQuery(
  tableName: string,
  maxAgeDays: number,
): string {
  return `DELETE FROM ${tableName} WHERE created_at < NOW() - INTERVAL '${maxAgeDays} days'`;
}

export function buildArchiveQuery(
  tableName: string,
  maxAgeDays: number,
): string {
  return `SELECT * FROM ${tableName} WHERE created_at < NOW() - INTERVAL '${maxAgeDays} days' ORDER BY created_at ASC`;
}

export function createRotationSchedule(
  policy: RotationPolicy,
  intervalHours: number,
): RotationSchedule {
  const now = new Date();
  const nextRun = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
  return {
    enabled: true,
    intervalHours,
    lastRun: null,
    nextRun: nextRun.toISOString(),
    policy,
  };
}

export function updateScheduleAfterRun(
  schedule: RotationSchedule,
  result: RotationResult,
): RotationSchedule {
  const lastRun = result.timestamp;
  const nextRun = new Date(
    new Date(lastRun).getTime() + schedule.intervalHours * 60 * 60 * 1000,
  ).toISOString();
  return {
    ...schedule,
    lastRun,
    nextRun,
  };
}

export function formatRotationReport(result: RotationResult): string {
  const lines = [
    '## Log Rotation Report',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Deleted rows | ${result.deletedRows.toLocaleString()} |`,
    `| Archived rows | ${result.archivedRows.toLocaleString()} |`,
    `| Freed space | ${result.freedSizeMb.toFixed(2)} MB |`,
    `| Duration | ${result.durationMs} ms |`,
    `| Timestamp | ${result.timestamp} |`,
  ];
  return lines.join('\n');
}

export function formatLogStats(stats: LogStats): string {
  const breakdownLines = Object.entries(stats.agentBreakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([agent, count]) => `| ${agent} | ${count.toLocaleString()} |`);

  const lines = [
    '## Agent Log Statistics',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total rows | ${stats.totalRows.toLocaleString()} |`,
    `| Oldest entry | ${stats.oldestEntry ?? 'N/A'} |`,
    `| Newest entry | ${stats.newestEntry ?? 'N/A'} |`,
    `| Estimated size | ${stats.estimatedSizeMb.toFixed(2)} MB |`,
    '',
    '### Agent Breakdown',
    '',
    '| Agent | Rows |',
    '|-------|------|',
    ...breakdownLines,
  ];
  return lines.join('\n');
}

export function estimateRowSize(totalRows: number, sizeMb: number): number {
  if (totalRows === 0) return 0;
  return (sizeMb * 1024) / totalRows;
}

export function createArchiveEntry(
  archiveId: string,
  rowCount: number,
  dateRange: { readonly start: string; readonly end: string },
  sizeBytes: number,
): ArchiveEntry {
  return {
    archiveId,
    rowCount,
    dateRange,
    createdAt: new Date().toISOString(),
    sizeBytes,
  };
}
