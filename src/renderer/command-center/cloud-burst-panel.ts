/**
 * Pillar 2.4 / PR-F.next + PR-G.next combined — Cloud Burst panel.
 *
 * One renderer view backing the activity-bar entry "Cloud Burst." Lazy-
 * initialised on first tab switch (registerViewInit). The panel has
 * three sections:
 *
 *   1. Pool config — shows the operator's configured burst pool (or a
 *      create form when none exists). Lets the operator save / disable
 *      / re-enable / delete a pool.
 *   2. Active bursts — table of in-flight bursts (queued, provisioning,
 *      running) with per-row Stop buttons + a "Stop all" header button.
 *      Refreshes every 5s while the panel is visible.
 *   3. Recent history — last 50 bursts (success / failed / timeout)
 *      for audit + cost roll-up.
 *
 * All IPC goes through the preload bridge (`window.kageOps.cloudBurst`
 * + `window.kageOps.burstPool`) — handlers landed in PR-F and PR-G.
 *
 * Tests target `renderCloudBurstPanel(rootEl, deps)` directly with a
 * fake `deps` so the suites drive the DOM without an Electron preload.
 */

// ── IPC envelope shapes (mirror of preload + handler exports) ──

export interface BurstPoolView {
    readonly id: string;
    readonly name: string;
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly containerRegistry: string;
    readonly defaultRegion: string;
    readonly budgetCapUsd: number;
    readonly enabled: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface BurstTaskView {
    readonly id: string;
    readonly taskId: string;
    readonly projectId: string;
    readonly poolId: string;
    readonly agentRole: string;
    readonly containerId: string | null;
    readonly region: string;
    readonly status: 'queued' | 'provisioning' | 'running' | 'completed' | 'failed' | 'timeout';
    readonly costUsd: number;
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly lastHeartbeatAt: string | null;
    readonly errorMessage: string | null;
}

type PoolEnvelope<T> =
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: string; readonly kind?: string };

type DeleteEnvelope =
    | { readonly success: true }
    | { readonly success: false; readonly error: string; readonly kind?: string };

type ListEnvelope =
    | { readonly success: true; readonly bursts: readonly BurstTaskView[] }
    | { readonly success: false; readonly error: string };

type StopEnvelope =
    | { readonly success: true }
    | { readonly success: false; readonly error: string };

type StopAllEnvelope = {
    readonly success: true;
    readonly stopped: number;
    readonly failed: number;
    readonly errors: readonly string[];
};

export interface BurstDispatchArgs {
    readonly projectId: string;
    readonly taskId: string;
    readonly agentRole: string;
    readonly image: string;
    readonly poolId: string;
    readonly estimatedCostUsd: number;
}

export type BurstDispatchEnvelope =
    | {
        readonly success: true;
        readonly burstId: string;
        readonly containerId: string;
        readonly containerGroupName: string;
        readonly poolId: string;
        readonly poolName: string;
    }
    | { readonly success: false; readonly error: string; readonly errorKind?: string };

/** Agent roles selectable in the dispatch form (match agent registry names). */
const DISPATCH_AGENT_ROLES = [
    'forge', 'vigil', 'scout', 'blueprint', 'aegis', 'pixel', 'cipher', 'herald',
] as const;

/** Example agent-image ref shown as a hint — the operator supplies their own
 *  registry/image (Cloud Burst is a commercial feature; no org is baked in). */
const DEFAULT_BURST_IMAGE = 'ghcr.io/your-org/kageops-agent:latest';

// ── Dep injection ──────────────────────────────────────

export interface CreatePoolInput {
    readonly name: string;
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly containerRegistry: string;
    readonly defaultRegion: string;
    readonly budgetCapUsd: number;
    readonly enabled?: boolean;
}

