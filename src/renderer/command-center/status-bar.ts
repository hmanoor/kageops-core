/**
 * KageOps Command Center — Live Status Bar
 *
 * Renders the system health indicator in the top bar:
 * DB status, orchestrator status, active agent count, project count,
 * plus a live HUD that pulses on every event-bus activity event
 * (events/min, live spend ticker, latest event headline).
 */

interface SystemStatus {
    dbConnected: boolean;
    orchestratorRunning: boolean;
    activeAgents: number;
    totalProjects: number;
    version: string;
    /** When orchestrator bootstrap failed, the cause is surfaced here so
     *  the user sees "DB offline — <reason>" on hover instead of having to
     *  hunt for a log file. Null when bootstrap succeeded. */
    bootstrapError?: string | null;
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderStatusBar(container: HTMLElement, status: SystemStatus): void {
    const dbClass = status.dbConnected ? 'status-indicator--online' : 'status-indicator--offline';
    const orchClass = status.orchestratorRunning ? 'status-indicator--online' : 'status-indicator--offline';
    const failureTip = status.bootstrapError ?? '';
    const dbLabel = status.dbConnected ? 'DB' : 'DB offline';
    const orchLabel = status.orchestratorRunning ? 'Orchestrator' : 'Orchestrator offline';
    const dbTitle = status.dbConnected ? dbLabel : (failureTip !== '' ? `${dbLabel} — ${failureTip}` : dbLabel);
    const orchTitle = status.orchestratorRunning ? orchLabel : (failureTip !== '' ? `${orchLabel} — ${failureTip}` : orchLabel);

    container.innerHTML = `
        <div class="status-bar">
            <span class="status-indicator ${dbClass}" title="${escAttr(dbTitle)}">
                <span class="status-dot-sm"></span>${dbLabel}
            </span>
            <span class="status-indicator ${orchClass}" title="${escAttr(orchTitle)}">
                <span class="status-dot-sm"></span>${orchLabel}
            </span>
            <span class="status-stat" title="Active agents">
                <span class="status-stat-value">${status.activeAgents}</span> active
            </span>
            <span class="status-stat" title="Total projects">
                <span class="status-stat-value">${status.totalProjects}</span> projects
            </span>
            <span class="status-hud" id="status-hud">
                <span class="status-hud__live" id="status-hud-live" title="Live event-bus indicator">
                    <span class="status-hud__live-dot"></span>LIVE
                </span>
                <span class="status-hud__metric" title="Events in the last 60s">
                    <span class="status-hud__metric-value" id="status-hud-rate">0</span>
                    <span class="status-hud__metric-label">evt/min</span>
                </span>
                <span class="status-hud__metric" title="Live spend (sum of cost_usd across agent.stream events this session)">
                    <span class="status-hud__metric-value" id="status-hud-spend">$0.0000</span>
                </span>
                <span class="status-hud__latest" id="status-hud-latest" title="Latest event"></span>
            </span>
            <span class="status-version">v${status.version}</span>
        </div>
    `;
}

export function renderStatusBarError(container: HTMLElement): void {
    container.innerHTML = `
        <div class="status-bar">
            <span class="status-indicator status-indicator--offline">
                <span class="status-dot-sm"></span>Offline
            </span>
        </div>
    `;
}

// ── Live HUD (event-driven, no re-render) ──────────────────────────────

interface LiveHudState {
    eventTimes: number[];       // unix ms of recent events (rolling 60s window)
    spendUsd: number;           // session-cumulative
    rateTimer: ReturnType<typeof setInterval> | null;
    latestFadeTimer: ReturnType<typeof setTimeout> | null;
}

const HUD_STATE: LiveHudState = {
    eventTimes: [],
    spendUsd: 0,
    rateTimer: null,
    latestFadeTimer: null,
};

/**
 * Pulse the LIVE indicator and bump the event counter.
 * Call this on every onActivityEvent / onAgentStreamEvent.
 */
export function pulseLiveHud(opts?: { readonly costUsd?: number; readonly headline?: string }): void {
    const live = document.getElementById('status-hud-live');
    if (live !== null) {
        live.classList.remove('is-pulsing');
        // Force reflow so the next add-class restarts the animation.
        // Reading offsetWidth is the canonical way to flush pending style.
        void live.offsetWidth;
        live.classList.add('is-pulsing');
    }

    HUD_STATE.eventTimes.push(Date.now());
    pruneOldEventTimes();
    paintRate();

    if (opts?.costUsd !== undefined && Number.isFinite(opts.costUsd) && opts.costUsd > 0) {
        HUD_STATE.spendUsd += opts.costUsd;
        paintSpend();
    }

    if (opts?.headline !== undefined) {
        paintLatest(opts.headline);
    }

    ensureRateTimer();
}

function pruneOldEventTimes(): void {
    const cutoff = Date.now() - 60_000;
    let firstKeep = 0;
    while (firstKeep < HUD_STATE.eventTimes.length && HUD_STATE.eventTimes[firstKeep] < cutoff) {
        firstKeep++;
    }
    if (firstKeep > 0) {
        HUD_STATE.eventTimes = HUD_STATE.eventTimes.slice(firstKeep);
    }
}

function paintRate(): void {
    const el = document.getElementById('status-hud-rate');
    if (el === null) return;
    el.textContent = String(HUD_STATE.eventTimes.length);
}

function paintSpend(): void {
    const el = document.getElementById('status-hud-spend');
    if (el === null) return;
    el.textContent = `$${HUD_STATE.spendUsd.toFixed(4)}`;
}

function paintLatest(text: string): void {
    const el = document.getElementById('status-hud-latest');
    if (el === null) return;
    const trimmed = text.length > 80 ? text.slice(0, 77) + '…' : text;
    el.textContent = trimmed;
    el.classList.remove('is-fading');
    void el.offsetWidth;
    el.classList.add('is-fading');
    if (HUD_STATE.latestFadeTimer !== null) clearTimeout(HUD_STATE.latestFadeTimer);
    HUD_STATE.latestFadeTimer = setTimeout(() => {
        const e = document.getElementById('status-hud-latest');
        if (e !== null) e.textContent = '';
    }, 6000);
}

/**
 * Keep a 1Hz heartbeat that re-paints the rate even when no new events
 * arrive (so the rolling 60s window decays visibly to 0). Idempotent —
 * safe to call from every pulseLiveHud.
 */
function ensureRateTimer(): void {
    if (HUD_STATE.rateTimer !== null) return;
    HUD_STATE.rateTimer = setInterval(() => {
        pruneOldEventTimes();
        paintRate();
    }, 1000);
    const t = HUD_STATE.rateTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
}
