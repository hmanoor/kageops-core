/**
 * KageOps Phase Graph Panel — RAG-style interactive lifecycle graph.
 * Pure TypeScript + SVG, no external dependencies.
 */

// ── Types ────────────────────────────────────────────

export interface PhaseGraphData {
    readonly phases: readonly string[];
    readonly phaseCounts: ReadonlyArray<{ readonly phase: string; readonly total: string; readonly completed: string; readonly failed: string }>;
    readonly agentTaskRows: ReadonlyArray<{ readonly assigned_agent: string; readonly title: string; readonly status: string; readonly phase: string; readonly id: string }>;
    readonly recentTasks: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string; readonly phase: string; readonly assigned_agent: string; readonly started_at: string | null; readonly completed_at: string | null }>;
}

export interface PhaseGraphCallbacks {
    readonly getPhaseGraph: (projectId: string) => Promise<PhaseGraphData>;
    readonly onAgentClick: (agentName: string) => void;
    readonly onTaskClick: (taskId: string) => void;
}

// ── Constants ────────────────────────────────────────

const PHASE_LABELS: Readonly<Record<string, string>> = {
    discovery: 'Discovery', poc: 'POC', 'business-viability': 'Biz Viability',
    'design-planning': 'Design & Plan', development: 'Development', 'launch-growth': 'Launch',
};
const PHASE_X: Readonly<Record<string, number>> = {
    discovery: 80, poc: 200, 'business-viability': 320,
    'design-planning': 440, development: 560, 'launch-growth': 680,
};
const PHASE_Y = 110;
const AGENT_PHASE: Readonly<Record<string, string>> = {
    scout: 'discovery', cipher: 'poc', blueprint: 'design-planning', pixel: 'design-planning',
    forge: 'development', vigil: 'development', aegis: 'launch-growth', herald: 'launch-growth',
};
const PHASE_ORDER = ['discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth'] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Helpers ───────────────────────────────────────────

function phaseColor(c: number, t: number, f: number): string {
    if (t === 0) return '#4b5563';
    if (f > 0) return '#ef4444';
    if (c === t) return '#22c55e';
    if (c > 0) return '#f59e0b';
    return '#3b82f6';
}
function statusColor(s: string): string {
    if (s === 'completed') return '#22c55e';
    if (s === 'failed') return '#ef4444';
    if (s === 'assigned' || s === 'in_progress') return '#f59e0b';
    return '#4b5563';
}
function isActive(s: string): boolean { return s === 'assigned' || s === 'in_progress'; }

function ensurePulseStyle(): void {
    const id = 'kageops-phase-graph-style';
    if (document.getElementById(id) !== null) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = [
        '@keyframes kageops-pulse{0%,100%{opacity:1}50%{opacity:0.4}}',
        '.node-active{animation:kageops-pulse 2s ease-in-out infinite}',
        '.phase-node{transition:transform 0.2s ease,filter 0.2s ease}',
        '.phase-node:hover{filter:brightness(1.3)}',
    ].join('');
    document.head.appendChild(style);
}

function svgEl(tag: string): SVGElement { return document.createElementNS(SVG_NS, tag) as SVGElement; }

function makeLine(x1: number, y1: number, x2: number, y2: number, stroke: string, sw: number, dash?: string): SVGElement {
    const el = svgEl('line');
    el.setAttribute('x1', String(x1)); el.setAttribute('y1', String(y1));
    el.setAttribute('x2', String(x2)); el.setAttribute('y2', String(y2));
    el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', String(sw));
    if (dash !== undefined) el.setAttribute('stroke-dasharray', dash);
    return el;
}
function makeText(x: number, y: number, text: string, size: number, fill: string): SVGElement {
    const el = svgEl('text');
    el.setAttribute('x', String(x)); el.setAttribute('y', String(y));
    el.setAttribute('text-anchor', 'middle'); el.setAttribute('font-size', String(size));
    el.setAttribute('fill', fill); el.setAttribute('font-family', '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif');
    el.textContent = text;
    return el;
}
function positionTooltip(tip: HTMLElement, e: MouseEvent): void {
    const p = tip.parentElement;
    if (p === null) return;
    const r = p.getBoundingClientRect();
    let l = e.clientX - r.left + 12, t = e.clientY - r.top + 12;
    if (l + 210 > p.clientWidth) l = e.clientX - r.left - 220;
    if (t + 80 > p.clientHeight) t = e.clientY - r.top - 80;
    tip.style.left = `${l}px`; tip.style.top = `${t}px`;
}