export interface CloudBurstPanelDeps {
    readonly listPools: () => Promise<PoolEnvelope<readonly BurstPoolView[]>>;
    readonly createPool: (input: CreatePoolInput) => Promise<PoolEnvelope<BurstPoolView>>;
    readonly updatePool: (
        id: string,
        patch: {
            resourceGroup?: string;
            containerRegistry?: string;
            defaultRegion?: string;
            budgetCapUsd?: number;
            enabled?: boolean;
        }
    ) => Promise<PoolEnvelope<BurstPoolView>>;
    readonly deletePool: (id: string) => Promise<DeleteEnvelope>;
    readonly listActiveBursts: () => Promise<ListEnvelope>;
    /**
     * Recent TERMINAL bursts for the history section. Optional so existing
     * embeds/tests are unaffected; when present the history list is sourced
     * from it (the active query excludes terminal rows, so without this the
     * history section can never populate).
     */
    readonly listRecentBursts?: () => Promise<ListEnvelope>;
    readonly listBurstsForProject?: (projectId: string) => Promise<ListEnvelope>;
    readonly stopBurst: (burstId: string) => Promise<StopEnvelope>;
    readonly stopAllBursts: () => Promise<StopAllEnvelope>;
    /**
     * Dispatch a task to cloud burst. Optional so existing tests/embeds can
     * omit it; when present the panel renders the "Send to Cloud Burst" form.
     * Main process pushes the workspace + injects container env (PR-E.2b).
     */
    readonly dispatchBurst?: (input: BurstDispatchArgs) => Promise<BurstDispatchEnvelope>;
    /** Optional polling interval (ms). Defaults to 5000; tests pass 0 to disable. */
    readonly pollIntervalMs?: number;
    /** Optional setInterval / clearInterval (test seam). */
    readonly setInterval?: (fn: () => void, ms: number) => unknown;
    readonly clearInterval?: (handle: unknown) => void;
}

export interface CloudBurstPanelHandle {
    /** Stop polling + remove DOM. Useful for tests + future hot reload. */
    readonly destroy: () => void;
    /** Force a re-render (tests call this after stubbing dep responses). */
    readonly refresh: () => Promise<void>;
}

// ── Production deps from the preload bridge ─────────────

declare global {
    interface Window {
        readonly kageOps?: {
            readonly cloudBurst: {
                listActive: () => Promise<ListEnvelope>;
                listForProject: (projectId: string) => Promise<ListEnvelope>;
                listRecent: () => Promise<ListEnvelope>;
                stop: (burstId: string) => Promise<StopEnvelope>;
                stopAll: () => Promise<StopAllEnvelope>;
                dispatch: (args: Record<string, unknown>) => Promise<unknown>;
            };
            readonly burstPool: {
                list: () => Promise<PoolEnvelope<readonly BurstPoolView[]>>;
                get: (id: string) => Promise<PoolEnvelope<BurstPoolView | null>>;
                create: (input: unknown) => Promise<PoolEnvelope<BurstPoolView>>;
                update: (id: string, patch: unknown) => Promise<PoolEnvelope<BurstPoolView>>;
                delete: (id: string) => Promise<DeleteEnvelope>;
            };
        };
    }
}

export function defaultCloudBurstPanelDeps(): CloudBurstPanelDeps {
    const api = window.kageOps;
    if (api === undefined) {
        throw new Error('cloud-burst panel: window.kageOps preload bridge missing');
    }
    return {
        listPools: () => api.burstPool.list(),
        createPool: (input) => api.burstPool.create(input),
        updatePool: (id, patch) => api.burstPool.update(id, patch),
        deletePool: (id) => api.burstPool.delete(id),
        listActiveBursts: () => api.cloudBurst.listActive(),
        listRecentBursts: () => api.cloudBurst.listRecent(),
        listBurstsForProject: (projectId) => api.cloudBurst.listForProject(projectId),
        stopBurst: (burstId) => api.cloudBurst.stop(burstId),
        stopAllBursts: () => api.cloudBurst.stopAll(),
        dispatchBurst: (input) =>
            api.cloudBurst.dispatch(input as unknown as Record<string, unknown>) as Promise<BurstDispatchEnvelope>,
    };
}

// ── Renderer ───────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 5_000;

const ACTIVE_STATES: ReadonlySet<BurstTaskView['status']> = new Set([
    'queued',
    'provisioning',
    'running',
]);

