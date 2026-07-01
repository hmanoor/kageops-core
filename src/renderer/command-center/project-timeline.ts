// Project Timeline Visualization — B-113
// Full lifecycle Gantt from Discovery → POC → Business Viability → Design & Planning → Development → Launch & Growth

import { icon, type IconName } from '../../shared/icons';

export type ProjectPhase =
  | 'discovery'
  | 'poc'
  | 'business-viability'
  | 'design-planning'
  | 'development'
  | 'launch-growth';

export interface PhaseEntry {
  readonly phase: ProjectPhase;
  readonly label: string;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly status: 'pending' | 'active' | 'completed' | 'skipped';
  readonly taskCount: number;
  readonly completedTasks: number;
}

export interface TaskEntry {
  readonly id: string;
  readonly title: string;
  readonly phase: ProjectPhase;
  readonly agent: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly status: 'pending' | 'assigned' | 'in-progress' | 'completed' | 'failed' | 'blocked';
}

export interface ProjectTimelineViewModel {
  readonly projectName: string;
  readonly phases: readonly PhaseEntry[];
  readonly tasks: readonly TaskEntry[];
  readonly currentPhase: ProjectPhase;
  readonly overallProgress: number; // 0-1
  readonly estimatedCompletion: number | null; // timestamp
}

