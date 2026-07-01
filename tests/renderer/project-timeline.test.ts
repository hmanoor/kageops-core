import { describe, it, expect } from 'vitest';
import {
  buildProjectTimeline,
  renderProjectTimelineHtml,
  renderPhaseBarHtml,
  renderTaskBarHtml,
  renderProgressBar,
  calculatePhaseProgress,
  getPhaseConfig,
  getTaskStatusColor,
  estimateCompletion,
  ALL_PHASES,
  PHASE_CONFIG,
  DEFAULT_TIMELINE_OPTIONS,
  type PhaseEntry,
  type TaskEntry,
  type ProjectPhase,
} from '../../src/renderer/command-center/project-timeline';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2025-06-01T12:00:00Z').getTime();
const HOUR = 3_600_000;

function makePhase(overrides?: Partial<PhaseEntry>): PhaseEntry {
  return {
    phase: 'discovery',
    label: 'Discovery',
    startTime: NOW,
    endTime: NOW + 2 * HOUR,
    status: 'completed',
    taskCount: 4,
    completedTasks: 4,
    ...overrides,
  };
}

function makeTask(overrides?: Partial<TaskEntry>): TaskEntry {
  return {
    id: 'task-1',
    title: 'Analyse market',
    phase: 'discovery',
    agent: 'Scout',
    startTime: NOW,
    endTime: NOW + HOUR,
    status: 'completed',
    ...overrides,
  };
}

const TIME_RANGE = { start: NOW, end: NOW + 6 * HOUR };

// ── 1. buildProjectTimeline — overall progress ────────────────────────────────

describe('buildProjectTimeline', () => {
  it('calculates overall progress from phase task counts', () => {
    const phases: PhaseEntry[] = [
      makePhase({ taskCount: 4, completedTasks: 4 }),
      makePhase({ phase: 'poc', status: 'active', taskCount: 4, completedTasks: 2 }),
    ];
    const vm = buildProjectTimeline('TestProject', phases, [], 'poc');
    // (4 + 2) / (4 + 4) = 0.75
    expect(vm.overallProgress).toBeCloseTo(0.75);
  });

  // ── 2. buildProjectTimeline — currentPhase ────────────────────────────────

  it('propagates currentPhase into view model', () => {
    const phases: PhaseEntry[] = [makePhase()];
    const vm = buildProjectTimeline('P', phases, [], 'discovery');
    expect(vm.currentPhase).toBe('discovery');
  });
});

// ── 3. renderProjectTimelineHtml — includes all phases ───────────────────────

describe('renderProjectTimelineHtml', () => {
  const phases: PhaseEntry[] = ALL_PHASES.map((ph, i) =>
    makePhase({
      phase: ph,
      status: i === 0 ? 'completed' : i === 1 ? 'active' : 'pending',
      startTime: NOW + i * 2 * HOUR,
      endTime: NOW + (i + 1) * 2 * HOUR,
    }),
  );

  it('includes labels for all 6 phases', () => {
    const html = renderProjectTimelineHtml(
      buildProjectTimeline('MyApp', phases, [], 'poc'),
    );
    expect(html).toContain('Discovery');
    expect(html).toContain('Proof of Concept');
    expect(html).toContain('Business Viability');
    expect(html).toContain('Design &amp; Planning');
    expect(html).toContain('Development');
    expect(html).toContain('Launch &amp; Growth');
  });

  // ── 4. renderProjectTimelineHtml — includes progress bar ─────────────────

  it('includes overall progress bar element', () => {
    const html = renderProjectTimelineHtml(
      buildProjectTimeline('MyApp', phases, [], 'poc'),
    );
    expect(html).toContain('pt-progress-wrap');
    expect(html).toContain('pt-progress-fill');
  });
});

// ── 5. renderPhaseBarHtml — icon and label ────────────────────────────────────

describe('renderPhaseBarHtml', () => {
  it('includes phase icon and label', () => {
    const phase = makePhase({ phase: 'development', label: 'Development' });
    const html = renderPhaseBarHtml(phase, TIME_RANGE, 20);
    expect(html).toContain('data-icon="settings"');
    expect(html).toContain('Development');
  });

  // ── 6. renderPhaseBarHtml — status color ─────────────────────────────────

  it('applies the phase color from PHASE_CONFIG', () => {
    const phase = makePhase({ phase: 'discovery' });
    const html = renderPhaseBarHtml(phase, TIME_RANGE, 20);
    expect(html).toContain(PHASE_CONFIG.discovery.color);
  });
});

// ── 7. renderTaskBarHtml — task title ────────────────────────────────────────

describe('renderTaskBarHtml', () => {
  it('includes the task title', () => {
    const task = makeTask({ title: 'Write unit tests' });
    const html = renderTaskBarHtml(task, TIME_RANGE, 20, false);
    expect(html).toContain('Write unit tests');
  });

  // ── 8. renderTaskBarHtml — agent badge ───────────────────────────────────

  it('shows agent badge when showAgent is true', () => {
    const task = makeTask({ agent: 'Forge' });
    const html = renderTaskBarHtml(task, TIME_RANGE, 20, true);
    expect(html).toContain('Forge');
    expect(html).toContain('pt-agent-badge');
  });

  it('does not show agent badge when showAgent is false', () => {
    const task = makeTask({ agent: 'Forge' });
    const html = renderTaskBarHtml(task, TIME_RANGE, 20, false);
    expect(html).not.toContain('pt-agent-badge');
  });
});