export function renderCloudBurstPanel(
    root: HTMLElement,
    deps: CloudBurstPanelDeps
): CloudBurstPanelHandle {
    root.innerHTML = '';
    root.classList.add('cb-panel');

    const header = renderHeader();
    const poolSection = renderPoolSection();
    const dispatchSection = deps.dispatchBurst !== undefined ? renderDispatchSection() : null;
    const activeSection = renderActiveSection();
    const historySection = renderHistorySection();

    root.appendChild(header.element);
    root.appendChild(poolSection.element);
    if (dispatchSection !== null) root.appendChild(dispatchSection.element);
    root.appendChild(activeSection.element);
    root.appendChild(historySection.element);

    let cachedPool: BurstPoolView | null = null;

    async function refresh(): Promise<void> {
        const [poolsRes, burstsRes, recentRes] = await Promise.all([
            deps.listPools(),
            deps.listActiveBursts(),
            deps.listRecentBursts ? deps.listRecentBursts() : Promise.resolve(null),
        ]);

        if (poolsRes.success) {
            const pool = poolsRes.data[0] ?? null;
            cachedPool = pool;
            poolSection.renderPool(pool);
            dispatchSection?.setPool(pool);
        } else {
            poolSection.renderError(poolsRes.error);
            dispatchSection?.setPool(null);
        }

        if (burstsRes.success) {
            const active = burstsRes.bursts.filter((b) => ACTIVE_STATES.has(b.status));
            activeSection.render(active);

            // History comes from the dedicated recent-terminal query when wired;
            // fall back to terminal rows in the active payload (legacy / tests
            // without listRecentBursts — which is always empty since the active
            // query excludes terminal rows).
            const history = recentRes !== null && recentRes.success
                ? recentRes.bursts
                : burstsRes.bursts.filter((b) => !ACTIVE_STATES.has(b.status));
            historySection.render(history);

            const costBursts = recentRes !== null && recentRes.success
                ? [...burstsRes.bursts, ...recentRes.bursts]
                : burstsRes.bursts;
            header.renderSummary(active.length, sumCost(costBursts));
        } else {
            activeSection.renderError(burstsRes.error);
            historySection.renderError(burstsRes.error);
            header.renderSummary(0, 0);
        }
    }

    // ── Polling lifecycle ──
    const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const schedule = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const cancel = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    const pollHandle = intervalMs > 0
        ? schedule(() => { void refresh(); }, intervalMs)
        : null;

    void refresh();

    // ── Wire pool form actions ──
    poolSection.onCreate(async (input) => {
        const res = await deps.createPool(input);
        if (res.success) {
            await refresh();
            return null;
        }
        return res.error;
    });

    poolSection.onUpdate(async (patch) => {
        if (cachedPool === null) return 'no pool to update';
        const res = await deps.updatePool(cachedPool.id, patch);
        if (res.success) {
            await refresh();
            return null;
        }
        return res.error;
    });

    poolSection.onDelete(async () => {
        if (cachedPool === null) return 'no pool to delete';
        if (!confirm(`Delete burst pool "${cachedPool.name}"? Historical bursts referencing this pool will block the delete; disable the pool instead if that fails.`)) {
            return 'cancelled';
        }
        const res = await deps.deletePool(cachedPool.id);
        if (res.success) {
            cachedPool = null;
            await refresh();
            return null;
        }
        return res.error;
    });

    poolSection.onToggleEnabled(async (next) => {
        if (cachedPool === null) return 'no pool to toggle';
        const res = await deps.updatePool(cachedPool.id, { enabled: next });
        if (res.success) {
            await refresh();
            return null;
        }
        return res.error;
    });

    // ── Wire dispatch ──
    dispatchSection?.onDispatch(async (values) => {
        if (deps.dispatchBurst === undefined) return 'dispatch unavailable';
        if (cachedPool === null) return 'configure a burst pool first';
        if (!cachedPool.enabled) return 'pool is disabled — enable it before dispatching';
        const res = await deps.dispatchBurst({ ...values, poolId: cachedPool.id });
        if (res.success) {
            await refresh();
            return null;
        }
        return res.errorKind !== undefined ? `${res.error} (${res.errorKind})` : res.error;
    });

    // ── Wire burst actions ──
    activeSection.onStop(async (burstId) => {
        const res = await deps.stopBurst(burstId);
        if (res.success) {
            await refresh();
            return null;
        }
        return res.error;
    });

    activeSection.onStopAll(async () => {
        if (!confirm('Stop ALL active cloud bursts? This terminates every in-flight container and may lose in-flight work.')) {
            return 'cancelled';
        }
        const res = await deps.stopAllBursts();
        await refresh();
        return res.failed > 0
            ? `${res.stopped} stopped, ${res.failed} failed: ${res.errors.join('; ')}`
            : null;
    });

    return {
        destroy: () => {
            if (pollHandle !== null) cancel(pollHandle);
            root.innerHTML = '';
        },
        refresh,
    };
}