// ── SVG builder ───────────────────────────────────────

interface ViewState { panX: number; panY: number; scale: number }
function applyTransform(g: SVGGElement, vs: ViewState): void {
    g.setAttribute('transform', `translate(${vs.panX},${vs.panY}) scale(${vs.scale})`);
}

function buildSvg(
    data: PhaseGraphData,
    expandedPhases: ReadonlySet<string>,
    callbacks: PhaseGraphCallbacks,
    tooltip: HTMLElement,
): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', '0 0 780 380');

    // Lookup maps
    const phaseCounts = new Map(data.phaseCounts.map((pc) => [pc.phase, {
        total: parseInt(pc.total, 10) || 0,
        completed: parseInt(pc.completed, 10) || 0,
        failed: parseInt(pc.failed, 10) || 0,
    }]));
    const agentStatus = new Map<string, string>();
    for (const row of data.agentTaskRows) {
        if (!agentStatus.has(row.assigned_agent) || row.status === 'assigned') {
            agentStatus.set(row.assigned_agent, row.status);
        }
    }
    const agentTasks = new Map<string, typeof data.recentTasks[number][]>();
    for (const t of data.recentTasks) {
        const list = agentTasks.get(t.assigned_agent) ?? [];
        if (list.length < 3) agentTasks.set(t.assigned_agent, [...list, t]);
    }

    // Phase→phase connectors — thinner, subtler, with gradient feel
    for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
        const x1 = (PHASE_X[PHASE_ORDER[i]] ?? 80) + 32;
        const x2 = (PHASE_X[PHASE_ORDER[i + 1]] ?? 200) - 32;
        const cnt1 = phaseCounts.get(PHASE_ORDER[i]) ?? { total: 0, completed: 0, failed: 0 };
        const connColor = cnt1.completed === cnt1.total && cnt1.total > 0 ? '#22c55e' : '#4b5563';
        svg.appendChild(makeLine(x1, PHASE_Y, x2, PHASE_Y, connColor, 2));
        const arr = svgEl('polygon');
        arr.setAttribute('points', `${x2},${PHASE_Y} ${x2 - 7},${PHASE_Y - 3.5} ${x2 - 7},${PHASE_Y + 3.5}`);
        arr.setAttribute('fill', connColor);
        svg.appendChild(arr);
    }

    // Phase nodes
    for (const phase of PHASE_ORDER) {
        const cx = PHASE_X[phase] ?? 80, cy = PHASE_Y;
        const cnt = phaseCounts.get(phase) ?? { total: 0, completed: 0, failed: 0 };
        const color = phaseColor(cnt.completed, cnt.total, cnt.failed);
        const active = cnt.total > 0 && cnt.completed < cnt.total && cnt.failed === 0;
        const done = cnt.total > 0 && cnt.completed === cnt.total;
        const label = PHASE_LABELS[phase] ?? phase;

        // Outer glow ring for active/done phases
        if (active || done) {
            const ring = svgEl('circle');
            ring.setAttribute('cx', String(cx)); ring.setAttribute('cy', String(cy));
            ring.setAttribute('r', '36'); ring.setAttribute('fill', 'none');
            ring.setAttribute('stroke', color); ring.setAttribute('stroke-width', '1.5');
            ring.setAttribute('opacity', active ? '0.4' : '0.25');
            if (active) ring.classList.add('node-active');
            svg.appendChild(ring);
        }

        // Main phase circle — higher fill opacity for better contrast
        const circle = svgEl('circle') as SVGCircleElement;
        circle.setAttribute('cx', String(cx)); circle.setAttribute('cy', String(cy));
        circle.setAttribute('r', '30'); circle.setAttribute('fill', color);
        circle.setAttribute('fill-opacity', done ? '0.25' : '0.18');
        circle.setAttribute('stroke', color); circle.setAttribute('stroke-width', '2.5');
        circle.style.cursor = 'pointer';
        circle.classList.add('phase-node');
        if (active) circle.classList.add('node-active');

        // Phase label inside circle (centered)
        svg.appendChild(makeText(cx, cy + 1, label, 9, '#e6edf3'));
        // Completion count below label inside circle
        if (cnt.total > 0) svg.appendChild(makeText(cx, cy + 14, `${cnt.completed}/${cnt.total}`, 8, '#8b949e'));
        // Phase name below the circle
        svg.appendChild(makeText(cx, cy + 50, label, 10, '#8b949e'));
        // Expand indicator
        svg.appendChild(makeText(cx + 26, cy - 22, expandedPhases.has(phase) ? '\u25b2' : '\u25bc', 8, '#6b7280'));

        circle.addEventListener('click', () => {
            circle.dispatchEvent(new CustomEvent('phase-toggle', { bubbles: true, detail: { phase } }));
        });
        const showPhaseTip = (e: MouseEvent): void => {
            const pct = cnt.total > 0 ? Math.round((cnt.completed / cnt.total) * 100) : 0;
            tooltip.innerHTML = `<strong>${label}</strong><br>${cnt.completed}/${cnt.total} tasks (${pct}%)`;
            tooltip.style.display = 'block';
            positionTooltip(tooltip, e);
        };
        circle.addEventListener('mousemove', showPhaseTip);
        circle.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
        svg.appendChild(circle);

        if (!expandedPhases.has(phase)) continue;

        // Agent nodes
        const agents = Object.entries(AGENT_PHASE).filter(([, p]) => p === phase).map(([n]) => n);
        agents.forEach((agentName, idx) => {
            const offset = (idx - (agents.length - 1) / 2) * 44;
            const ax = cx + offset, ay = cy + 90;
            const aStatus = agentStatus.get(agentName) ?? 'idle';
            const aColor = statusColor(aStatus);

            svg.insertBefore(makeLine(cx, cy + 30, ax, ay - 16, '#374151', 1), svg.firstChild);

            const aCircle = svgEl('circle');
            aCircle.setAttribute('cx', String(ax)); aCircle.setAttribute('cy', String(ay));
            aCircle.setAttribute('r', '16'); aCircle.setAttribute('fill', aColor);
            aCircle.setAttribute('fill-opacity', '0.2'); aCircle.setAttribute('stroke', aColor);
            aCircle.setAttribute('stroke-width', '1.5'); aCircle.style.cursor = 'pointer';
            if (isActive(aStatus)) aCircle.classList.add('node-active');

            aCircle.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onAgentClick(agentName); });
            aCircle.addEventListener('mousemove', (e) => {
                tooltip.innerHTML = `<strong>${agentName}</strong><br>Status: ${aStatus}`;
                tooltip.style.display = 'block';
                positionTooltip(tooltip, e);
            });
            aCircle.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
            svg.appendChild(aCircle);
            svg.appendChild(makeText(ax, ay + 4, agentName.slice(0, 5), 8, '#e6edf3'));

            // Task squares
            const tasks = agentTasks.get(agentName) ?? [];
            tasks.forEach((task, ti) => {
                const tx = ax + (ti - (tasks.length - 1) / 2) * 28, ty = ay + 48;
                svg.insertBefore(makeLine(ax, ay + 16, tx + 6, ty, '#374151', 1, '3 3'), svg.firstChild);
                const tRect = svgEl('rect');
                tRect.setAttribute('x', String(tx)); tRect.setAttribute('y', String(ty));
                tRect.setAttribute('width', '12'); tRect.setAttribute('height', '12');
                tRect.setAttribute('rx', '2'); tRect.setAttribute('fill', statusColor(task.status));
                tRect.setAttribute('fill-opacity', '0.25'); tRect.setAttribute('stroke', statusColor(task.status));
                tRect.setAttribute('stroke-width', '1'); tRect.style.cursor = 'pointer';
                if (isActive(task.status)) tRect.classList.add('node-active');
                tRect.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onTaskClick(task.id); });
                tRect.addEventListener('mousemove', (e) => {
                    const short = task.title.length > 40 ? task.title.slice(0, 40) + '…' : task.title;
                    tooltip.innerHTML = `<strong>${short}</strong><br>Status: ${task.status}`;
                    tooltip.style.display = 'block';
                    positionTooltip(tooltip, e);
                });
                tRect.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
                svg.appendChild(tRect);
            });
        });
    }
    return svg;
}

