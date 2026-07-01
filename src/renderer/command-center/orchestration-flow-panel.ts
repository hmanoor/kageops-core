/**
 * KageOps — Orchestration Flow Panel (v2)
 *
 * N8N-inspired horizontal pipeline canvas:
 *   • Phase strip across the top (Discovery → Launch)
 *   • Sensei card on the left, 8 agent cards in a 4×2 grid on the right
 *   • Bezier edges from Sensei to each agent, animated when the agent is busy
 *   • Pan (drag) + zoom (wheel) + reset, with a mini-map in the corner
 *
 * Public API is unchanged — same exports, same callbacks — so callers
 * (command-center.ts, dispatchers that call __pushFlowEvent) keep working.
 */

import { SIGIL_INNER, toAutonautId } from './sigils';

// ── Types ────────────────────────────────────────────

interface AgentNode {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly color: string;
    readonly phase: string; // primary phase column
}

export interface FlowAgentState {
    readonly name: string;
    readonly status: 'idle' | 'busy' | 'error';
    readonly currentTask: string | null;
}

export interface FlowEvent {
    readonly from: string;
    readonly to: string;
    readonly label: string;
    readonly time: number;
}

export interface OrchestrationFlowCallbacks {
    readonly getAgentStates: () => readonly FlowAgentState[];
    readonly getCurrentPhase?: () => string | null;
    readonly onAgentClick?: (agentName: string) => void;
    readonly onFullscreen?: () => void;
}

// ── Constants ────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

// World coordinates — large so we can pan/zoom inside.
// Square-ish so the radial layout reads as a true ring instead of
// being squashed horizontally.
const WORLD_W = 920;
const WORLD_H = 720;

// Sensei sits dead-centre; agents orbit it on a ring.
const CENTER_X = WORLD_W / 2;
const CENTER_Y = WORLD_H / 2;

const SENSEI_W = 180;
const SENSEI_H = 160;
const SENSEI_X = CENTER_X - SENSEI_W / 2;
const SENSEI_Y = CENTER_Y - SENSEI_H / 2;

// Agent ring — 8 evenly-spaced cards around Sensei.
const AGENT_RING_R = 290;
const CARD_W = 180;
const CARD_H = 116;

// Legacy grid constants kept (unused by the new layout but referenced
// by other helpers / tests). The ring layout supersedes them.
const GRID_COLS = 4;
const GRID_ROWS = 2;
const COL_GAP = 60;
const ROW_GAP = 80;
const GRID_X = 420;
const GRID_Y = 140;

const REFRESH_INTERVAL = 2500;

const PHASES: readonly { readonly id: string; readonly label: string }[] = [
    { id: 'discovery', label: 'Discovery' },
    { id: 'poc', label: 'POC' },
    { id: 'business', label: 'Business' },
    { id: 'design', label: 'Design' },
    { id: 'development', label: 'Development' },
    { id: 'launch', label: 'Launch' },
];

const AGENTS: readonly AgentNode[] = [
    { id: 'scout',     name: 'Scout',     role: 'Strategist',  color: '#6BCB77', phase: 'discovery' },
    { id: 'blueprint', name: 'Blueprint', role: 'Architect',   color: '#3B82F6', phase: 'design' },
    { id: 'pixel',     name: 'Pixel',     role: 'Designer',    color: '#D946EF', phase: 'design' },
    { id: 'forge',     name: 'Forge',     role: 'Engineer',    color: 'oklch(0.66 0.12 150)', phase: 'development' },
    { id: 'cipher',    name: 'Cipher',    role: 'Data',        color: '#7C3AED', phase: 'development' },
    { id: 'aegis',     name: 'Aegis',     role: 'Platform',    color: '#94A3B8', phase: 'launch' },
    { id: 'vigil',     name: 'Vigil',     role: 'QA Guardian', color: '#10B981', phase: 'development' },
    { id: 'herald',    name: 'Herald',    role: 'Marketer',    color: '#DC2626', phase: 'launch' },
];

// ── Helpers ─────────────────────────────────────────