// ── Header ──────────────────────────────────────────────

interface HeaderHandle {
    readonly element: HTMLElement;
    renderSummary(activeCount: number, totalCostUsd: number): void;
}

function renderHeader(): HeaderHandle {
    const el = document.createElement('div');
    el.className = 'cb-header';
    el.innerHTML = `
        <div class="cb-header__title">
            <h2>Cloud Burst</h2>
            <p class="cb-header__sub">Spawn Azure containers for parallel agent work. <strong>Hard cost cap protects you.</strong></p>
        </div>
        <div class="cb-header__summary">
            <span class="cb-chip" data-cb-active-chip>☁ <span data-cb-active-count>0</span> active</span>
            <span class="cb-chip cb-chip--cost" data-cb-cost-chip>$<span data-cb-total-cost>0.00</span></span>
        </div>
    `;
    const activeCount = el.querySelector<HTMLElement>('[data-cb-active-count]');
    const totalCost = el.querySelector<HTMLElement>('[data-cb-total-cost]');
    const activeChip = el.querySelector<HTMLElement>('[data-cb-active-chip]');

    return {
        element: el,
        renderSummary(active, cost) {
            if (activeCount !== null) activeCount.textContent = String(active);
            if (totalCost !== null) totalCost.textContent = cost.toFixed(2);
            if (activeChip !== null) {
                activeChip.classList.toggle('cb-chip--live', active > 0);
            }
        },
    };
}

// ── Pool section ───────────────────────────────────────

interface PoolSectionHandle {
    readonly element: HTMLElement;
    renderPool(pool: BurstPoolView | null): void;
    renderError(message: string): void;
    onCreate(handler: (input: BurstPoolFormValues) => Promise<string | null>): void;
    onUpdate(handler: (patch: PoolUpdatePatch) => Promise<string | null>): void;
    onDelete(handler: () => Promise<string | null>): void;
    onToggleEnabled(handler: (next: boolean) => Promise<string | null>): void;
}

interface BurstPoolFormValues {
    readonly name: string;
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly containerRegistry: string;
    readonly defaultRegion: string;
    readonly budgetCapUsd: number;
}

interface PoolUpdatePatch {
    readonly resourceGroup?: string;
    readonly containerRegistry?: string;
    readonly defaultRegion?: string;
    readonly budgetCapUsd?: number;
    readonly enabled?: boolean;
}

