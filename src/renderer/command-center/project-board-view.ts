/**
 * Project Board View — Kanban board driven by real task data.
 *
 * Exports `initProjectBoardView` which mounts a full Jira/Azure-style
 * project board into the given host element.
 */

// ── Public types ─────────────────────────────────────

export interface BoardProject {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly current_phase: string;
    readonly taskCounts: {
        readonly total: number;
        readonly pending: number;
        readonly assigned: number;
        readonly completed: number;
        readonly failed: number;
    };
}

export interface BoardTask {
    readonly id: string;
    readonly title: string;
    readonly task_type: string | null;
    readonly assigned_agent: string;
    readonly status: string;
    readonly phase: string;
    readonly priority: number;
    readonly completed_at: string | null;
    readonly output_path: string | null;
    readonly response_text: string | null;
}

export interface BoardAgent {
    readonly name: string;
    readonly status: string;
    readonly currentTaskId?: string;
}

export interface ProjectBoardApi {
    listProjects(): Promise<readonly BoardProject[]>;
    getProjectTasks(projectId: string): Promise<readonly BoardTask[]>;
    getAgents(): Promise<readonly BoardAgent[]>;
    onActivityEvent(cb: (e: unknown) => void): () => void;
    onOpenArtifact?: (projectId: string, projectName: string, filePath: string | null) => void;
}

export interface ProjectBoardHandle {
    refresh(): Promise<void>;
    destroy(): void;
}

// ── Constants ────────────────────────────────────────

const AGENT_COLORS: Readonly<Record<string, string>> = {
    forge:     '#87d96c',
    vigil:     '#facc15',
    scout:     '#89c4f4',
    blueprint: '#5ccfe6',
    pixel:     '#d4bfff',
    cipher:    '#c792ea',
    aegis:     '#ff8c7a',
    herald:    '#ffd580',
    sensei:    '#fbbf24',
};

const PHASE_KEYS = [
    'discovery',
    'poc',
    'business-viability',
    'design-planning',
    'development',
    'launch-growth',
] as const;

type PhaseKey = (typeof PHASE_KEYS)[number];

const PHASE_LABELS: Readonly<Record<PhaseKey, string>> = {
    'discovery':         'Discovery',
    'poc':               'POC',
    'business-viability':'Viability',
    'design-planning':   'Design & Plan',
    'development':       'Development',
    'launch-growth':     'Launch & Growth',
};

const PHASE_SHORT: Readonly<Record<PhaseKey, string>> = {
    'discovery':         'DISC',
    'poc':               'POC',
    'business-viability':'BIZ',
    'design-planning':   'DESIGN',
    'development':       'DEV',
    'launch-growth':     'LAUNCH',
};

// ── Helpers ──────────────────────────────────────────