export interface ProjectTimelineRenderOptions {
  readonly showTasks: boolean;
  readonly showAgents: boolean;
  readonly phaseHeight: number; // px
  readonly taskHeight: number; // px
  readonly pixelsPerHour: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const PHASE_CONFIG: Readonly<Record<ProjectPhase, { label: string; iconName: IconName; color: string }>> = {
  discovery: { label: 'Discovery', iconName: 'search', color: '#8B5CF6' },
  poc: { label: 'Proof of Concept', iconName: 'flask', color: '#F59E0B' },
  'business-viability': { label: 'Business Viability', iconName: 'briefcase', color: '#10B981' },
  'design-planning': { label: 'Design & Planning', iconName: 'ruler', color: '#3B82F6' },
  development: { label: 'Development', iconName: 'settings', color: '#EF4444' },
  'launch-growth': { label: 'Launch & Growth', iconName: 'rocket', color: '#EC4899' },
};

export const ALL_PHASES: readonly ProjectPhase[] = [
  'discovery',
  'poc',
  'business-viability',
  'design-planning',
  'development',
  'launch-growth',
];

export const DEFAULT_TIMELINE_OPTIONS: ProjectTimelineRenderOptions = {
  showTasks: true,
  showAgents: true,
  phaseHeight: 50,
  taskHeight: 30,
  pixelsPerHour: 20,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getPhaseConfig(phase: ProjectPhase): { label: string; iconName: IconName; color: string } {
  return PHASE_CONFIG[phase];
}

export function getTaskStatusColor(status: string): string {
  switch (status) {
    case 'completed': return '#10B981';
    case 'in-progress': return '#3B82F6';
    case 'assigned': return '#8B5CF6';
    case 'failed': return '#EF4444';
    case 'blocked': return '#F59E0B';
    case 'pending':
    default: return '#6B7280';
  }
}

export function calculatePhaseProgress(phase: PhaseEntry): number {
  if (phase.taskCount === 0) return 0;
  return phase.completedTasks / phase.taskCount;
}

// ── Estimation ────────────────────────────────────────────────────────────────

export function estimateCompletion(
  phases: readonly PhaseEntry[],
  currentPhase: ProjectPhase,
): number | null {
  const completedPhases = phases.filter(
    (p) => p.status === 'completed' && p.startTime !== null && p.endTime !== null,
  );

  if (completedPhases.length < 2) return null;

  const avgDurationMs =
    completedPhases.reduce((sum, p) => sum + (p.endTime! - p.startTime!), 0) /
    completedPhases.length;

  const currentIndex = ALL_PHASES.indexOf(currentPhase);
  const remainingPhases = ALL_PHASES.slice(currentIndex).filter((ph) => {
    const entry = phases.find((p) => p.phase === ph);
    return entry?.status !== 'completed' && entry?.status !== 'skipped';
  });

  const now = Date.now();
  return now + remainingPhases.length * avgDurationMs;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildProjectTimeline(
  projectName: string,
  phases: readonly PhaseEntry[],
  tasks: readonly TaskEntry[],
  currentPhase: ProjectPhase,
): ProjectTimelineViewModel {
  const totalTasks = phases.reduce((sum, p) => sum + p.taskCount, 0);
  const completedTasks = phases.reduce((sum, p) => sum + p.completedTasks, 0);
  const overallProgress = totalTasks === 0 ? 0 : completedTasks / totalTasks;
  const estimatedCompletion = estimateCompletion(phases, currentPhase);

  return {
    projectName,
    phases,
    tasks,
    currentPhase,
    overallProgress,
    estimatedCompletion,
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────────

export function renderProjectTimelineCss(): string {
  return `
<style>
.pt-root { font-family: system-ui, sans-serif; background: #0F172A; color: #E2E8F0; padding: 16px; border-radius: 8px; }
.pt-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.pt-title { font-size: 16px; font-weight: 600; }
.pt-completion { font-size: 12px; color: #94A3B8; }
.pt-progress-wrap { margin-bottom: 16px; }
.pt-progress-label { font-size: 11px; color: #94A3B8; margin-bottom: 4px; }
.pt-progress-track { background: #1E293B; border-radius: 4px; height: 8px; overflow: hidden; }
.pt-progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease; }
.pt-phases { display: flex; flex-direction: column; gap: 4px; }
.pt-phase-row { position: relative; border-radius: 6px; overflow: hidden; }
.pt-phase-bar { display: flex; align-items: center; gap: 8px; padding: 0 12px; border-radius: 6px; }
.pt-phase-active { outline: 2px solid #60A5FA; outline-offset: 1px; }
.pt-phase-icon { font-size: 14px; flex-shrink: 0; }
.pt-phase-label { font-size: 13px; font-weight: 500; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pt-phase-progress { font-size: 11px; color: rgba(255,255,255,0.7); flex-shrink: 0; }
.pt-phase-status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; opacity: 0.8; }
.pt-tasks { padding: 4px 8px 4px 28px; display: flex; flex-direction: column; gap: 3px; }
.pt-task-bar { display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 4px; }
.pt-task-title { font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pt-agent-badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.15); flex-shrink: 0; }
.pt-no-time { opacity: 0.5; font-style: italic; }
</style>`.trim();
}

// ── Bar renderers ─────────────────────────────────────────────────────────────

export function renderPhaseBarHtml(
  phase: PhaseEntry,
  timeRange: { start: number; end: number },
  pxPerHour: number,
): string {
  const config = getPhaseConfig(phase.phase);
  const rangeMs = timeRange.end - timeRange.start;
  const pxPerMs = pxPerHour / 3_600_000;

  const left =
    phase.startTime !== null
      ? Math.max(0, (phase.startTime - timeRange.start) * pxPerMs)
      : 0;

  const width =
    phase.startTime !== null && phase.endTime !== null
      ? Math.max(8, (phase.endTime - phase.startTime) * pxPerMs)
      : rangeMs > 0
      ? Math.max(8, rangeMs * pxPerMs * 0.15)
      : 80;

  const progress = calculatePhaseProgress(phase);
  const progressPct = Math.round(progress * 100);
  const isActive = phase.status === 'active';
  const activeClass = isActive ? ' pt-phase-active' : '';
  const noTimeClass = phase.startTime === null ? ' pt-no-time' : '';

  return `<div class="pt-phase-row${noTimeClass}" style="margin-left:${left}px; width:${width}px; min-width:120px;">
  <div class="pt-phase-bar${activeClass}" style="background:${config.color}; height:50px;">
    <span class="pt-phase-icon">${icon(config.iconName, { size: 14 })}</span>
    <span class="pt-phase-label">${escapeHtml(config.label)}</span>
    <span class="pt-phase-progress">${progressPct}%</span>
    <span class="pt-phase-status">${phase.status}</span>
  </div>
</div>`.trim();
}

export function renderTaskBarHtml(
  task: TaskEntry,
  timeRange: { start: number; end: number },
  pxPerHour: number,
  showAgent: boolean,
): string {
  const color = getTaskStatusColor(task.status);
  const pxPerMs = pxPerHour / 3_600_000;
  const rangeMs = timeRange.end - timeRange.start;

  const left =
    task.startTime !== null
      ? Math.max(0, (task.startTime - timeRange.start) * pxPerMs)
      : 0;

  const width =
    task.startTime !== null && task.endTime !== null
      ? Math.max(6, (task.endTime - task.startTime) * pxPerMs)
      : rangeMs > 0
      ? Math.max(6, rangeMs * pxPerMs * 0.1)
      : 60;

  const agentBadge =
    showAgent && task.agent !== null
      ? `<span class="pt-agent-badge">${escapeHtml(task.agent)}</span>`
      : '';

  return `<div class="pt-task-bar" style="background:${color}; height:30px; margin-left:${left}px; width:${width}px; min-width:60px;">
  <span class="pt-task-title">${escapeHtml(task.title)}</span>
  ${agentBadge}
</div>`.trim();
}

// ── Progress bar ──────────────────────────────────────────────────────────────

export function renderProgressBar(progress: number): string {
  const clamped = Math.min(1, Math.max(0, progress));
  const pct = Math.round(clamped * 100);
  const fillColor = pct === 100 ? '#10B981' : '#3B82F6';

  return `<div class="pt-progress-wrap">
  <div class="pt-progress-label">Overall progress — ${pct}%</div>
  <div class="pt-progress-track">
    <div class="pt-progress-fill" style="width:${pct}%; background:${fillColor};"></div>
  </div>
</div>`.trim();
}

// ── Full HTML renderer ────────────────────────────────────────────────────────

export function renderProjectTimelineHtml(
  viewModel: ProjectTimelineViewModel,
  options?: Partial<ProjectTimelineRenderOptions>,
): string {
  const opts: ProjectTimelineRenderOptions = { ...DEFAULT_TIMELINE_OPTIONS, ...options };

  // Derive time range from all phases/tasks with known times
  const allStarts = [
    ...viewModel.phases.map((p) => p.startTime),
    ...viewModel.tasks.map((t) => t.startTime),
  ].filter((t): t is number => t !== null);

  const allEnds = [
    ...viewModel.phases.map((p) => p.endTime),
    ...viewModel.tasks.map((t) => t.endTime),
  ].filter((t): t is number => t !== null);

  const now = Date.now();
  const rangeStart = allStarts.length > 0 ? Math.min(...allStarts) : now;
  const rangeEnd = allEnds.length > 0 ? Math.max(...allEnds, now) : now + 3_600_000;
  const timeRange = { start: rangeStart, end: rangeEnd };

  const estLine =
    viewModel.estimatedCompletion !== null
      ? `<span class="pt-completion">Est. completion: ${new Date(viewModel.estimatedCompletion).toLocaleDateString()}</span>`
      : '';

  const phasesHtml = viewModel.phases
    .map((phase) => {
      const barHtml = renderPhaseBarHtml(phase, timeRange, opts.pixelsPerHour);

      const tasksHtml =
        opts.showTasks
          ? viewModel.tasks
              .filter((t) => t.phase === phase.phase)
              .map((t) => renderTaskBarHtml(t, timeRange, opts.pixelsPerHour, opts.showAgents))
              .join('\n')
          : '';

      const taskSection =
        opts.showTasks && tasksHtml.length > 0
          ? `<div class="pt-tasks">${tasksHtml}</div>`
          : '';

      return `${barHtml}\n${taskSection}`;
    })
    .join('\n');

  return `${renderProjectTimelineCss()}
<div class="pt-root">
  <div class="pt-header">
    <span class="pt-title">${escapeHtml(viewModel.projectName)}</span>
    ${estLine}
  </div>
  ${renderProgressBar(viewModel.overallProgress)}
  <div class="pt-phases">
    ${phasesHtml}
  </div>
</div>`.trim();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