function renderPoolSection(): PoolSectionHandle {
    const el = document.createElement('section');
    el.className = 'cb-section cb-section--pool';
    el.innerHTML = `
        <header class="cb-section-header">
            <h3>Pool configuration</h3>
            <p class="cb-section-sub">Pillar 2.4 D-N: bursts run in <em>your</em> Azure subscription. KageOps never sees the bill.</p>
        </header>
        <div class="cb-pool-body" data-cb-pool-body>
            <p class="cb-empty">Loading…</p>
        </div>
        <div class="cb-pool-status" data-cb-pool-status></div>
    `;
    const bodyOrNull = el.querySelector<HTMLElement>('[data-cb-pool-body]');
    const statusOrNull = el.querySelector<HTMLElement>('[data-cb-pool-status]');
    if (bodyOrNull === null || statusOrNull === null) {
        throw new Error('cb-pool-body / status nodes missing');
    }
    const body: HTMLElement = bodyOrNull;
    const status: HTMLElement = statusOrNull;

    let createHandler: ((input: BurstPoolFormValues) => Promise<string | null>) | null = null;
    let updateHandler: ((patch: PoolUpdatePatch) => Promise<string | null>) | null = null;
    let deleteHandler: (() => Promise<string | null>) | null = null;
    let toggleHandler: ((next: boolean) => Promise<string | null>) | null = null;

    function setStatus(msg: string, kind: 'info' | 'error' | 'ok'): void {
        status.textContent = msg;
        status.dataset['kind'] = kind;
    }

    function renderEmpty(): void {
        body.innerHTML = `
            <form class="cb-pool-form" data-cb-pool-create>
                <p class="cb-empty">No burst pool configured yet. Add one to enable cloud bursting.</p>
                <label>Pool name <input name="name" required placeholder="default" /></label>
                <label>Azure subscription ID <input name="subscriptionId" required placeholder="00000000-0000-0000-0000-000000000000" /></label>
                <label>Resource group <input name="resourceGroup" required placeholder="kageops-prod" /></label>
                <label>Container registry FQDN <input name="containerRegistry" required placeholder="your-registry.azurecr.io" /></label>
                <label>Default region <input name="defaultRegion" required placeholder="australiaeast" /></label>
                <label>Budget cap (USD per session) <input name="budgetCapUsd" type="number" min="0" step="0.01" required value="5" /></label>
                <div class="cb-pool-actions">
                    <button type="submit" class="cb-btn cb-btn--primary">Create pool</button>
                </div>
            </form>
        `;
        const form = body.querySelector<HTMLFormElement>('[data-cb-pool-create]');
        if (form === null) return;
        form.addEventListener('submit', (ev) => {
            ev.preventDefault();
            if (createHandler === null) return;
            const fd = new FormData(form);
            const values: BurstPoolFormValues = {
                name: String(fd.get('name') ?? '').trim(),
                subscriptionId: String(fd.get('subscriptionId') ?? '').trim(),
                resourceGroup: String(fd.get('resourceGroup') ?? '').trim(),
                containerRegistry: String(fd.get('containerRegistry') ?? '').trim(),
                defaultRegion: String(fd.get('defaultRegion') ?? '').trim(),
                budgetCapUsd: Number(fd.get('budgetCapUsd') ?? 0),
            };
            setStatus('Creating pool…', 'info');
            void createHandler(values).then((err) => {
                if (err !== null) setStatus(`Create failed: ${err}`, 'error');
                else setStatus('Pool created.', 'ok');
            });
        });
    }

    function renderConfigured(pool: BurstPoolView): void {
        body.innerHTML = `
            <div class="cb-pool-card">
                <header class="cb-pool-card__head">
                    <div>
                        <h4>${escapeHtml(pool.name)}</h4>
                        <p class="cb-pool-card__sub">${escapeHtml(pool.subscriptionId)} · ${escapeHtml(pool.resourceGroup)}</p>
                    </div>
                    <label class="cb-toggle">
                        <input type="checkbox" data-cb-toggle-enabled ${pool.enabled ? 'checked' : ''} />
                        <span>Enabled</span>
                    </label>
                </header>
                <form class="cb-pool-form" data-cb-pool-update>
                    <label>Resource group <input name="resourceGroup" value="${escapeHtml(pool.resourceGroup)}" /></label>
                    <label>Container registry <input name="containerRegistry" value="${escapeHtml(pool.containerRegistry)}" /></label>
                    <label>Default region <input name="defaultRegion" value="${escapeHtml(pool.defaultRegion)}" /></label>
                    <label>Budget cap (USD) <input name="budgetCapUsd" type="number" min="0" step="0.01" value="${pool.budgetCapUsd}" /></label>
                    <div class="cb-pool-actions">
                        <button type="submit" class="cb-btn cb-btn--primary">Save changes</button>
                        <button type="button" class="cb-btn cb-btn--danger" data-cb-pool-delete>Delete pool…</button>
                    </div>
                </form>
            </div>
        `;
        const form = body.querySelector<HTMLFormElement>('[data-cb-pool-update]');
        if (form !== null) {
            form.addEventListener('submit', (ev) => {
                ev.preventDefault();
                if (updateHandler === null) return;
                const fd = new FormData(form);
                const patch: PoolUpdatePatch = {
                    resourceGroup: String(fd.get('resourceGroup') ?? '').trim() || undefined,
                    containerRegistry: String(fd.get('containerRegistry') ?? '').trim() || undefined,
                    defaultRegion: String(fd.get('defaultRegion') ?? '').trim() || undefined,
                    budgetCapUsd: Number(fd.get('budgetCapUsd') ?? 0),
                };
                setStatus('Saving…', 'info');
                void updateHandler(patch).then((err) => {
                    if (err !== null) setStatus(`Save failed: ${err}`, 'error');
                    else setStatus('Saved.', 'ok');
                });
            });
        }

        const toggle = body.querySelector<HTMLInputElement>('[data-cb-toggle-enabled]');
        if (toggle !== null) {
            toggle.addEventListener('change', () => {
                if (toggleHandler === null) return;
                const next = toggle.checked;
                setStatus(next ? 'Enabling…' : 'Disabling…', 'info');
                void toggleHandler(next).then((err) => {
                    if (err !== null) {
                        toggle.checked = !next;
                        setStatus(`Toggle failed: ${err}`, 'error');
                    } else {
                        setStatus(next ? 'Pool enabled.' : 'Pool disabled.', 'ok');
                    }
                });
            });
        }

        const deleteBtn = body.querySelector<HTMLButtonElement>('[data-cb-pool-delete]');
        if (deleteBtn !== null) {
            deleteBtn.addEventListener('click', () => {
                if (deleteHandler === null) return;
                setStatus('Deleting…', 'info');
                void deleteHandler().then((err) => {
                    if (err !== null) {
                        if (err !== 'cancelled') setStatus(`Delete failed: ${err}`, 'error');
                        else setStatus('', 'info');
                    } else setStatus('Pool deleted.', 'ok');
                });
            });
        }
    }

    return {
        element: el,
        renderPool(pool) {
            status.textContent = '';
            if (pool === null) renderEmpty();
            else renderConfigured(pool);
        },
        renderError(message) {
            body.innerHTML = `<p class="cb-empty cb-empty--error">${escapeHtml(message)}</p>`;
        },
        onCreate(h) { createHandler = h; },
        onUpdate(h) { updateHandler = h; },
        onDelete(h) { deleteHandler = h; },
        onToggleEnabled(h) { toggleHandler = h; },
    };
}

