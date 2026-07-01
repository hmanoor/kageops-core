/**
 * B-110: Waterfall Timeline Panel (Gantt-style)
 *
 * Data model + HTML/CSS renderer for parallel/sequential agent work visualization.
 * Uses vanilla HTML string rendering (no React).
 */

import { RUN_TYPE_REGISTRY } from '../../shared/run-types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TimelineEntry {
  readonly id: string;
  readonly label: string;
  readonly lane: number;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly status: 'running' | 'completed' | 'failed' | 'blocked';
  readonly runType: string;
  readonly parentId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface WaterfallViewModel {
  readonly entries: readonly TimelineEntry[];
  readonly lanes: readonly string[];
  readonly timeRange: { readonly start: number; readonly end: number };
  readonly totalDuration: number;
  readonly maxConcurrency: number;
}

export interface WaterfallRenderOptions {
  readonly pixelsPerSecond: number;
  readonly laneHeight: number;
  readonly showLabels: boolean;
  readonly showDuration: boolean;
  readonly colorByStatus: boolean;
  readonly minBarWidth: number;
}

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_WATERFALL_OPTIONS: WaterfallRenderOptions = {
  pixelsPerSecond: 100,
  laneHeight: 40,
  showLabels: true,
  showDuration: true,
  colorByStatus: true,
  minBarWidth: 4,
};

// ── Lane Assignment ────────────────────────────────────────────────────────

/**
 * Assigns lane numbers to entries using a greedy overlap-detection algorithm.
 * Entries are sorted by startTime. Each entry is placed on the lowest lane
 * where it does not overlap any already-placed entry.
 */
export function assignLanes(
  entries: readonly Omit<TimelineEntry, 'lane'>[],
): readonly TimelineEntry[] {
  const sorted = [...entries].sort((a, b) => a.startTime - b.startTime);

  // Track end time of the last entry placed on each lane
  const laneEndTimes: number[] = [];

  return sorted.map((entry) => {
    const effectiveEnd = entry.endTime ?? entry.startTime + (entry.durationMs ?? 0);

    // Find lowest lane with no overlap
    let assignedLane = -1;
    for (let i = 0; i < laneEndTimes.length; i++) {
      if (laneEndTimes[i] <= entry.startTime) {
        assignedLane = i;
        break;
      }
    }

    // No free lane found — open a new one
    if (assignedLane === -1) {
      assignedLane = laneEndTimes.length;
      laneEndTimes.push(effectiveEnd);
    } else {
      laneEndTimes[assignedLane] = effectiveEnd;
    }

    return { ...entry, lane: assignedLane };
  });
}

// ── View Model ─────────────────────────────────────────────────────────────

/**
 * Calculates time range, lane labels, total duration, and max concurrency
 * from a set of TimelineEntries.
 */