function svgEl<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {}
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}

/**
 * Append an Autonaut sigil glyph to an SVG parent at (cx, cy) with the
 * given visual diameter. Sigil paths are taken from the canonical
 * `SIGIL_INNER` map; color is wired via inline `color:` style so
 * `currentColor` resolves to the agent's accent. Falls back to a small
 * filled circle for unknown agent IDs.
 */
function appendSigil(
    parent: SVGElement,
    agentId: string,
    cx: number,
    cy: number,
    diameter: number,
    color: string,
): void {
    const id = toAutonautId(agentId);
    const inner = id !== null
        ? SIGIL_INNER[id]
        : '<circle cx="12" cy="12" r="6" fill="currentColor"></circle>';
    const scale = diameter / 24;
    const g = svgEl('g', {
        transform: `translate(${cx - diameter / 2}, ${cy - diameter / 2}) scale(${scale})`,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.5',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        style: `color: ${color};`,
    });
    g.innerHTML = inner;
    parent.appendChild(g);
}

function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Place agents on a ring around Sensei. Idx 0 starts at the top
 * (-90°) and walks clockwise, 360°/N apart. Returns the top-left
 * corner of the agent card so the rest of the renderer can keep
 * using its existing rect-based maths.
 */
function agentPosition(idx: number): { readonly x: number; readonly y: number } {
    const N = AGENTS.length;
    const angleDeg = -90 + (idx * 360) / N;
    const angle = (angleDeg * Math.PI) / 180;
    return {
        x: CENTER_X + AGENT_RING_R * Math.cos(angle) - CARD_W / 2,
        y: CENTER_Y + AGENT_RING_R * Math.sin(angle) - CARD_H / 2,
    };
}

/**
 * Straight-line edge from Sensei's perimeter to the nearest edge
 * of the agent card. Each end uses a per-direction inset computed
 * from the rectangle the line is actually meeting, so the line
 * never draws through Sensei or punches into the agent card.
 */
function radialEdge(x1: number, y1: number, x2: number, y2: number): string {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const ux = dx / dist;
    const uy = dy / dist;
    const senseiInset = rectIntersectInset(SENSEI_W, SENSEI_H, ux, uy);
    const cardInset = rectIntersectInset(CARD_W, CARD_H, ux, uy);
    const sx = x1 + ux * senseiInset;
    const sy = y1 + uy * senseiInset;
    const ex = x2 - ux * cardInset;
    const ey = y2 - uy * cardInset;
    return `M ${sx} ${sy} L ${ex} ${ey}`;
}

/**
 * Distance from a centred rectangle's centre to its edge along the
 * unit vector (ux, uy). Used to clip the start/end of radial edges
 * so they meet card edges, not centres.
 */
function rectIntersectInset(w: number, h: number, ux: number, uy: number): number {
    const ax = Math.abs(ux);
    const ay = Math.abs(uy);
    const tx = ax === 0 ? Infinity : (w / 2) / ax;
    const ty = ay === 0 ? Infinity : (h / 2) / ay;
    return Math.min(tx, ty);
}

/** Kept for compatibility — call sites switched to radialEdge below. */
function bezierH(x1: number, y1: number, x2: number, y2: number): string {
    return radialEdge(x1, y1, x2, y2);
}

// ── Render ───────────────────────────────────────────