// ── Public entry point ────────────────────────────────

export function renderPhaseGraphPanel(
    container: HTMLElement,
    projectId: string,
    projectName: string,
    callbacks: PhaseGraphCallbacks,
): void {
    ensurePulseStyle();
    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'phase-graph-header';
    const title = document.createElement('span');
    title.className = 'phase-graph-title';
    title.textContent = `Phase Graph — ${projectName}`;
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn-secondary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText = 'font-size:11px;padding:2px 8px';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'phase-graph-close';
    closeBtn.textContent = '×'; closeBtn.title = 'Close';
    header.appendChild(title); header.appendChild(refreshBtn); header.appendChild(closeBtn);
    container.appendChild(header);

    // Canvas + tooltip
    const canvas = document.createElement('div');
    canvas.className = 'phase-graph-canvas';
    container.appendChild(canvas);
    const tooltip = document.createElement('div');
    tooltip.className = 'phase-graph-tooltip';
    tooltip.style.display = 'none';
    canvas.appendChild(tooltip);

    closeBtn.addEventListener('click', () => {
        const section = container.closest('section') as HTMLElement | null;
        if (section !== null) section.style.display = 'none';
    });

    // State
    let viewState: ViewState = { panX: 0, panY: 0, scale: 1 };
    let expandedPhases = new Set<string>();
    let currentSvg: SVGSVGElement | null = null;

    function renderGraph(data: PhaseGraphData): void {
        if (currentSvg !== null && canvas.contains(currentSvg)) canvas.removeChild(currentSvg);

        const svg = buildSvg(data, expandedPhases, callbacks, tooltip);
        const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        while (svg.firstChild !== null) g.appendChild(svg.firstChild);
        svg.appendChild(g);
        applyTransform(g, viewState);

        svg.addEventListener('phase-toggle', (rawEvt) => {
            const phase = (rawEvt as CustomEvent<{ phase: string }>).detail.phase;
            const next = new Set(expandedPhases);
            if (next.has(phase)) { next.delete(phase); } else { next.add(phase); }
            expandedPhases = next;
            renderGraph(data);
        });

        // Pan
        let dragging = false, lastX = 0, lastY = 0;
        svg.addEventListener('mousedown', (e) => {
            const tag = (e.target as SVGElement).tagName;
            if (tag === 'circle' || tag === 'rect' || tag === 'text') return;
            dragging = true; lastX = e.clientX; lastY = e.clientY;
            svg.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            viewState = { ...viewState, panX: viewState.panX + (e.clientX - lastX), panY: viewState.panY + (e.clientY - lastY) };
            lastX = e.clientX; lastY = e.clientY;
            applyTransform(g, viewState);
        });
        window.addEventListener('mouseup', () => { if (dragging) { dragging = false; svg.style.cursor = 'grab'; } });
        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const newScale = Math.max(0.4, Math.min(3, viewState.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
            viewState = { ...viewState, scale: newScale };
            applyTransform(g, viewState);
        }, { passive: false });

        currentSvg = svg;
        canvas.insertBefore(svg, tooltip);
    }

    const loadData = (): void => {
        void callbacks.getPhaseGraph(projectId)
            .then((data) => { renderGraph(data); })
            .catch(() => { renderGraph({ phases: [], phaseCounts: [], agentTaskRows: [], recentTasks: [] }); });
    };

    refreshBtn.addEventListener('click', () => { viewState = { panX: 0, panY: 0, scale: 1 }; loadData(); });
    loadData();
}