export function buildWaterfallViewModel(
  entries: readonly TimelineEntry[],
): WaterfallViewModel {
  if (entries.length === 0) {
    return {
      entries,
      lanes: [],
      timeRange: { start: 0, end: 0 },
      totalDuration: 0,
      maxConcurrency: 0,
    };
  }

  const start = Math.min(...entries.map((e) => e.startTime));
  const end = Math.max(
    ...entries.map((e) => e.endTime ?? e.startTime + (e.durationMs ?? 0)),
  );

  const maxLane = Math.max(...entries.map((e) => e.lane));
  const laneCount = maxLane + 1;

  // Build lane labels — use the label of the first entry on each lane
  const laneLabels: string[] = Array.from({ length: laneCount }, (_, i) => {
    const first = entries.find((e) => e.lane === i);
    return first?.label ?? `Lane ${i}`;
  });

  // Max concurrency: peak number of lanes simultaneously active
  // Sample at each start/end event to find max overlapping count
  const events: Array<{ time: number; delta: number }> = [];
  for (const entry of entries) {
    const effectiveEnd = entry.endTime ?? entry.startTime + (entry.durationMs ?? 0);
    events.push({ time: entry.startTime, delta: 1 });
    events.push({ time: effectiveEnd, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let current = 0;
  let maxConcurrency = 0;
  for (const ev of events) {
    current += ev.delta;
    if (current > maxConcurrency) maxConcurrency = current;
  }

  return {
    entries,
    lanes: laneLabels,
    timeRange: { start, end },
    totalDuration: end - start,
    maxConcurrency,
  };
}

// ── Color Helpers ──────────────────────────────────────────────────────────

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    completed: '#22C55E',
    failed: '#EF4444',
    running: '#3B82F6',
    blocked: '#9CA3AF',
  };
  return colors[status] ?? '#9CA3AF';
}

export function getRunTypeColor(runType: string): string {
  const info = RUN_TYPE_REGISTRY[runType as keyof typeof RUN_TYPE_REGISTRY];
  return info?.color ?? '#6B7280';
}

// ── Bar Renderer ───────────────────────────────────────────────────────────

export function renderBarHtml(
  entry: TimelineEntry,
  timeStart: number,
  pxPerSec: number,
  options: WaterfallRenderOptions,
): string {
  const offsetMs = entry.startTime - timeStart;
  const durationMs =
    entry.durationMs ??
    (entry.endTime !== null ? entry.endTime - entry.startTime : 0);

  const leftPx = (offsetMs / 1000) * pxPerSec;
  const rawWidth = (durationMs / 1000) * pxPerSec;
  const widthPx = Math.max(rawWidth, options.minBarWidth);

  const color = options.colorByStatus
    ? getStatusColor(entry.status)
    : getRunTypeColor(entry.runType);

  const durationLabel =
    options.showDuration && durationMs > 0
      ? ` (${(durationMs / 1000).toFixed(2)}s)`
      : '';

  const titleText = `${entry.label}${durationLabel}`;
  const labelText = options.showLabels ? entry.label : '';

  return (
    `<div class="waterfall-bar status-${entry.status}" ` +
    `style="left:${leftPx}px; width:${widthPx}px; background-color:${color};" ` +
    `title="${escapeAttr(titleText)}" ` +
    `data-id="${escapeAttr(entry.id)}" ` +
    `data-run-type="${escapeAttr(entry.runType)}">` +
    (labelText ? escapeHtml(labelText) : '') +
    `</div>`
  );
}

// ── Time Axis Renderer ─────────────────────────────────────────────────────

export function renderTimeAxisHtml(
  timeRange: { readonly start: number; readonly end: number },
  pxPerSec: number,
): string {
  const totalMs = timeRange.end - timeRange.start;
  const totalSec = totalMs / 1000;

  // Adaptive tick interval
  let tickIntervalSec = 1;
  if (totalSec > 120) tickIntervalSec = 30;
  else if (totalSec > 60) tickIntervalSec = 10;
  else if (totalSec > 30) tickIntervalSec = 5;
  else if (totalSec > 10) tickIntervalSec = 2;

  const ticks: string[] = [];
  for (let sec = 0; sec <= totalSec; sec += tickIntervalSec) {
    const leftPx = sec * pxPerSec;
    ticks.push(
      `<div class="waterfall-tick" style="left:${leftPx}px;">` +
        `<span class="waterfall-tick-label">${sec}s</span>` +
        `</div>`,
    );
  }

  return `<div class="waterfall-time-axis">${ticks.join('')}</div>`;
}

// ── Lane Label Renderer ────────────────────────────────────────────────────

export function renderLaneLabelHtml(lanes: readonly string[]): string {
  if (lanes.length === 0) return '';
  const items = lanes
    .map(
      (label, i) =>
        `<div class="waterfall-lane-label" data-lane="${i}">${escapeHtml(label)}</div>`,
    )
    .join('');
  return `<div class="waterfall-lane-labels">${items}</div>`;
}

// ── Lane Rows ──────────────────────────────────────────────────────────────

function renderLanesHtml(
  viewModel: WaterfallViewModel,
  options: WaterfallRenderOptions,
): string {
  const { entries, lanes, timeRange } = viewModel;
  const pxPerSec = options.pixelsPerSecond;

  const laneRows = lanes.map((_, laneIndex) => {
    const laneEntries = entries.filter((e) => e.lane === laneIndex);
    const bars = laneEntries
      .map((e) => renderBarHtml(e, timeRange.start, pxPerSec, options))
      .join('');
    return (
      `<div class="waterfall-lane" data-lane="${laneIndex}" ` +
      `style="height:${options.laneHeight}px;">` +
      bars +
      `</div>`
    );
  });

  return `<div class="waterfall-lanes">${laneRows.join('')}</div>`;
}

// ── Main Renderer ──────────────────────────────────────────────────────────

export function renderWaterfallHtml(
  viewModel: WaterfallViewModel,
  options?: Partial<WaterfallRenderOptions>,
): string {
  const opts: WaterfallRenderOptions = { ...DEFAULT_WATERFALL_OPTIONS, ...options };
  const { entries, lanes, timeRange, totalDuration, maxConcurrency } = viewModel;

  const totalSec = (totalDuration / 1000).toFixed(1);
  const taskCount = entries.length;
  const maxParallel = maxConcurrency;

  const totalWidthPx =
    Math.ceil((totalDuration / 1000) * opts.pixelsPerSecond) + 40;

  const header =
    `<div class="waterfall-header">` +
    `<span class="waterfall-title">Timeline</span>` +
    `<span class="waterfall-stats">${taskCount} tasks | ${totalSec}s | max ${maxParallel} parallel</span>` +
    `</div>`;

  const timeAxis = renderTimeAxisHtml(timeRange, opts.pixelsPerSecond);
  const laneLabels = renderLaneLabelHtml(lanes);
  const lanesHtml = renderLanesHtml(viewModel, opts);

  const grid =
    `<div class="waterfall-grid" style="width:${totalWidthPx}px;">` +
    timeAxis +
    lanesHtml +
    `</div>`;

  const body =
    `<div class="waterfall-body">` +
    laneLabels +
    grid +
    `</div>`;

  return `<div class="waterfall-panel">${header}${body}</div>`;
}

// ── CSS ────────────────────────────────────────────────────────────────────

export function renderWaterfallCss(): string {
  return `
.waterfall-panel {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg-secondary, #1a1a2e);
  color: var(--text-primary, #e2e8f0);
  border-radius: 8px;
  overflow: hidden;
}

.waterfall-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-tertiary, #16213e);
  border-bottom: 1px solid var(--border, #2d3748);
}

.waterfall-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary, #e2e8f0);
}

.waterfall-stats {
  font-size: 11px;
  color: var(--text-muted, #718096);
}

.waterfall-body {
  display: flex;
  overflow-x: auto;
}

.waterfall-lane-labels {
  min-width: 120px;
  flex-shrink: 0;
  border-right: 1px solid var(--border, #2d3748);
}

.waterfall-lane-label {
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: 40px;
  font-size: 11px;
  color: var(--text-secondary, #a0aec0);
  border-bottom: 1px solid var(--border-subtle, #1e293b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.waterfall-grid {
  position: relative;
  min-width: 0;
}

.waterfall-time-axis {
  position: relative;
  height: 24px;
  border-bottom: 1px solid var(--border, #2d3748);
  background: var(--bg-tertiary, #16213e);
}

.waterfall-tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border, #2d3748);
}

.waterfall-tick-label {
  position: absolute;
  top: 4px;
  left: 3px;
  font-size: 10px;
  color: var(--text-muted, #718096);
  white-space: nowrap;
}

.waterfall-lanes {
  position: relative;
}

.waterfall-lane {
  position: relative;
  border-bottom: 1px solid var(--border-subtle, #1e293b);
  height: 40px;
}

.waterfall-bar {
  position: absolute;
  top: 6px;
  height: 28px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  padding: 0 6px;
  font-size: 11px;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;
  transition: opacity 0.15s;
}

.waterfall-bar:hover {
  opacity: 0.85;
  z-index: 10;
}

.waterfall-bar.status-running {
  animation: waterfall-pulse 1.5s ease-in-out infinite;
}

@keyframes waterfall-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
`.trim();
}

// ── Escape Helpers ─────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