// ── Dispatch section ───────────────────────────────────

interface DispatchFormValues {
    readonly projectId: string;
    readonly taskId: string;
    readonly agentRole: string;
    readonly image: string;
    readonly estimatedCostUsd: number;
}

interface DispatchSectionHandle {
    readonly element: HTMLElement;
    /** Enable/disable the form based on whether an enabled pool exists. */
    setPool(pool: BurstPoolView | null): void;
    onDispatch(handler: (values: DispatchFormValues) => Promise<string | null>): void;
}

function renderDispatchSection(): DispatchSectionHandle {
    const el = document.createElement('section');
    el.className = 'cb-section cb-section--dispatch';
    el.innerHTML = `
        <header class="cb-section-header">
            <h3>Send to Cloud Burst</h3>
            <p class="cb-section-sub">Run one task in your Azure subscription. The workspace is pushed to a per-burst branch automatically.</p>
        </header>
        <div class="cb-dispatch-body" data-cb-dispatch-body>
            <form class="cb-pool-form" data-cb-dispatch-form>
                <label>Project ID <input name="projectId" required placeholder="project UUID" /></label>
                <label>Task ID <input name="taskId" required placeholder="task UUID" /></label>
                <label>Agent
                    <select name="agentRole">
                        ${DISPATCH_AGENT_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}
                    </select>
                </label>
                <label>Image <input name="image" required placeholder="${escapeHtml(DEFAULT_BURST_IMAGE)}" /></label>
                <label>Estimated cost (USD) <input name="estimatedCostUsd" type="number" min="0" step="0.01" value="0.05" /></label>
                <div class="cb-pool-actions">
                    <button type="submit" class="cb-btn cb-btn--primary" data-cb-dispatch-submit>Send to Cloud Burst</button>
                </div>
            </form>
        </div>
        <div class="cb-section-status" data-cb-dispatch-status></div>
    `;
    const bodyOrNull = el.querySelector<HTMLElement>('[data-cb-dispatch-body]');
    const statusOrNull = el.querySelector<HTMLElement>('[data-cb-dispatch-status]');
    const formOrNull = el.querySelector<HTMLFormElement>('[data-cb-dispatch-form]');
    const submitOrNull = el.querySelector<HTMLButtonElement>('[data-cb-dispatch-submit]');
    if (bodyOrNull === null || statusOrNull === null || formOrNull === null || submitOrNull === null) {
        throw new Error('cb dispatch nodes missing');
    }
    const status: HTMLElement = statusOrNull;
    const form: HTMLFormElement = formOrNull;
    const submit: HTMLButtonElement = submitOrNull;

    let dispatchHandler: ((values: DispatchFormValues) => Promise<string | null>) | null = null;

    function setStatus(msg: string, kind: 'info' | 'error' | 'ok'): void {
        status.textContent = msg;
        status.dataset['kind'] = kind;
    }

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (dispatchHandler === null) return;
        const fd = new FormData(form);
        const values: DispatchFormValues = {
            projectId: String(fd.get('projectId') ?? '').trim(),
            taskId: String(fd.get('taskId') ?? '').trim(),
            agentRole: String(fd.get('agentRole') ?? 'forge').trim(),
            // The field shows DEFAULT_BURST_IMAGE as a placeholder (no org baked
            // into the value); fall back to it when the operator leaves it blank.
            image: String(fd.get('image') ?? '').trim() || DEFAULT_BURST_IMAGE,
            estimatedCostUsd: Number(fd.get('estimatedCostUsd') ?? 0),
        };
        if (values.projectId === '' || values.taskId === '' || values.image === '') {
            setStatus('Project ID, Task ID and Image are required.', 'error');
            return;
        }
        submit.disabled = true;
        setStatus('Dispatching burst…', 'info');
        void dispatchHandler(values).then((err) => {
            submit.disabled = false;
            if (err !== null) setStatus(`Dispatch failed: ${err}`, 'error');
            else setStatus('Burst dispatched — watch Active bursts below.', 'ok');
        });
    });

    return {
        element: el,
        setPool(pool) {
            const ready = pool !== null && pool.enabled;
            submit.disabled = !ready;
            if (pool === null) {
                setStatus('Configure a burst pool above before dispatching.', 'info');
            } else if (!pool.enabled) {
                setStatus(`Pool "${pool.name}" is disabled — enable it to dispatch.`, 'info');
            } else if (status.dataset['kind'] !== 'ok' && status.dataset['kind'] !== 'error') {
                setStatus(`Ready — bursts run in pool "${pool.name}".`, 'info');
            }
        },
        onDispatch(h) { dispatchHandler = h; },
    };
}