function agentColor(name: string): string {
    return AGENT_COLORS[name.toLowerCase()] ?? '#888888';
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function truncatePath(p: string): string {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
}

function taskStatusIcon(status: string): string {
    switch (status) {
        case 'completed': return '<span class="pb-status-icon pb-status-icon--done" title="Completed">✓</span>';
        case 'assigned':  return '<span class="pb-status-icon pb-status-icon--active" title="In Progress">●</span>';
        case 'failed':    return '<span class="pb-status-icon pb-status-icon--error" title="Failed">✗</span>';
        default:          return '<span class="pb-status-icon pb-status-icon--pending" title="Pending">○</span>';
    }
}

function mapPhaseToKey(phase: string): PhaseKey {
    const normalized = phase.toLowerCase().trim();
    if (PHASE_KEYS.includes(normalized as PhaseKey)) return normalized as PhaseKey;
    // Fuzzy fallback
    if (normalized.includes('disc'))   return 'discovery';
    if (normalized.includes('poc'))    return 'poc';
    if (normalized.includes('biz') || normalized.includes('viab')) return 'business-viability';
    if (normalized.includes('design') || normalized.includes('plan')) return 'design-planning';
    if (normalized.includes('dev'))    return 'development';
    if (normalized.includes('launch') || normalized.includes('growth')) return 'launch-growth';
    return 'development'; // default to development for unknown phases
}

function phaseIndex(key: PhaseKey): number {
    return PHASE_KEYS.indexOf(key);
}

function projectCurrentPhaseKey(project: BoardProject): PhaseKey {
    return mapPhaseToKey(project.current_phase ?? project.status ?? 'discovery');
}

function formatRelTime(iso: string | null): string {
    if (iso === null || iso === '') return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

interface StoredEvent {
    readonly msg: string;
    readonly time: string;
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly channel: string | null;
}

// ── State ────────────────────────────────────────────

interface BoardState {
    readonly activeTabId: string; // 'all' or project id
    readonly openTabs: readonly string[]; // project ids
    readonly projects: readonly BoardProject[];
    readonly tasksByProject: Readonly<Record<string, readonly BoardTask[]>>;
    readonly agents: readonly BoardAgent[];
    readonly recentEvents: readonly StoredEvent[]; // last 50 events
    readonly loading: boolean;
    readonly error: string | null;
    readonly activeAgentFilter: string | null; // agent name filter, null = show all
}

// ── Main entry ────────────────────────────────────────

export function initProjectBoardView(
    host: HTMLElement,
    api: ProjectBoardApi,
): ProjectBoardHandle {
    let state: BoardState = {
        activeTabId: 'all',
        openTabs: [],
        projects: [],
        tasksByProject: {},
        agents: [],
        recentEvents: [],
        loading: true,
        error: null,
        activeAgentFilter: null,
    };

    let destroyed = false;

    // ── Render root ──────────────────────────────────

    host.innerHTML = '<div class="pb-layout" id="pb-root"></div>';
    const rootOrNull = host.querySelector<HTMLElement>('#pb-root');
    if (rootOrNull === null) return { refresh: async () => undefined, destroy: () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const root: HTMLElement = rootOrNull;

    // ── Rendering ────────────────────────────────────

    function render(): void {
        if (destroyed) return;
        root.innerHTML = buildLayout();
        bindEvents();
    }

    function buildLayout(): string {
        return `
            ${buildTabStrip()}
            <div class="pb-body">
                ${buildMainArea()}
                ${state.activeTabId !== 'all' ? buildSidebar() : ''}
            </div>`;
    }

    function buildTabStrip(): string {
        const allActive = state.activeTabId === 'all' ? ' pb-tab--active' : '';
        const tabs = state.openTabs.map((pid) => {
            const proj = state.projects.find((p) => p.id === pid);
            const name = proj?.name ?? pid;
            const active = state.activeTabId === pid ? ' pb-tab--active' : '';
            return `
                <button class="pb-tab${active}" data-tab="${escHtml(pid)}" type="button">
                    <span class="pb-tab-label">${escHtml(name)}</span>
                    <span class="pb-tab-close" data-close-tab="${escHtml(pid)}" title="Close" aria-label="Close ${escHtml(name)}">×</span>
                </button>`;
        }).join('');

        return `
            <div class="pb-tabs">
                <button class="pb-tab${allActive}" data-tab="all" type="button">All Projects</button>
                ${tabs}
                <button class="pb-refresh-btn" id="pb-refresh-btn" type="button" title="Refresh">↺ Refresh</button>
            </div>`;
    }

    function buildMainArea(): string {
        if (state.loading) {
            return `<div class="pb-loading">
                <div class="panel-loading">
                    <div class="skeleton-card"><div class="skeleton skeleton-line skeleton-line--wide"></div><div class="skeleton skeleton-line skeleton-line--mid"></div></div>
                    <div class="skeleton-card"><div class="skeleton skeleton-line skeleton-line--wide"></div><div class="skeleton skeleton-line skeleton-line--short"></div></div>
                    <div class="skeleton-card"><div class="skeleton skeleton-line skeleton-line--mid"></div><div class="skeleton skeleton-line skeleton-line--short"></div></div>
                </div>
            </div>`;
        }
        if (state.error !== null) {
            return `<div class="pb-error">${escHtml(state.error)}</div>`;
        }
        if (state.activeTabId === 'all') {
            return buildAllProjectsGrid();
        }
        return buildKanbanWrap(state.activeTabId);
    }

    function buildAllProjectsGrid(): string {
        if (state.projects.length === 0) {
            return `<div class="pb-empty-state empty-state">
                <div class="empty-state__icon">⬡</div>
                <div class="empty-state__title">No projects yet</div>
                <div class="empty-state__desc">Start a new project from Mission Control to see it here.</div>
            </div>`;
        }
        const cards = state.projects.map((p) => buildProjectCard(p)).join('');
        return `<div class="pb-projects-grid">${cards}</div>`;
    }

    function buildProjectCard(p: BoardProject): string {
        const tc = p.taskCounts;
        const pct = tc.total > 0 ? Math.round((tc.completed / tc.total) * 100) : 0;
        const phaseKey = projectCurrentPhaseKey(p);
        const phaseBadge = PHASE_SHORT[phaseKey] ?? p.current_phase;

        const failedPill = tc.failed > 0
            ? `<span class="pb-pill pb-pill--error">${tc.failed} failed</span>`
            : '';
        const pendingPill = `<span class="pb-pill pb-pill--muted">${tc.pending} pending</span>`;
        const donePill = `<span class="pb-pill pb-pill--success">${tc.completed} done</span>`;

        // Active agent dots — find agents working on this project
        const activeDots = state.agents
            .filter((a) => a.status === 'busy')
            .slice(0, 5)
            .map((a) => {
                const color = agentColor(a.name);
                return `<span class="pb-agent-dot" style="background:${color}" title="${escHtml(a.name)}"></span>`;
            }).join('');

        return `
            <div class="pb-project-card" data-open-project="${escHtml(p.id)}">
                <div class="pb-project-card__top">
                    <span class="pb-project-card__name">${escHtml(p.name)}</span>
                    <span class="pb-phase-badge">${escHtml(phaseBadge)}</span>
                </div>
                <div class="pb-progress-wrap">
                    <div class="pb-progress-bar">
                        <div class="pb-progress-fill" style="width:${pct}%"></div>
                    </div>
                    <span class="pb-progress-label">${tc.completed}/${tc.total} tasks</span>
                </div>
                <div class="pb-project-card__pills">
                    ${pendingPill}${donePill}${failedPill}
                </div>
                ${activeDots.length > 0 ? `<div class="pb-agent-dots">${activeDots}</div>` : ''}
                <button class="pb-open-btn" data-open-project="${escHtml(p.id)}" type="button">Open Board →</button>
            </div>`;
    }

    function buildKanbanWrap(projectId: string): string {
        const project = state.projects.find((p) => p.id === projectId);
        const allTasks = state.tasksByProject[projectId] ?? [];
        const phaseKey = project !== undefined ? projectCurrentPhaseKey(project) : 'development';

        const visibleTasks = state.activeAgentFilter !== null
            ? allTasks.filter((t) => t.assigned_agent.toLowerCase() === state.activeAgentFilter)
            : allTasks;

        const filterBanner = state.activeAgentFilter !== null ? `
            <div class="pb-filter-banner">
                <span class="pb-filter-banner__dot" style="background:${agentColor(state.activeAgentFilter)}"></span>
                Showing <strong>${escHtml(state.activeAgentFilter)}</strong> tasks only
                <button class="pb-filter-banner__clear" type="button" id="pb-clear-filter">Clear filter ×</button>
            </div>` : '';

        return `
            <div class="pb-kanban-wrap">
                ${buildPipelineStrip(phaseKey)}
                ${filterBanner}
                <div class="pb-kanban">
                    ${PHASE_KEYS.map((pk, idx) => buildKanbanColumn(pk, idx + 1, visibleTasks)).join('')}
                </div>
            </div>`;
    }

    function buildPipelineStrip(activePhaseKey: PhaseKey): string {
        const activePIdx = phaseIndex(activePhaseKey);
        const bubbles = PHASE_KEYS.map((pk, idx) => {
            let cls = 'pb-phase-bubble';
            if (idx < activePIdx)  cls += ' is-done';
            if (idx === activePIdx) cls += ' is-active';
            const connector = idx < PHASE_KEYS.length - 1
                ? '<div class="pb-phase-connector"></div>'
                : '';
            return `
                <div class="${cls}" title="${escHtml(PHASE_LABELS[pk])}">
                    <span class="pb-phase-bubble__num">${idx + 1}</span>
                    <span class="pb-phase-bubble__name">${escHtml(PHASE_SHORT[pk])}</span>
                </div>${connector}`;
        }).join('');
        return `<div class="pb-pipeline">${bubbles}</div>`;
    }

    function buildKanbanColumn(phaseKey: PhaseKey, num: number, allTasks: readonly BoardTask[]): string {
        const colTasks = allTasks.filter((t) => mapPhaseToKey(t.phase) === phaseKey);
        const countBadge = colTasks.length > 0
            ? `<span class="pb-col__count">${colTasks.length}</span>`
            : '';
        const cards = colTasks.length > 0
            ? colTasks.map((t) => buildTaskCard(t)).join('')
            : '<div class="pb-col__empty">No tasks</div>';
        return `
            <div class="pb-col" data-phase="${escHtml(phaseKey)}">
                <div class="pb-col__header">
                    <span class="pb-col__num">${num}</span>
                    <span class="pb-col__title">${escHtml(PHASE_LABELS[phaseKey])}</span>
                    ${countBadge}
                </div>
                <div class="pb-col__cards">${cards}</div>
            </div>`;
    }

    function buildTaskCard(t: BoardTask): string {
        const color = agentColor(t.assigned_agent);
        const statusIcon = taskStatusIcon(t.status);
        const agentName = t.assigned_agent || 'unassigned';
        const dotStyle = `background:${agentColor(agentName)}`;
        return `
            <div class="pb-card" data-task-id="${escHtml(t.id)}" style="border-left-color:${color}">
                <div class="pb-card__top">
                    ${statusIcon}
                    <span class="pb-card__title">${escHtml(t.title)}</span>
                </div>
                <div class="pb-card__agent">
                    <span class="pb-card__agent-dot" style="${dotStyle}"></span>
                    <span class="pb-card__agent-name">${escHtml(agentName)}</span>
                </div>
            </div>`;
    }

    function buildSidebar(): string {
        const projectId = state.activeTabId;
        const project = state.projects.find((p) => p.id === projectId);
        const tasks = state.tasksByProject[projectId] ?? [];
        const phaseKey = project !== undefined ? projectCurrentPhaseKey(project) : 'development' as PhaseKey;

        const tc = project?.taskCounts ?? { total: 0, pending: 0, assigned: 0, completed: 0, failed: 0 };
        const pct = tc.total > 0 ? Math.round((tc.completed / tc.total) * 100) : 0;

        const activeAgents = state.agents.map((a) => buildAgentRow(a, tasks)).join('');

        const recentSlice = state.recentEvents.slice(-5).reverse();
        const events = recentSlice.map((ev, i) => {
            const navAttr = ev.projectId !== null
                ? `data-nav-project="${escHtml(ev.projectId)}" data-event-idx="${i}"`
                : `data-event-idx="${i}"`;
            const cls = ev.projectId !== null ? 'pb-activity-row pb-activity-row--link' : 'pb-activity-row';
            const timeStr = ev.time !== '' ? `<span class="pb-activity-row__time">${escHtml(ev.time)}</span>` : '';
            return `<div class="${cls}" ${navAttr}>${timeStr}<span class="pb-activity-row__msg">${escHtml(ev.msg)}</span></div>`;
        }).join('');

        return `
            <div class="pb-sidebar">
                <div class="pb-sidebar__section">
                    <div class="pb-sidebar__section-title">Project</div>
                    <div class="pb-sidebar__metric-name">${escHtml(project?.name ?? '')}</div>
                    <div class="pb-sidebar__phase">${escHtml(PHASE_LABELS[phaseKey] ?? phaseKey)}</div>
                    <div class="pb-sidebar__progress-wrap">
                        <div class="pb-progress-bar">
                            <div class="pb-progress-fill" style="width:${pct}%"></div>
                        </div>
                        <span class="pb-progress-label">${tc.completed}/${tc.total}</span>
                    </div>
                    ${tc.failed > 0 ? `<div class="pb-sidebar__failed">${tc.failed} task${tc.failed > 1 ? 's' : ''} failed</div>` : ''}
                </div>
                <div class="pb-sidebar__section">
                    <div class="pb-sidebar__section-title">Agents</div>
                    ${activeAgents.length > 0 ? activeAgents : '<div class="pb-sidebar__empty">No active agents</div>'}
                </div>
                <div class="pb-sidebar__section">
                    <div class="pb-sidebar__section-title">Recent Activity</div>
                    ${events.length > 0 ? events : '<div class="pb-sidebar__empty">No recent events</div>'}
                </div>
            </div>`;
    }

    function buildAgentRow(agent: BoardAgent, tasks: readonly BoardTask[]): string {
        const statusCls = agent.status === 'busy'
            ? 'pb-agent-status--busy'
            : agent.status === 'error'
                ? 'pb-agent-status--error'
                : 'pb-agent-status--idle';
        const color = agentColor(agent.name);
        const currentTask = agent.currentTaskId !== undefined
            ? tasks.find((t) => t.id === agent.currentTaskId)
            : null;
        const taskTitle = currentTask?.title ?? (agent.status === 'busy' ? 'Working…' : '');
        const isActive = state.activeAgentFilter === agent.name.toLowerCase();
        const activeCls = isActive ? ' pb-agent-row--active' : '';
        const taskCount = tasks.filter((t) => t.assigned_agent.toLowerCase() === agent.name.toLowerCase()).length;
        const countBadge = taskCount > 0 ? `<span class="pb-agent-row__count">${taskCount}</span>` : '';
        return `
            <div class="pb-agent-row${activeCls}" data-filter-agent="${escHtml(agent.name.toLowerCase())}" style="cursor:pointer">
                <span class="pb-agent-status ${statusCls}" style="--agent-color:${color}"></span>
                <div class="pb-agent-info">
                    <span class="pb-agent-row__name">${escHtml(agent.name)}</span>
                    ${taskTitle ? `<span class="pb-agent-row__task">${escHtml(taskTitle)}</span>` : ''}
                </div>
                ${countBadge}
            </div>`;
    }

    // ── Task detail drawer ────────────────────────────

    let drawerEl: HTMLElement | null = null;
    let drawerKeyHandler: ((e: KeyboardEvent) => void) | null = null;

    function getOrCreateDrawer(): HTMLElement {
        if (drawerEl === null) {
            const el = document.createElement('div');
            el.className = 'pb-task-drawer';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-modal', 'true');
            host.appendChild(el);
            drawerEl = el;

            // Click outside the drawer closes it
            document.addEventListener('click', (e) => {
                if (drawerEl !== null && drawerEl.classList.contains('is-open')) {
                    if (!drawerEl.contains(e.target as Node)) {
                        closeDrawer();
                    }
                }
            }, true);
        }
        return drawerEl;
    }

    function positionDrawerNearCard(drawer: HTMLElement, anchor: HTMLElement): void {
        const DRAWER_W = 340;
        const GAP = 6;
        const ESTIMATED_H = 380;
        const rect = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Align left edge with card, clamp to viewport
        let left = rect.left;
        left = Math.min(left, vw - DRAWER_W - 8);
        left = Math.max(8, left);

        // Position below card; flip above if not enough room below
        let top = rect.bottom + GAP;
        if (top + ESTIMATED_H > vh - 8) {
            top = rect.top - ESTIMATED_H - GAP;
            top = Math.max(8, top);
        }

        drawer.style.top = `${top}px`;
        drawer.style.left = `${left}px`;
        drawer.style.bottom = 'auto';
        drawer.style.right = 'auto';
    }

    function buildPhasePips(phaseKey: string): string {
        const PHASE_ORDER = ['discovery', 'poc', 'viability', 'design', 'development', 'launch'];
        const idx = PHASE_ORDER.indexOf(phaseKey);
        return PHASE_ORDER.map((_, i) => {
            const cls = i < idx ? 'done' : i === idx ? 'active' : 'future';
            return `<span class="pb-task-drawer__pip pb-task-drawer__pip--${cls}"></span>`;
        }).join('');
    }

    function buildPriorityDots(p: number): string {
        if (p <= 0) return '';
        const level = p >= 8 ? 3 : p >= 4 ? 2 : 1;
        const label = level === 3 ? 'High' : level === 2 ? 'Medium' : 'Low';
        const color = level === 3 ? '#ef4444' : level === 2 ? '#f59e0b' : '#6b7280';
        const dots = [1, 2, 3].map((d) =>
            `<span class="pb-task-drawer__dot" style="${d <= level ? `background:${color}` : ''}"></span>`
        ).join('');
        return `${dots}<span class="pb-task-drawer__dot-label" style="color:${color}">${label}</span>`;
    }

    function showTaskDetail(task: BoardTask, anchor: HTMLElement, projectId: string | null, projectName: string | null): void {
        const drawer = getOrCreateDrawer();
        positionDrawerNearCard(drawer, anchor);

        const statusLabel = task.status.charAt(0).toUpperCase() + task.status.slice(1);
        const statusIconHtml = taskStatusIcon(task.status);
        const phaseKey = mapPhaseToKey(task.phase);
        const phaseLabel = PHASE_LABELS[phaseKey] ?? task.phase;
        const agentName = task.assigned_agent || 'unassigned';
        const agentColorVal = agentColor(agentName);
        const taskTypeLabel = task.task_type !== null && task.task_type !== ''
            ? task.task_type.replace(/_/g, ' ')
            : null;
        const shortId = task.id.length > 12 ? task.id.slice(0, 8) + '…' : task.id;

        const typeRow = taskTypeLabel !== null
            ? `<div class="pb-task-drawer__row">
                    <span class="pb-task-drawer__label">Type</span>
                    <span class="pb-task-drawer__value pb-task-drawer__type">${escHtml(taskTypeLabel)}</span>
               </div>`
            : '';

        const priorityDots = buildPriorityDots(task.priority);
        const priorityRow = priorityDots !== ''
            ? `<div class="pb-task-drawer__row">
                    <span class="pb-task-drawer__label">Priority</span>
                    <span class="pb-task-drawer__value pb-task-drawer__priority">${priorityDots}</span>
               </div>`
            : '';

        const completedRow = task.completed_at !== null && task.completed_at !== ''
            ? `<div class="pb-task-drawer__row">
                    <span class="pb-task-drawer__label">Completed</span>
                    <span class="pb-task-drawer__value">${escHtml(formatRelTime(task.completed_at))}</span>
               </div>`
            : '';

        // Output section — file path chip + response preview
        const hasOutput = task.output_path !== null || (task.response_text !== null && task.response_text.trim() !== '');
        const canOpenArtifact = task.output_path !== null && projectId !== null && api.onOpenArtifact !== undefined;
        const outputPathChip = task.output_path !== null
            ? `<${canOpenArtifact ? 'a href="#"' : 'div'} class="pb-task-drawer__output-path${canOpenArtifact ? ' pb-task-drawer__output-path--link' : ''}" title="${escHtml(task.output_path)}" data-open-artifact="1">
                   <span class="pb-task-drawer__output-icon">📄</span>
                   <span>${escHtml(truncatePath(task.output_path))}</span>
               </${canOpenArtifact ? 'a' : 'div'}>`
            : '';
        const responsePreview = task.response_text !== null && task.response_text.trim() !== ''
            ? `<div class="pb-task-drawer__response">${escHtml(task.response_text.trim().slice(0, 240))}${task.response_text.length > 240 ? '…' : ''}</div>`
            : '';
        const outputSection = hasOutput
            ? `<div class="pb-task-drawer__output-section">
                   <div class="pb-task-drawer__output-label">OUTPUT</div>
                   ${outputPathChip}
                   ${responsePreview}
               </div>`
            : '';

        drawer.innerHTML = `
            <div class="pb-task-drawer__header">
                <div class="pb-task-drawer__status pb-task-drawer__status--${escHtml(task.status)}">
                    ${statusIconHtml} ${escHtml(statusLabel)}
                </div>
                <button class="pb-task-drawer__close" type="button" aria-label="Close">×</button>
            </div>
            <div class="pb-task-drawer__title">${escHtml(task.title)}</div>
            <div class="pb-task-drawer__phase-track">
                ${buildPhasePips(phaseKey)}
                <span class="pb-task-drawer__phase-label">${escHtml(phaseLabel)}</span>
            </div>
            <div class="pb-task-drawer__meta">
                <div class="pb-task-drawer__row">
                    <span class="pb-task-drawer__label">Agent</span>
                    <span class="pb-task-drawer__value">
                        <span class="pb-task-drawer__agent-dot" style="background:${agentColorVal}"></span>
                        ${escHtml(agentName)}
                    </span>
                </div>
                ${typeRow}
                ${priorityRow}
                ${completedRow}
            </div>
            ${outputSection}
            <div class="pb-task-drawer__id">${escHtml(shortId)}</div>`;

        // Wire up close button
        drawer.querySelector('.pb-task-drawer__close')?.addEventListener('click', () => {
            closeDrawer();
        });

        // Wire output path link → artifact browser
        if (canOpenArtifact && api.onOpenArtifact !== undefined) {
            const openArtifact = api.onOpenArtifact;
            const chip = drawer.querySelector<HTMLElement>('[data-open-artifact]');
            chip?.addEventListener('click', (e) => {
                e.preventDefault();
                openArtifact(projectId as string, projectName ?? projectId as string, task.output_path);
            });
        }

        // Remove any previous key handler
        if (drawerKeyHandler !== null) {
            document.removeEventListener('keydown', drawerKeyHandler);
        }
        drawerKeyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeDrawer();
        };
        document.addEventListener('keydown', drawerKeyHandler);

        // Trigger slide-in (defer one frame so transition fires)
        requestAnimationFrame(() => {
            drawer.classList.add('is-open');
        });
    }

    function closeDrawer(): void {
        if (drawerEl !== null) {
            drawerEl.classList.remove('is-open');
        }
        if (drawerKeyHandler !== null) {
            document.removeEventListener('keydown', drawerKeyHandler);
            drawerKeyHandler = null;
        }
    }

    // ── Event binding ─────────────────────────────────

    function bindEvents(): void {
        // Tab switching
        root.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
            el.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                // If the close button was clicked, don't switch tab
                if (target.closest('[data-close-tab]') !== null) return;
                const tabId = el.dataset['tab'];
                if (tabId !== undefined) {
                    switchTab(tabId);
                }
            });
        });

        // Close tab buttons
        root.querySelectorAll<HTMLElement>('[data-close-tab]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const tabId = el.dataset['closeTab'];
                if (tabId !== undefined) {
                    closeTab(tabId);
                }
            });
        });

        // Open project from All Projects grid
        root.querySelectorAll<HTMLElement>('[data-open-project]').forEach((el) => {
            el.addEventListener('click', () => {
                const pid = el.dataset['openProject'];
                if (pid !== undefined) {
                    void openProjectTab(pid);
                }
            });
        });

        // Refresh button
        root.querySelector('#pb-refresh-btn')?.addEventListener('click', () => {
            void doRefresh();
        });

        // Clickable activity rows in sidebar
        root.querySelectorAll<HTMLElement>('[data-nav-project]').forEach((el) => {
            el.addEventListener('click', () => {
                const pid = el.dataset['navProject'];
                if (pid !== undefined) {
                    void openProjectTab(pid);
                }
            });
        });

        // Agent filter clicks
        root.querySelectorAll<HTMLElement>('[data-filter-agent]').forEach((el) => {
            el.addEventListener('click', () => {
                const agentName = el.dataset['filterAgent'] ?? null;
                if (agentName === null) return;
                const next = state.activeAgentFilter === agentName ? null : agentName;
                state = { ...state, activeAgentFilter: next };
                render();
            });
        });

        // Clear filter button in banner
        root.querySelector('#pb-clear-filter')?.addEventListener('click', () => {
            state = { ...state, activeAgentFilter: null };
            render();
        });

        // Task card clicks
        root.querySelectorAll<HTMLElement>('[data-task-id]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const taskId = el.dataset['taskId'];
                if (taskId === undefined) return;
                let found: BoardTask | null = null;
                let foundProjectId: string | null = null;
                for (const [pid, tasks] of Object.entries(state.tasksByProject)) {
                    const match = tasks.find((t) => t.id === taskId);
                    if (match !== undefined) { found = match; foundProjectId = pid; break; }
                }
                if (found !== null) {
                    const proj = foundProjectId !== null
                        ? state.projects.find((p) => p.id === foundProjectId) ?? null
                        : null;
                    showTaskDetail(found, el, foundProjectId, proj?.name ?? null);
                }
            });
        });
    }

    function switchTab(tabId: string): void {
        state = { ...state, activeTabId: tabId, activeAgentFilter: null };
        render();
    }

    function closeTab(projectId: string): void {
        const openTabs = state.openTabs.filter((id) => id !== projectId);
        const activeTabId = state.activeTabId === projectId
            ? (openTabs[openTabs.length - 1] ?? 'all')
            : state.activeTabId;
        state = { ...state, openTabs, activeTabId };
        render();
    }

    async function openProjectTab(projectId: string): Promise<void> {
        const alreadyOpen = state.openTabs.includes(projectId);
        const openTabs = alreadyOpen ? state.openTabs : [...state.openTabs, projectId];
        state = { ...state, openTabs, activeTabId: projectId };
        render();

        // Load tasks if not yet fetched
        if (state.tasksByProject[projectId] === undefined) {
            await loadProjectTasks(projectId);
        }
    }

    async function loadProjectTasks(projectId: string): Promise<void> {
        try {
            const tasks = await api.getProjectTasks(projectId);
            state = {
                ...state,
                tasksByProject: { ...state.tasksByProject, [projectId]: tasks },
            };
            render();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[ProjectBoard] Failed to load tasks:', msg);
        }
    }

    // ── Data loading ──────────────────────────────────

    async function doRefresh(): Promise<void> {
        state = { ...state, loading: true, error: null };
        render();
        try {
            const [projects, agents] = await Promise.all([
                api.listProjects(),
                api.getAgents(),
            ]);
            // Reload tasks for all open tabs
            const taskEntries = await Promise.all(
                state.openTabs.map(async (pid) => {
                    try {
                        const tasks = await api.getProjectTasks(pid);
                        return [pid, tasks] as const;
                    } catch {
                        return [pid, state.tasksByProject[pid] ?? []] as const;
                    }
                }),
            );
            const tasksByProject = taskEntries.reduce<Record<string, readonly BoardTask[]>>(
                (acc, [pid, tasks]) => ({ ...acc, [pid]: tasks }),
                { ...state.tasksByProject },
            );
            state = { ...state, projects, agents, tasksByProject, loading: false };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            state = { ...state, loading: false, error: `Failed to load: ${msg}` };
        }
        render();
    }

    // ── Activity event subscription ───────────────────

    function extractProjectId(ev: { channel?: string; data?: unknown }): string | null {
        if (ev.data === null || typeof ev.data !== 'object') return null;
        const d = ev.data as Record<string, unknown>;
        return typeof d['projectId'] === 'string' ? d['projectId'] : null;
    }

    function extractTaskId(ev: { channel?: string; data?: unknown }): string | null {
        if (ev.data === null || typeof ev.data !== 'object') return null;
        const d = ev.data as Record<string, unknown>;
        return typeof d['taskId'] === 'string' ? d['taskId'] : null;
    }

    const unsubscribe = api.onActivityEvent((rawEvent) => {
        if (destroyed) return;
        const ev = rawEvent as { message?: string; time?: string; channel?: string; data?: unknown };
        const stored: StoredEvent = {
            msg: ev.message ?? String(ev.data ?? ''),
            time: ev.time ?? '',
            projectId: extractProjectId(ev),
            taskId: extractTaskId(ev),
            channel: ev.channel ?? null,
        };
        state = { ...state, recentEvents: [...state.recentEvents, stored].slice(-50) };
        // Refresh task data for the active project tab on task-related events
        if (state.activeTabId !== 'all') {
            void loadProjectTasks(state.activeTabId);
        }
        if (state.activeTabId === 'all' || state.openTabs.includes(state.activeTabId)) {
            render();
        }
    });

    // ── Initial load ──────────────────────────────────

    void doRefresh();

    // ── Handle ────────────────────────────────────────

    return {
        refresh: doRefresh,
        destroy(): void {
            destroyed = true;
            unsubscribe();
            if (drawerKeyHandler !== null) {
                document.removeEventListener('keydown', drawerKeyHandler);
                drawerKeyHandler = null;
            }
            host.innerHTML = '';
        },
    };
}
