/**
 * Tests for B-110: Waterfall Timeline Panel
 */

import { describe, it, expect } from 'vitest';
import {
  assignLanes,
  buildWaterfallViewModel,
  renderWaterfallHtml,
  renderBarHtml,
  renderTimeAxisHtml,
  getStatusColor,
  getRunTypeColor,
  renderWaterfallCss,
  DEFAULT_WATERFALL_OPTIONS,
  type TimelineEntry,
} from '../../src/renderer/command-center/waterfall-panel.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

type EntryInput = Omit<TimelineEntry, 'lane'>;

function makeEntry(overrides: Partial<EntryInput> & { id: string }): EntryInput {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    startTime: overrides.startTime ?? 1000,
    endTime: overrides.endTime ?? null,
    durationMs: overrides.durationMs ?? 500,
    status: overrides.status ?? 'completed',
    runType: overrides.runType ?? 'llm',
    parentId: overrides.parentId ?? null,
    metadata: overrides.metadata ?? {},
  };
}

function makeAssigned(overrides: Partial<TimelineEntry> & { id: string }): TimelineEntry {
  return { ...makeEntry(overrides), lane: overrides.lane ?? 0 };
}

// ── assignLanes ────────────────────────────────────────────────────────────

describe('assignLanes', () => {
  it('puts non-overlapping entries on the same lane', () => {
    const entries: EntryInput[] = [
      makeEntry({ id: 'a', startTime: 1000, durationMs: 500 }),  // 1000–1500
      makeEntry({ id: 'b', startTime: 1600, durationMs: 500 }),  // 1600–2100
    ];
    const result = assignLanes(entries);
    expect(result[0].lane).toBe(0);
    expect(result[1].lane).toBe(0);
  });

  it('puts overlapping entries on different lanes', () => {
    const entries: EntryInput[] = [
      makeEntry({ id: 'a', startTime: 1000, durationMs: 1000 }), // 1000–2000
      makeEntry({ id: 'b', startTime: 1200, durationMs: 500 }),  // 1200–1700
    ];
    const result = assignLanes(entries);
    const laneA = result.find((e) => e.id === 'a')!.lane;
    const laneB = result.find((e) => e.id === 'b')!.lane;
    expect(laneA).not.toBe(laneB);
  });

  it('assigns all lane 0 for fully sequential entries', () => {
    const entries: EntryInput[] = [
      makeEntry({ id: 'a', startTime: 0,    durationMs: 100 }),
      makeEntry({ id: 'b', startTime: 100,  durationMs: 100 }),
      makeEntry({ id: 'c', startTime: 200,  durationMs: 100 }),
    ];
    const result = assignLanes(entries);
    expect(result.every((e) => e.lane === 0)).toBe(true);
  });

  it('assigns each entry its own lane for fully parallel entries', () => {
    const entries: EntryInput[] = [
      makeEntry({ id: 'a', startTime: 1000, durationMs: 500 }),
      makeEntry({ id: 'b', startTime: 1000, durationMs: 500 }),
      makeEntry({ id: 'c', startTime: 1000, durationMs: 500 }),
    ];
    const result = assignLanes(entries);
    const lanes = result.map((e) => e.lane).sort();
    expect(lanes).toEqual([0, 1, 2]);
  });
});

// ── buildWaterfallViewModel ────────────────────────────────────────────────

describe('buildWaterfallViewModel', () => {
  it('calculates time range from entries', () => {
    const entries: TimelineEntry[] = [
      makeAssigned({ id: 'a', startTime: 1000, endTime: 1500, durationMs: 500 }),
      makeAssigned({ id: 'b', startTime: 1200, endTime: 2000, durationMs: 800 }),
    ];
    const vm = buildWaterfallViewModel(entries);
    expect(vm.timeRange.start).toBe(1000);
    expect(vm.timeRange.end).toBe(2000);
  });

  it('calculates max concurrency correctly', () => {
    const entries: TimelineEntry[] = [
      makeAssigned({ id: 'a', startTime: 0,   endTime: 1000, durationMs: 1000, lane: 0 }),
      makeAssigned({ id: 'b', startTime: 200, endTime: 800,  durationMs: 600,  lane: 1 }),
      makeAssigned({ id: 'c', startTime: 400, endTime: 600,  durationMs: 200,  lane: 2 }),
    ];
    const vm = buildWaterfallViewModel(entries);
    expect(vm.maxConcurrency).toBe(3);
  });

  it('calculates total duration', () => {
    const entries: TimelineEntry[] = [
      makeAssigned({ id: 'a', startTime: 1000, endTime: 3500, durationMs: 2500 }),
    ];
    const vm = buildWaterfallViewModel(entries);
    expect(vm.totalDuration).toBe(2500);
  });
});

// ── renderWaterfallHtml ────────────────────────────────────────────────────