// ── Active bursts section ──────────────────────────────

interface ActiveSectionHandle {
    readonly element: HTMLElement;
    render(bursts: readonly BurstTaskView[]): void;
    renderError(message: string): void;
    onStop(handler: (burstId: string) => Promise<string | null>): void;
    onStopAll(handler: () => Promise<string | null>): void;
}

function renderActiveSection(): ActiveSectionHandle {
    const el = document.createElement('section');
    el.className = 'cb-section cb-section--active';
    el.innerHTML = `
        <header class="cb-section-header">
            <h3>Active bursts</h3>
            <button type="button" class="cb-btn cb-btn--danger" data-cb-stop-all>Stop all</button>
        </header>
        <div class="cb-section-body" data-cb-active-body>
            <p class="cb-empty">No active bursts.</p>
        </div>
        <div class="cb-section-status" data-cb-active-status></div>
    `;
    const body = el.querySelector<HTMLElement>('[data-cb-active-body]');
    const status = el.querySelector<HTMLElement>('[data-cb-active-status]');
    const stopAllBtn = el.querySelector<HTMLButtonElement>('[data-cb-stop-all]');
    if (body === null || status === null || stopAllBtn === null) {
        throw new Error('active section nodes missing');
    }

    let stopHandler: ((id: string) => Promise<string | null>) | null = null;
    let stopAllHandler: (() => Promise<string | null>) | null = null;

    stopAllBtn.addEventListener('click', () => {
        if (stopAllHandler === null) return;
        status.textContent = 'Stopping all bursts…';
        void stopAllHandler().then((err) => {
            if (err !== null && err !== 'cancelled') {
                status.textContent = `Stop-all: ${err}`;
            } else if (err === null) {
                status.textContent = 'Stop-all dispatched.';
            } else {
                status.textContent = '';
            }
        });
    });

    return {
        element: el,
        render(bursts) {
            stopAllBtn.disabled = bursts.length === 0;
            if (bursts.length === 0) {
                body.innerHTML = '<p class="cb-empty">No active bursts.</p>';
                return;
            }
            body.innerHTML = `
                <table class="cb-table">
                    <thead><tr>
                        <th>Burst</th><th>Agent</th><th>Region</th><th>Status</th><th>Cost (USD)</th><th></th>
                    </tr></thead>
                    <tbody>
                    ${bursts.map((b) => `
                        <tr data-cb-burst-row="${escapeHtml(b.id)}">
                            <td><code>${shortId(b.id)}</code></td>
                            <td>${escapeHtml(b.agentRole)}</td>
                            <td>${escapeHtml(b.region)}</td>
                            <td><span class="cb-status cb-status--${b.status}">${b.status}</span></td>
                            <td>$${b.costUsd.toFixed(4)}</td>
                            <td><button type="button" class="cb-btn cb-btn--small" data-cb-stop-id="${escapeHtml(b.id)}">Stop</button></td>
                        </tr>
                    `).join('')}
                    </tbody>
                </table>
            `;
            body.querySelectorAll<HTMLButtonElement>('[data-cb-stop-id]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    if (stopHandler === null) return;
                    const id = btn.dataset['cbStopId'] ?? '';
                    btn.disabled = true;
                    btn.textContent = 'Stopping…';
                    void stopHandler(id).then((err) => {
                        if (err !== null) {
                            btn.disabled = false;
                            btn.textContent = 'Stop';
                            status.textContent = `Stop ${shortId(id)}: ${err}`;
                        }
                    });
                });
            });
        },
        renderError(message) {
            body.innerHTML = `<p class="cb-empty cb-empty--error">${escapeHtml(message)}</p>`;
        },
        onStop(h) { stopHandler = h; },
        onStopAll(h) { stopAllHandler = h; },
    };
}