// ── 9. renderProgressBar — correct percentage ────────────────────────────────

describe('renderProgressBar', () => {
  it('shows the correct percentage', () => {
    const html = renderProgressBar(0.42);
    expect(html).toContain('42%');
    expect(html).toContain('width:42%');
  });

  it('clamps progress above 1 to 100%', () => {
    const html = renderProgressBar(1.5);
    expect(html).toContain('100%');
  });
});

// ── 10. calculatePhaseProgress — correct ratio ───────────────────────────────

describe('calculatePhaseProgress', () => {
  it('returns completedTasks / taskCount', () => {
    const phase = makePhase({ taskCount: 5, completedTasks: 3 });
    expect(calculatePhaseProgress(phase)).toBeCloseTo(0.6);
  });

  // ── 11. calculatePhaseProgress — 0 for no tasks ──────────────────────────

  it('returns 0 when taskCount is 0', () => {
    const phase = makePhase({ taskCount: 0, completedTasks: 0 });
    expect(calculatePhaseProgress(phase)).toBe(0);
  });
});

// ── 12. getPhaseConfig — all phases ──────────────────────────────────────────

describe('getPhaseConfig', () => {
  it('returns correct config for all phases', () => {
    const phases: ProjectPhase[] = [
      'discovery',
      'poc',
      'business-viability',
      'design-planning',
      'development',
      'launch-growth',
    ];
    for (const ph of phases) {
      const config = getPhaseConfig(ph);
      expect(config).toHaveProperty('label');
      expect(config).toHaveProperty('iconName');
      expect(config).toHaveProperty('color');
      expect(config.label.length).toBeGreaterThan(0);
    }
  });
});

// ── 13. getTaskStatusColor — all statuses ────────────────────────────────────

describe('getTaskStatusColor', () => {
  const statuses = ['pending', 'assigned', 'in-progress', 'completed', 'failed', 'blocked'];

  it('returns a non-empty hex color for all statuses', () => {
    for (const s of statuses) {
      const color = getTaskStatusColor(s);
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('returns a default color for unknown status', () => {
    expect(getTaskStatusColor('unknown-status')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

// ── 14. estimateCompletion — null with < 2 completed phases ──────────────────

describe('estimateCompletion', () => {
  it('returns null when fewer than 2 phases are completed', () => {
    const phases: PhaseEntry[] = [
      makePhase({ status: 'completed' }),
      makePhase({ phase: 'poc', status: 'active' }),
    ];
    expect(estimateCompletion(phases, 'poc')).toBeNull();
  });

  // ── 15. estimateCompletion — estimates based on average duration ──────────

  it('estimates future time based on average completed phase duration', () => {
    const phases: PhaseEntry[] = [
      makePhase({ phase: 'discovery', status: 'completed', startTime: NOW, endTime: NOW + 2 * HOUR }),
      makePhase({ phase: 'poc', status: 'completed', startTime: NOW + 2 * HOUR, endTime: NOW + 4 * HOUR }),
      makePhase({ phase: 'business-viability', status: 'active', startTime: NOW + 4 * HOUR, endTime: null }),
      makePhase({ phase: 'design-planning', status: 'pending', startTime: null, endTime: null }),
      makePhase({ phase: 'development', status: 'pending', startTime: null, endTime: null }),
      makePhase({ phase: 'launch-growth', status: 'pending', startTime: null, endTime: null }),
    ];
    const result = estimateCompletion(phases, 'business-viability');
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(Date.now());
  });
});

// ── 16. ALL_PHASES — 6 entries in order ──────────────────────────────────────

describe('ALL_PHASES', () => {
  it('has exactly 6 entries', () => {
    expect(ALL_PHASES).toHaveLength(6);
  });

  it('is in lifecycle order', () => {
    expect(ALL_PHASES[0]).toBe('discovery');
    expect(ALL_PHASES[5]).toBe('launch-growth');
  });
});

// ── 17. PHASE_CONFIG — all 6 phases ──────────────────────────────────────────

describe('PHASE_CONFIG', () => {
  it('has entries for all 6 phases', () => {
    for (const ph of ALL_PHASES) {
      expect(PHASE_CONFIG).toHaveProperty(ph);
    }
  });
});

// ── 18. DEFAULT_TIMELINE_OPTIONS ─────────────────────────────────────────────

describe('DEFAULT_TIMELINE_OPTIONS', () => {
  it('has showTasks enabled', () => {
    expect(DEFAULT_TIMELINE_OPTIONS.showTasks).toBe(true);
  });

  it('has showAgents enabled', () => {
    expect(DEFAULT_TIMELINE_OPTIONS.showAgents).toBe(true);
  });

  it('has phaseHeight of 50', () => {
    expect(DEFAULT_TIMELINE_OPTIONS.phaseHeight).toBe(50);
  });

  it('has taskHeight of 30', () => {
    expect(DEFAULT_TIMELINE_OPTIONS.taskHeight).toBe(30);
  });

  it('has pixelsPerHour of 20', () => {
    expect(DEFAULT_TIMELINE_OPTIONS.pixelsPerHour).toBe(20);
  });
});