describe('renderWaterfallHtml', () => {
  it('includes all entries as bars', () => {
    const entries: TimelineEntry[] = [
      makeAssigned({ id: 'forge-impl',  startTime: 1000, endTime: 2000, durationMs: 1000, lane: 0 }),
      makeAssigned({ id: 'vigil-check', startTime: 1500, endTime: 2200, durationMs: 700,  lane: 1 }),
    ];
    const vm = buildWaterfallViewModel(entries);
    const html = renderWaterfallHtml(vm);
    expect(html).toContain('data-id="forge-impl"');
    expect(html).toContain('data-id="vigil-check"');
  });

  it('includes time axis element', () => {
    const entries: TimelineEntry[] = [
      makeAssigned({ id: 'a', startTime: 0, endTime: 2000, durationMs: 2000, lane: 0 }),
    ];
    const vm = buildWaterfallViewModel(entries);
    const html = renderWaterfallHtml(vm);
    expect(html).toContain('waterfall-time-axis');
  });
});

// ── renderBarHtml ──────────────────────────────────────────────────────────

describe('renderBarHtml', () => {
  it('calculates correct left position', () => {
    const entry = makeAssigned({ id: 'x', startTime: 2000, durationMs: 500 });
    const html = renderBarHtml(entry, 1000, 100, DEFAULT_WATERFALL_OPTIONS);
    // offset = 1000ms = 1.0s → 100px
    expect(html).toContain('left:100px');
  });

  it('calculates correct width', () => {
    const entry = makeAssigned({ id: 'x', startTime: 1000, durationMs: 2000 });
    const html = renderBarHtml(entry, 1000, 100, DEFAULT_WATERFALL_OPTIONS);
    // duration = 2000ms = 2.0s → 200px
    expect(html).toContain('width:200px');
  });

  it('applies minimum bar width when duration is very short', () => {
    const opts = { ...DEFAULT_WATERFALL_OPTIONS, pixelsPerSecond: 1, minBarWidth: 8 };
    const entry = makeAssigned({ id: 'x', startTime: 1000, durationMs: 1 }); // 0.001s → 0.001px
    const html = renderBarHtml(entry, 1000, 1, opts);
    expect(html).toContain('width:8px');
  });

  it('includes status CSS class', () => {
    const entry = makeAssigned({ id: 'x', startTime: 1000, durationMs: 500, status: 'failed' });
    const html = renderBarHtml(entry, 1000, 100, DEFAULT_WATERFALL_OPTIONS);
    expect(html).toContain('status-failed');
  });
});

// ── renderTimeAxisHtml ─────────────────────────────────────────────────────

describe('renderTimeAxisHtml', () => {
  it('includes tick marks for the time range', () => {
    const html = renderTimeAxisHtml({ start: 0, end: 3000 }, 100);
    expect(html).toContain('0s');
    expect(html).toContain('1s');
    expect(html).toContain('2s');
    expect(html).toContain('3s');
  });
});

// ── getStatusColor ─────────────────────────────────────────────────────────

describe('getStatusColor', () => {
  it('maps all statuses to correct hex colors', () => {
    expect(getStatusColor('completed')).toBe('#22C55E');
    expect(getStatusColor('failed')).toBe('#EF4444');
    expect(getStatusColor('running')).toBe('#3B82F6');
    expect(getStatusColor('blocked')).toBe('#9CA3AF');
  });
});

// ── getRunTypeColor ────────────────────────────────────────────────────────

describe('getRunTypeColor', () => {
  it('maps known run types to hex colors', () => {
    expect(getRunTypeColor('llm')).toBe('#F59E0B');
    expect(getRunTypeColor('tool')).toBe('#10B981');
    expect(getRunTypeColor('review')).toBe('#8B5CF6');
    expect(getRunTypeColor('deploy')).toBe('#EF4444');
    expect(getRunTypeColor('orchestrate')).toBe('#6366F1');
  });
});

// ── renderWaterfallCss ─────────────────────────────────────────────────────

describe('renderWaterfallCss', () => {
  it('includes lane height rules', () => {
    const css = renderWaterfallCss();
    expect(css).toContain('.waterfall-lane');
    expect(css).toContain('height: 40px');
  });
});

// ── DEFAULT_WATERFALL_OPTIONS ──────────────────────────────────────────────

describe('DEFAULT_WATERFALL_OPTIONS', () => {
  it('has expected default values', () => {
    expect(DEFAULT_WATERFALL_OPTIONS.pixelsPerSecond).toBe(100);
    expect(DEFAULT_WATERFALL_OPTIONS.laneHeight).toBe(40);
    expect(DEFAULT_WATERFALL_OPTIONS.showLabels).toBe(true);
    expect(DEFAULT_WATERFALL_OPTIONS.showDuration).toBe(true);
    expect(DEFAULT_WATERFALL_OPTIONS.colorByStatus).toBe(true);
    expect(DEFAULT_WATERFALL_OPTIONS.minBarWidth).toBe(4);
  });
});