// ── History section ────────────────────────────────────

interface HistorySectionHandle {
    readonly element: HTMLElement;
    render(bursts: readonly BurstTaskView[]): void;
    renderError(message: string): void;
}

function renderHistorySection(): HistorySectionHandle {
    const el = document.createElement('section');
    el.className = 'cb-section cb-section--history';
    el.innerHTML = `
        <header class="cb-section-header">
            <h3>Recent history</h3>
            <p class="cb-section-sub">Last 50 terminal bursts. Cost roll-up + per-burst error message.</p>
        </header>
        <div class="cb-section-body" data-cb-history-body>
            <p class="cb-empty">No history yet.</p>
        </div>
    `;
    const body = el.querySelector<HTMLElement>('[data-cb-history-body]');
    if (body === null) throw new Error('history body missing');

    return {
        element: el,
        render(bursts) {
            const recent = bursts.slice(0, 50);
            if (recent.length === 0) {
                body.innerHTML = '<p class="cb-empty">No history yet.</p>';
                return;
            }
            body.innerHTML = `
                <table class="cb-table">
                    <thead><tr>
                        <th>Burst</th><th>Agent</th><th>Status</th><th>Cost</th><th>Completed</th><th>Detail</th>
                    </tr></thead>
                    <tbody>
                    ${recent.map((b) => `
                        <tr>
                            <td><code>${shortId(b.id)}</code></td>
                            <td>${escapeHtml(b.agentRole)}</td>
                            <td><span class="cb-status cb-status--${b.status}">${b.status}</span></td>
                            <td>$${b.costUsd.toFixed(4)}</td>
                            <td>${escapeHtml(formatTimestamp(b.completedAt ?? b.requestedAt))}</td>
                            <td>${escapeHtml(b.errorMessage ?? '')}</td>
                        </tr>
                    `).join('')}
                    </tbody>
                </table>
            `;
        },
        renderError(message) {
            body.innerHTML = `<p class="cb-empty cb-empty--error">${escapeHtml(message)}</p>`;
        },
    };
}

// ── Helpers ─────────────────────────────────────────────

function escapeHtml(raw: string): string {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function shortId(id: string): string {
    return id.slice(0, 8);
}

function sumCost(bursts: readonly BurstTaskView[]): number {
    return bursts.reduce((acc, b) => acc + b.costUsd, 0);
}

function formatTimestamp(iso: string): string {
    if (iso.length === 0) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
}