export function renderOrchestrationFlow(
    container: HTMLElement,
    callbacks: OrchestrationFlowCallbacks
): { readonly refresh: () => void; readonly setFullscreen: (on: boolean) => void } {
    container.innerHTML = '';

    const canvas = document.createElement('div');
    canvas.className = 'orch-flow-canvas';
    container.appendChild(canvas);

    // Phase strip (top-left chrome)
    const phaseBar = document.createElement('div');
    phaseBar.className = 'orch-flow-phasebar';
    canvas.appendChild(phaseBar);

    // Zoom/pan controls (top-right chrome)
    const controls = document.createElement('div');
    controls.className = 'orch-flow-controls';
    controls.innerHTML = `
        <button class="orch-flow-ctrl-btn" data-action="zoom-out" title="Zoom out">−</button>
        <span class="orch-flow-zoom-readout">100%</span>
        <button class="orch-flow-ctrl-btn" data-action="zoom-in" title="Zoom in">+</button>
        <button class="orch-flow-ctrl-btn" data-action="reset" title="Reset view">⟲</button>
        <span class="orch-flow-ctrl-sep"></span>
        <button class="orch-flow-ctrl-btn orch-flow-ctrl-btn--fs" data-action="fullscreen" title="Expand to fullscreen">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 1H1v3M11 4V1H8M8 11h3V8M1 8v3h3"/>
            </svg>
        </button>
    `;
    canvas.appendChild(controls);

    // Status bar (bottom-left chrome)
    const statusBar = document.createElement('div');
    statusBar.className = 'orch-flow-statusbar';
    statusBar.innerHTML = `<span class="status-dot"></span><span class="status-text">All agents standing by</span>`;
    canvas.appendChild(statusBar);

    // Mini-map (bottom-right chrome)
    const minimap = document.createElement('div');
    minimap.className = 'orch-flow-minimap';
    canvas.appendChild(minimap);

    // Pannable/zoomable viewport
    const viewport = document.createElement('div');
    viewport.className = 'orch-flow-viewport';
    canvas.appendChild(viewport);

    // ── Pan/zoom state ───────────────────────────────
    let scale = 1;
    let tx = 0;
    let ty = 0;
    const MIN_SCALE = 0.4;
    const MAX_SCALE = 2.0;

    function applyTransform(): void {
        // Round translate to integer pixels so SVG content lands on
        // exact pixel boundaries — prevents the soft anti-aliased
        // look that comes from sub-pixel transforms at fractional
        // scale. The readout still shows the unrounded scale percent.
        const tx2 = Math.round(tx);
        const ty2 = Math.round(ty);
        viewport.style.transform = `translate(${tx2}px, ${ty2}px) scale(${scale})`;
        const readout = controls.querySelector('.orch-flow-zoom-readout');
        if (readout !== null) readout.textContent = `${Math.round(scale * 100)}%`;
        updateMinimapViewport();
    }

    function setScale(next: number, anchorX?: number, anchorY?: number): void {
        const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
        if (clamped === scale) return;
        if (anchorX !== undefined && anchorY !== undefined) {
            // Zoom toward cursor: keep the world point under the cursor stationary
            const wx = (anchorX - tx) / scale;
            const wy = (anchorY - ty) / scale;
            scale = clamped;
            tx = anchorX - wx * scale;
            ty = anchorY - wy * scale;
        } else {
            scale = clamped;
        }
        applyTransform();
    }

    function resetView(): void {
        // Fit world width to canvas width, centered vertically
        const rect = canvas.getBoundingClientRect();
        const fitScale = Math.min(rect.width / WORLD_W, rect.height / WORLD_H, 1);
        scale = fitScale;
        tx = (rect.width - WORLD_W * scale) / 2;
        ty = (rect.height - WORLD_H * scale) / 2;
        applyTransform();
    }

    // Wheel zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const ax = e.clientX - rect.left;
        const ay = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        setScale(scale * factor, ax, ay);
    }, { passive: false });

    // Drag pan
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginTx = 0;
    let dragOriginTy = 0;

    canvas.addEventListener('mousedown', (e) => {
        // Don't start a pan when the user clicked an agent card or a control
        const target = e.target as Element;
        if (target.closest('.orch-agent-node') !== null) return;
        if (target.closest('.orch-flow-controls') !== null) return;
        isDragging = true;
        canvas.classList.add('is-panning');
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragOriginTx = tx;
        dragOriginTy = ty;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        tx = dragOriginTx + (e.clientX - dragStartX);
        ty = dragOriginTy + (e.clientY - dragStartY);
        applyTransform();
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            canvas.classList.remove('is-panning');
        }
    });

    // Control buttons
    controls.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const btn = target.closest('[data-action]') as HTMLElement | null;
        const action = btn?.dataset['action'];
        const rect = canvas.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        if (action === 'zoom-in') setScale(scale * 1.2, cx, cy);
        else if (action === 'zoom-out') setScale(scale / 1.2, cx, cy);
        else if (action === 'reset') resetView();
        else if (action === 'fullscreen') callbacks.onFullscreen?.();
    });

    // ── Event log (consumed by the SVG layer) ───────
    const recentEvents: FlowEvent[] = [];
    const MAX_EVENTS = 12;

    function pushEvent(event: FlowEvent): void {
        recentEvents.push(event);
        if (recentEvents.length > MAX_EVENTS) {
            recentEvents.splice(0, recentEvents.length - MAX_EVENTS);
        }
    }
    (canvas as unknown as Record<string, unknown>)['__pushFlowEvent'] = pushEvent;

    // ── SVG building blocks ──────────────────────────

    function buildDefs(): SVGDefsElement {
        const defs = svgEl('defs');

        // Soft glow for active agents
        const glow = svgEl('filter', {
            id: 'card-glow', x: '-30%', y: '-30%', width: '160%', height: '160%',
        });
        glow.appendChild(svgEl('feGaussianBlur', { stdDeviation: '6', result: 'b' }));
        const merge = svgEl('feMerge');
        merge.appendChild(svgEl('feMergeNode', { in: 'b' }));
        merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
        glow.appendChild(merge);
        defs.appendChild(glow);

        // Per-agent edge gradient
        for (const agent of AGENTS) {
            const grad = svgEl('linearGradient', {
                id: `edge-grad-${agent.id}`,
                gradientUnits: 'userSpaceOnUse',
            });
            grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'rgba(255,165,0,0.0)' }));
            grad.appendChild(svgEl('stop', { offset: '40%', 'stop-color': `${agent.color}80` }));
            grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': agent.color }));
            defs.appendChild(grad);
        }

        // Sensei radial (gold)
        const senseiGrad = svgEl('radialGradient', { id: 'sensei-bg', cx: '40%', cy: '40%', r: '70%' });
        senseiGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'rgba(212,175,55,0.20)' }));
        senseiGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'rgba(212,175,55,0.04)' }));
        defs.appendChild(senseiGrad);

        // Animation styles
        const style = svgEl('style');
        style.textContent = `
            @keyframes flowDash { to { stroke-dashoffset: -32; } }
            @keyframes nodeBreath { 0%,100% { opacity: 0.45; } 50% { opacity: 1; } }
            @keyframes idlePulse { 0%,100% { opacity: 0.15; } 50% { opacity: 0.32; } }
            @keyframes senseiAura { 0%,100% { opacity: 0.12; } 50% { opacity: 0.24; } }
            @keyframes edgeAmbient { to { stroke-dashoffset: -32; } }
            .edge-flow { animation: flowDash 1.4s linear infinite; }
            .node-breath { animation: nodeBreath 2.4s ease-in-out infinite; }
            .idle-dot { animation: idlePulse 4.5s ease-in-out infinite; }
            .sensei-ring-idle { animation: senseiAura 3.8s ease-in-out infinite; }
            .edge-ambient { animation: edgeAmbient 9s linear infinite; }
        `;
        defs.appendChild(style);

        return defs;
    }

    function senseiAnchor(): { readonly x: number; readonly y: number } {
        return { x: CENTER_X, y: CENTER_Y };
    }

    function cardAnchor(idx: number): { readonly x: number; readonly y: number } {
        const pos = agentPosition(idx);
        return { x: pos.x + CARD_W / 2, y: pos.y + CARD_H / 2 };
    }

    function renderEdges(
        svg: SVGSVGElement,
        stateMap: ReadonlyMap<string, FlowAgentState>
    ): void {
        const g = svgEl('g', { class: 'edges-layer' });
        const start = senseiAnchor();

        AGENTS.forEach((agent, idx) => {
            const end = cardAnchor(idx);
            const state = stateMap.get(agent.id);
            const isBusy = state?.status === 'busy';
            const isError = state?.status === 'error';

            const d = bezierH(start.x, start.y, end.x, end.y);

            const base = svgEl('path', {
                d,
                fill: 'none',
                stroke: isBusy ? `url(#edge-grad-${agent.id})`
                    : isError ? 'rgba(255,69,58,0.25)'
                    : 'rgba(255,255,255,0.08)',
                'stroke-width': isBusy ? '2.5' : '1.25',
                'stroke-linecap': 'round',
            });
            g.appendChild(base);

            if (isBusy) {
                const flow = svgEl('path', {
                    d,
                    fill: 'none',
                    stroke: agent.color,
                    'stroke-width': '2',
                    'stroke-dasharray': '8 22',
                    'stroke-linecap': 'round',
                    opacity: '0.85',
                    class: 'edge-flow',
                });
                g.appendChild(flow);
            } else if (!isError) {
                // Subtle ambient shimmer on idle edges — makes the canvas feel alive
                const ambient = svgEl('path', {
                    d,
                    fill: 'none',
                    stroke: 'rgba(255,255,255,0.06)',
                    'stroke-width': '1',
                    'stroke-dasharray': '4 28',
                    'stroke-linecap': 'round',
                    class: 'edge-ambient',
                });
                g.appendChild(ambient);
            }
        });

        svg.appendChild(g);
    }

    function renderSensei(svg: SVGSVGElement, busyCount: number): void {
        const g = svgEl('g', { class: 'orch-sensei-node' });

        // Card surface — neutral raised tile, accent border ONLY when coordinating
        const card = svgEl('rect', {
            x: String(SENSEI_X), y: String(SENSEI_Y),
            width: String(SENSEI_W), height: String(SENSEI_H),
            rx: '8', ry: '8',
            fill: 'rgba(255,255,255,0.025)',
            stroke: busyCount > 0 ? 'rgba(120,200,150,0.55)' : 'rgba(255,255,255,0.10)',
            'stroke-width': '1',
        });
        g.appendChild(card);

        // Top label "ORCHESTRATOR" — restrained, no gold
        const tag = svgEl('text', {
            x: String(SENSEI_X + 16), y: String(SENSEI_Y + 22),
            fill: 'rgba(255,255,255,0.40)',
            'font-size': '10', 'font-weight': '600', 'letter-spacing': '0.16em',
            'font-family': 'system-ui, -apple-system, sans-serif',
        });
        tag.textContent = 'ORCHESTRATOR';
        g.appendChild(tag);

        // Sigil glyph
        const portraitR = 36;
        const portraitCx = SENSEI_X + SENSEI_W / 2;
        const portraitCy = SENSEI_Y + 74;

        // Sigil ring — neutral hairline, accent only on coordinate
        const senseiRing = svgEl('circle', {
            cx: String(portraitCx), cy: String(portraitCy), r: String(portraitR + 1),
            fill: 'none',
            stroke: busyCount > 0 ? 'rgba(120,200,150,0.7)' : 'rgba(255,255,255,0.18)',
            'stroke-width': '1',
        });
        if (busyCount === 0) senseiRing.setAttribute('class', 'sensei-ring-idle');
        g.appendChild(senseiRing);

        // Sigil — neutral muted by default, moss-green only when active
        const senseiSigilColor = busyCount > 0 ? 'oklch(0.66 0.12 150)' : 'rgba(255,255,255,0.55)';
        appendSigil(g, 'sensei', portraitCx, portraitCy, portraitR * 1.5, senseiSigilColor);

        // Name — neutral white, no gold
        const name = svgEl('text', {
            x: String(SENSEI_X + SENSEI_W / 2),
            y: String(SENSEI_Y + 128),
            'text-anchor': 'middle',
            fill: 'rgba(255,255,255,0.92)',
            'font-size': '17', 'font-weight': '600', 'letter-spacing': '-0.005em',
            'font-family': 'system-ui, -apple-system, sans-serif',
        });
        name.textContent = 'Sensei';
        g.appendChild(name);

        // Status pill — neutral surface, moss-green only when coordinating
        const statusText = busyCount > 0 ? `Coordinating ${busyCount}` : 'Standing by';
        const pillW = statusText.length * 6.5 + 20;
        const pillX = SENSEI_X + (SENSEI_W - pillW) / 2;
        const pillY = SENSEI_Y + SENSEI_H - 30;
        const pill = svgEl('rect', {
            x: String(pillX), y: String(pillY),
            width: String(pillW), height: '18',
            rx: '9', ry: '9',
            fill: busyCount > 0 ? 'rgba(120,200,150,0.10)' : 'rgba(255,255,255,0.04)',
            stroke: busyCount > 0 ? 'rgba(120,200,150,0.35)' : 'rgba(255,255,255,0.08)',
            'stroke-width': '1',
        });
        g.appendChild(pill);

        const pillText = svgEl('text', {
            x: String(SENSEI_X + SENSEI_W / 2),
            y: String(pillY + 12),
            'text-anchor': 'middle',
            fill: busyCount > 0 ? 'oklch(0.78 0.12 150)' : 'rgba(255,255,255,0.55)',
            'font-size': '10', 'font-weight': '500', 'letter-spacing': '0.04em',
            'font-family': 'system-ui, -apple-system, sans-serif',
        });
        pillText.textContent = statusText;
        g.appendChild(pillText);

        svg.appendChild(g);
    }

    function renderAgent(
        svg: SVGSVGElement,
        agent: AgentNode,
        idx: number,
        state: FlowAgentState | undefined
    ): void {
        const pos = agentPosition(idx);
        const isBusy = state?.status === 'busy';
        const isError = state?.status === 'error';

        const g = svgEl('g', { class: 'orch-agent-node', 'data-agent': agent.id });

        // Card background
        const card = svgEl('rect', {
            x: String(pos.x), y: String(pos.y),
            width: String(CARD_W), height: String(CARD_H),
            rx: '14', ry: '14',
            fill: isBusy ? `${agent.color}1f`
                : isError ? 'rgba(255,69,58,0.10)'
                : 'rgba(255,255,255,0.025)',
            stroke: isBusy ? agent.color
                : isError ? '#ff453a'
                : 'rgba(255,255,255,0.10)',
            'stroke-width': isBusy ? '2' : '1.25',
            class: 'agent-card-bg',
        });
        if (isBusy) card.setAttribute('filter', 'url(#card-glow)');
        g.appendChild(card);

        // Identity stripe (top-left). Muted for idle; agent-color when busy.
        const stripe = svgEl('rect', {
            x: String(pos.x + 14), y: String(pos.y + 12),
            width: '32', height: '3', rx: '1.5', ry: '1.5',
            fill: isBusy ? agent.color : 'rgba(255,255,255,0.22)',
            opacity: isBusy ? '1' : '0.55',
        });
        g.appendChild(stripe);

        // Status dot (top-right)
        const dot = svgEl('circle', {
            cx: String(pos.x + CARD_W - 18), cy: String(pos.y + 18), r: '5',
            fill: isBusy ? agent.color
                : isError ? '#ff453a'
                : 'rgba(255,255,255,0.18)',
        });
        if (isBusy) dot.setAttribute('class', 'node-breath');
        else if (!isError) dot.setAttribute('class', 'idle-dot');
        g.appendChild(dot);

        // Sigil glyph (replaces former portrait image)
        const pR = 20;
        const pCx = pos.x + 30;
        const pCy = pos.y + 52;

        // Sigil ring — neutral hairline when idle, agent color when live
        g.appendChild(svgEl('circle', {
            cx: String(pCx), cy: String(pCy), r: String(pR + 1),
            fill: 'none',
            stroke: isBusy ? agent.color : 'rgba(255,255,255,0.18)',
            'stroke-width': '1',
        }));

        // Sigil itself — neutral muted by default, agent-color only when busy
        const sigilColor = isBusy ? agent.color : 'rgba(255,255,255,0.55)';
        appendSigil(g, agent.id, pCx, pCy, pR * 1.5, sigilColor);

        // Name
        const name = svgEl('text', {
            x: String(pos.x + 64), y: String(pos.y + 50),
            fill: isBusy ? '#fff' : 'rgba(255,255,255,0.85)',
            'font-size': '17', 'font-weight': '700',
            'font-family': 'system-ui, -apple-system, sans-serif',
        });
        name.textContent = agent.name;
        g.appendChild(name);

        // Role
        const role = svgEl('text', {
            x: String(pos.x + 64), y: String(pos.y + 68),
            fill: 'rgba(255,255,255,0.45)',
            'font-size': '12',
            'font-family': 'system-ui, -apple-system, sans-serif',
        });
        role.textContent = agent.role;
        g.appendChild(role);

        // Current task / status line at bottom
        const taskText = isBusy && state?.currentTask !== null && state?.currentTask !== undefined
            ? truncate(state.currentTask, 28)
            : isError ? 'Error — needs attention'
            : 'Idle';

        const taskBg = svgEl('rect', {
            x: String(pos.x + 14), y: String(pos.y + CARD_H - 32),
            width: String(CARD_W - 28), height: '20',
            rx: '6', ry: '6',
            fill: isBusy ? `${agent.color}26` : 'rgba(255,255,255,0.04)',
        });
        g.appendChild(taskBg);

        const taskLabel = svgEl('text', {
            x: String(pos.x + 22), y: String(pos.y + CARD_H - 18),
            fill: isBusy ? agent.color
                : isError ? '#ff8a82'
                : 'rgba(255,255,255,0.45)',
            'font-size': '12', 'font-weight': isBusy ? '600' : '500',
            'font-family': 'system-ui, -apple-system, sans-serif',
        });
        taskLabel.textContent = taskText;
        g.appendChild(taskLabel);

        // Click handler
        if (callbacks.onAgentClick !== undefined) {
            const cb = callbacks.onAgentClick;
            g.addEventListener('click', (e) => {
                e.stopPropagation();
                cb(agent.id);
            });
        }

        svg.appendChild(g);
    }

    // ── Render orchestration ─────────────────────────

    function render(): void {
        viewport.innerHTML = '';

        const svg = svgEl('svg', {
            viewBox: `0 0 ${WORLD_W} ${WORLD_H}`,
            class: 'orch-flow-svg',
            preserveAspectRatio: 'xMidYMid meet',
        });

        svg.appendChild(buildDefs());

        const states = callbacks.getAgentStates();
        const stateMap = new Map<string, FlowAgentState>();
        for (const s of states) stateMap.set(s.name.toLowerCase(), s);
        const busyCount = states.filter(s => s.status === 'busy').length;
        const errorCount = states.filter(s => s.status === 'error').length;

        renderEdges(svg, stateMap);
        renderSensei(svg, busyCount);
        AGENTS.forEach((agent, idx) => renderAgent(svg, agent, idx, stateMap.get(agent.id)));

        viewport.appendChild(svg);

        // Update phase strip
        const currentPhase = callbacks.getCurrentPhase?.() ?? null;
        renderPhaseBar(currentPhase);

        // Update status bar
        const dotEl = statusBar.querySelector('.status-dot') as HTMLElement | null;
        const textEl = statusBar.querySelector('.status-text');
        if (textEl !== null) {
            const parts: string[] = [];
            if (busyCount > 0) parts.push(`${busyCount} active`);
            if (errorCount > 0) parts.push(`${errorCount} error`);
            const idle = states.length - busyCount - errorCount;
            if (idle > 0) parts.push(`${idle} idle`);
            textEl.textContent = parts.length > 0 ? parts.join(' · ') : 'All agents standing by';
        }
        if (dotEl !== null) {
            dotEl.style.background =
                errorCount > 0 ? 'var(--error)'
                : busyCount > 0 ? 'var(--orange)'
                : 'var(--success)';
        }

        renderMinimap(stateMap);
    }

    function renderPhaseBar(currentPhase: string | null): void {
        const currentIdx = currentPhase !== null
            ? PHASES.findIndex(p => p.id === currentPhase.toLowerCase())
            : -1;

        phaseBar.hidden = currentIdx === -1;
        if (currentIdx === -1) return;

        phaseBar.innerHTML = '';
        PHASES.forEach((phase, i) => {
            const chip = document.createElement('span');
            chip.className = 'orch-flow-phase-chip';
            if (i === currentIdx) chip.classList.add('is-active');
            else if (currentIdx >= 0 && i < currentIdx) chip.classList.add('is-done');
            chip.textContent = phase.label;
            phaseBar.appendChild(chip);
            if (i < PHASES.length - 1) {
                const sep = document.createElement('span');
                sep.style.color = 'var(--text-muted)';
                sep.style.opacity = '0.5';
                sep.textContent = '›';
                phaseBar.appendChild(sep);
            }
        });
    }

    function renderMinimap(stateMap: ReadonlyMap<string, FlowAgentState>): void {
        minimap.innerHTML = '';
        const svg = svgEl('svg', {
            viewBox: `0 0 ${WORLD_W} ${WORLD_H}`,
            preserveAspectRatio: 'xMidYMid meet',
        });

        // Sensei (minimap) — neutral, no gold
        svg.appendChild(svgEl('rect', {
            x: String(SENSEI_X), y: String(SENSEI_Y),
            width: String(SENSEI_W), height: String(SENSEI_H),
            rx: '16', fill: 'rgba(255,255,255,0.30)',
        }));

        // Agent cards
        AGENTS.forEach((agent, idx) => {
            const pos = agentPosition(idx);
            const state = stateMap.get(agent.id);
            const busy = state?.status === 'busy';
            svg.appendChild(svgEl('rect', {
                x: String(pos.x), y: String(pos.y),
                width: String(CARD_W), height: String(CARD_H),
                rx: '14',
                fill: busy ? agent.color : 'rgba(255,255,255,0.18)',
                opacity: busy ? '0.9' : '0.5',
            }));
        });

        // Viewport rectangle (where the user is currently looking)
        const rect = canvas.getBoundingClientRect();
        const vpX = -tx / scale;
        const vpY = -ty / scale;
        const vpW = rect.width / scale;
        const vpH = rect.height / scale;
        svg.appendChild(svgEl('rect', {
            x: String(vpX), y: String(vpY),
            width: String(vpW), height: String(vpH),
            class: 'orch-flow-minimap-viewport',
        }));

        minimap.appendChild(svg);
    }

    function updateMinimapViewport(): void {
        const vpRect = minimap.querySelector('.orch-flow-minimap-viewport');
        if (vpRect === null) return;
        const rect = canvas.getBoundingClientRect();
        vpRect.setAttribute('x', String(-tx / scale));
        vpRect.setAttribute('y', String(-ty / scale));
        vpRect.setAttribute('width', String(rect.width / scale));
        vpRect.setAttribute('height', String(rect.height / scale));
    }

    // Initial render + fit-to-view (deferred so layout has settled)
    render();
    requestAnimationFrame(() => resetView());

    // Auto-refresh
    const interval = setInterval(() => render(), REFRESH_INTERVAL);

    // Resize → re-fit if user hasn't manually zoomed/panned much
    const resizeObs = new ResizeObserver(() => updateMinimapViewport());
    resizeObs.observe(canvas);

    // Cleanup
    const observer = new MutationObserver(() => {
        if (!document.body.contains(canvas)) {
            clearInterval(interval);
            resizeObs.disconnect();
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function setFullscreen(on: boolean): void {
        const fsBtn = controls.querySelector<HTMLElement>('.orch-flow-ctrl-btn--fs');
        if (fsBtn === null) return;
        fsBtn.title = on ? 'Exit fullscreen' : 'Expand to fullscreen';
        fsBtn.innerHTML = on
            ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4h3V1M8 1v3h3M11 8h-3v3M4 11V8H1"/></svg>`
            : `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1H1v3M11 4V1H8M8 11h3V8M1 8v3h3"/></svg>`;
    }

    return { refresh: render, setFullscreen };
}
