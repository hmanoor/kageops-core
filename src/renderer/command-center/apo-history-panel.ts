/**
 * KageOps Command Center — APO History / Diff Panel (v0.11)
 *
 * Renders the list of `prompt_optimizations` rows produced by the APO
 * pipeline, and lets an operator click into a row to see the baseline-vs-
 * optimized prompt diff.
 *
 * Pure helpers (formatReward, formatRelative, statusBadgeClass,
 * buildHistoryHtml, buildDiffHtml, diffLines, escapeHtml) are exported so
 * vitest can exercise them without a DOM. The `renderApoHistoryPanel`
 * entry point is the only function that touches the DOM.
 */

// ── Shared types (mirror src/learning/types.ts#PromptOptimizationRecord) ─

export type PromptOptimizationStatus = 'proposed' | 'accepted' | 'rolled_back';

export interface PromptOptimizationRecord {
    readonly id: string;
    readonly agentName: string;
    readonly baselinePrompt: string;
    readonly optimizedPrompt: string;
    readonly baselineReward: number;
    readonly optimizedReward: number;
    readonly rewardDelta: number;
    readonly beamWidth: number;
    readonly branchFactor: number;
    readonly rounds: number;
    readonly nSamples: number;
    readonly status: PromptOptimizationStatus;
    readonly createdAt: string;
    readonly appliedAt: string | null;
}

export interface ApoHistoryActionResult {
    readonly success: boolean;
    readonly record: PromptOptimizationRecord | null;
    readonly error?: string;
}

export interface ApoHistoryCallbacks {
    list(): Promise<{
        readonly success: boolean;
        readonly records: readonly PromptOptimizationRecord[];
        readonly error?: string;
    }>;
    /**
     * Accept a proposed optimization — writes the winning prompt into
     * the active preset (creates a `.apo-backup-<ts>.json` first) and
     * flips the DB row to `accepted`. Only callable on proposed rows.
     */
    accept?(id: string): Promise<ApoHistoryActionResult>;
    /**
     * Reject a proposed optimization — flips the DB row to `rolled_back`
     * without touching the preset file. Only callable on proposed rows.
     */
    reject?(id: string): Promise<ApoHistoryActionResult>;
}

/**
 * One of the 3 statuses, plus `all` as a sentinel for "don't filter".
 * Kept as a pure type so the renderer can share it with tests.
 */
export type ApoStatusFilter = PromptOptimizationStatus | 'all';

export const APO_STATUS_FILTERS: readonly ApoStatusFilter[] = [
    'all',
    'proposed',
    'accepted',
    'rolled_back',
];

// ── Public API ────────────────────────────────────────

/**
 * Per-panel state — kept on the container dataset so a re-render doesn't
 * lose the user's filter choice. Tests exercise the pure helpers
 * (`filterByStatus`, `buildHistoryHtml`) directly.
 */
interface PanelState {
    filter: ApoStatusFilter;
    selectedId: string | null;
    records: readonly PromptOptimizationRecord[];
}

export function renderApoHistoryPanel(
    container: HTMLElement,
    callbacks: ApoHistoryCallbacks
): void {
    container.innerHTML = '<div class="empty-state">Loading APO history…</div>';
    const state: PanelState = {
        filter: readFilterFromContainer(container),
        selectedId: null,
        records: [],
    };
    void loadAndRender(container, callbacks, state);
}

function readFilterFromContainer(container: HTMLElement): ApoStatusFilter {
    const raw = container.dataset['apoFilter'];
    return isApoStatusFilter(raw) ? raw : 'all';
}

function isApoStatusFilter(value: unknown): value is ApoStatusFilter {
    return typeof value === 'string' &&
        (APO_STATUS_FILTERS as readonly string[]).includes(value);
}

// ── DOM glue ──────────────────────────────────────────

async function loadAndRender(
    container: HTMLElement,
    callbacks: ApoHistoryCallbacks,
    state: PanelState
): Promise<void> {
    try {
        const result = await callbacks.list();
        if (!result.success) {
            container.innerHTML = buildErrorHtml(result.error ?? 'Unknown error');
            return;
        }
        state.records = result.records;
        renderBody(container, callbacks, state);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        container.innerHTML = buildErrorHtml(message);
    }
}

function renderBody(
    container: HTMLElement,
    callbacks: ApoHistoryCallbacks,
    state: PanelState
): void {
    const visible = filterByStatus(state.records, state.filter);
    container.innerHTML = buildHistoryHtml(visible, new Date(), {
        filter: state.filter,
        canAct: typeof callbacks.accept === 'function' && typeof callbacks.reject === 'function',
    });
    container.dataset['apoFilter'] = state.filter;
    wireInteractions(container, callbacks, state, visible);
    if (state.selectedId !== null) {
        const still = visible.find((r) => r.id === state.selectedId);
        if (still === undefined) {
            state.selectedId = null;
        } else {
            showDiff(container, still);
        }
    }
}

function wireInteractions(
    container: HTMLElement,
    callbacks: ApoHistoryCallbacks,
    state: PanelState,
    visible: readonly PromptOptimizationRecord[]
): void {
    const refresh = container.querySelector<HTMLButtonElement>('[data-action="apo-history-refresh"]');
    if (refresh !== null) {
        refresh.addEventListener('click', () => {
            renderApoHistoryPanel(container, callbacks);
        });
    }

    container.querySelectorAll<HTMLElement>('[data-apo-filter]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const next = chip.getAttribute('data-apo-filter');
            if (!isApoStatusFilter(next) || next === state.filter) return;
            state.filter = next;
            state.selectedId = null;
            renderBody(container, callbacks, state);
        });
    });

    const rows = Array.from(
        container.querySelectorAll<HTMLElement>('[data-history-row]')
    );
    rows.forEach((row) => {
        row.addEventListener('click', (ev) => {
            // Let accept/reject clicks bubble up to their own handlers
            // without also flipping the selection — avoids a double
            // re-render on the same user action.
            const target = ev.target as HTMLElement | null;
            if (target !== null && target.closest('[data-apo-action]') !== null) {
                return;
            }
            const id = row.getAttribute('data-history-row');
            if (id === null) return;
            state.selectedId = id;
            const record = visible.find((r) => r.id === id);
            if (record === undefined) return;
            focusRow(rows, row);
            showDiff(container, record);
        });
    });

    // Keyboard nav — scoped to the panel so it doesn't fight the global
    // palette (Cmd/Ctrl+K). ↑/↓ move selection, Enter expands, a/r act.
    container.addEventListener('keydown', (ev) => {
        if (ev.defaultPrevented) return;
        // Don't hijack typing inside an input/textarea — there aren't
        // any today, but this future-proofs the panel.
        const tag = (ev.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        const key = ev.key;
        if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter'
            && key !== 'a' && key !== 'r') return;

        const currentIndex = state.selectedId === null
            ? -1
            : visible.findIndex((r) => r.id === state.selectedId);

        if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (visible.length === 0) return;
            ev.preventDefault();
            const step = key === 'ArrowDown' ? 1 : -1;
            const nextIndex = currentIndex === -1
                ? (step === 1 ? 0 : visible.length - 1)
                : clamp(currentIndex + step, 0, visible.length - 1);
            const nextRecord = visible[nextIndex];
            if (nextRecord === undefined) return;
            state.selectedId = nextRecord.id;
            const nextRow = rows[nextIndex];
            if (nextRow === undefined) return;
            focusRow(rows, nextRow);
            showDiff(container, nextRecord);
            nextRow.scrollIntoView({ block: 'nearest' });
            return;
        }

        if (currentIndex === -1) return;
        const record = visible[currentIndex];
        if (record === undefined) return;

        if (key === 'Enter') {
            ev.preventDefault();
            showDiff(container, record);
            return;
        }

        if (record.status !== 'proposed') return;
        if (key === 'a') {
            ev.preventDefault();
            void runAction(container, callbacks, state, record.id, 'accept');
        } else if (key === 'r') {
            ev.preventDefault();
            void runAction(container, callbacks, state, record.id, 'reject');
        }
    });
    // Ensure keydown reaches us — rows are focusable via tabindex=0, and
    // the container itself gets tabindex so clicks focus the panel root.
    if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
    }

    container.querySelectorAll<HTMLButtonElement>('[data-apo-action="accept"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-apo-target');
            if (id === null) return;
            void runAction(container, callbacks, state, id, 'accept');
        });
    });
    container.querySelectorAll<HTMLButtonElement>('[data-apo-action="reject"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-apo-target');
            if (id === null) return;
            void runAction(container, callbacks, state, id, 'reject');
        });
    });
}

function focusRow(rows: readonly HTMLElement[], target: HTMLElement): void {
    rows.forEach((r) => r.classList.remove('apo-history-row-active'));
    target.classList.add('apo-history-row-active');
}

function showDiff(container: HTMLElement, record: PromptOptimizationRecord): void {
    const detail = container.querySelector<HTMLElement>('[data-apo-history-detail]');
    if (detail === null) return;
    detail.innerHTML = buildDiffHtml(record);
}

async function runAction(
    container: HTMLElement,
    callbacks: ApoHistoryCallbacks,
    state: PanelState,
    id: string,
    kind: 'accept' | 'reject'
): Promise<void> {
    const fn = kind === 'accept' ? callbacks.accept : callbacks.reject;
    if (typeof fn !== 'function') return;
    const verb = kind === 'accept' ? 'Apply this optimization to the active preset?' : 'Reject this optimization?';
    if (!window.confirm(verb)) return;

    const buttons = container.querySelectorAll<HTMLButtonElement>(
        `[data-apo-action][data-apo-target="${cssEscape(id)}"]`
    );
    buttons.forEach((b) => { b.disabled = true; });
    try {
        const result = await fn(id);
        if (!result.success) {
            window.alert(`APO ${kind} failed: ${result.error ?? 'unknown error'}`);
            buttons.forEach((b) => { b.disabled = false; });
            return;
        }
        // Reload records so the status badge (and available actions) reflect
        // the new state. Keep the selection on the same row if still visible.
        state.selectedId = id;
        await loadAndRender(container, callbacks, state);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.alert(`APO ${kind} failed: ${message}`);
        buttons.forEach((b) => { b.disabled = false; });
    }
}

function cssEscape(raw: string): string {
    // Minimal escaper for our UUID ids — we don't need the full CSS.escape
    // shim. UUIDs only contain hex + dashes, so this is a belt-and-braces
    // guard in case a future id format introduces special chars.
    return raw.replace(/["\\]/g, '\\$&');
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

/**
 * Pure filter — exported so tests don't need to stub the DOM. Returns
 * the original array when `filter === 'all'` so the common path is a
 * zero-copy identity.
 */
export function filterByStatus(
    records: readonly PromptOptimizationRecord[],
    filter: ApoStatusFilter
): readonly PromptOptimizationRecord[] {
    if (filter === 'all') return records;
    return records.filter((r) => r.status === filter);
}

// ── Pure HTML builders ────────────────────────────────

export interface BuildHistoryOptions {
    readonly filter?: ApoStatusFilter;
    readonly canAct?: boolean;
}

export function buildHistoryHtml(
    records: readonly PromptOptimizationRecord[],
    now: Date,
    options: BuildHistoryOptions = {}
): string {
    const filter = options.filter ?? 'all';
    const canAct = options.canAct ?? false;
    const header = `
        <div class="apo-history-header">
            <h3>APO Optimization History</h3>
            <button type="button" class="btn-secondary" data-action="apo-history-refresh">Refresh</button>
        </div>
        ${buildFilterChipsHtml(filter)}
    `;

    if (records.length === 0) {
        if (filter === 'all') {
            // APO is opt-in (decision #48). Off by default. Tell the
            // user how to turn it on instead of showing a blank panel.
            return `
                ${header}
                <div class="apo-empty-state">
                    <p><strong>Automatic Prompt Optimization is disabled.</strong></p>
                    <p class="hint">
                        APO runs nightly and proposes prompt mutations for the deterministic-quality
                        agents (scout, herald, pixel). All proposals require human approval before
                        being applied.
                    </p>
                    <p class="hint">
                        To enable, set <code>KAGEOPS_APO_ENABLED=1</code> in your environment and
                        restart the app. APO will run on the next midnight UTC schedule. Eval model:
                        <code>KAGEOPS_APO_EVAL_MODEL</code> (defaults to gpt-4o-mini via OpenRouter).
                    </p>
                    <p class="hint">
                        See decision #48 in
                        <code>docs/architecture/decision-register.md</code> for the full design
                        rationale.
                    </p>
                </div>
                <div class="apo-history-detail" data-apo-history-detail></div>
            `;
        }
        return `
            ${header}
            <div class="empty-state">${escapeHtml(`No optimizations match the "${filter}" filter.`)}</div>
            <div class="apo-history-detail" data-apo-history-detail></div>
        `;
    }

    const rows = records.map((r) => buildRowHtml(r, now, canAct)).join('');
    const headClass = canAct ? 'apo-history-row-head apo-history-row--actions' : 'apo-history-row-head';
    const actionHead = canAct ? '<span>Actions</span>' : '';
    return `
        ${header}
        <div class="apo-history-list">
            <div class="apo-history-row ${headClass}">
                <span>When</span>
                <span>Agent</span>
                <span>Status</span>
                <span class="apo-history-delta">Δ Reward</span>
                <span>Runs</span>
                ${actionHead}
            </div>
            ${rows}
        </div>
        <div class="apo-history-detail" data-apo-history-detail>
            <div class="empty-state">Select a row to view the prompt diff.</div>
        </div>
    `;
}

export function buildFilterChipsHtml(active: ApoStatusFilter): string {
    const chips = APO_STATUS_FILTERS.map((f) => {
        const cls = f === active ? 'apo-filter-chip apo-filter-chip--active' : 'apo-filter-chip';
        const label = f === 'all' ? 'All' : f === 'rolled_back' ? 'rolled back' : f;
        return `<button type="button" class="${cls}" data-apo-filter="${f}">${escapeHtml(label)}</button>`;
    }).join('');
    return `<div class="apo-filter-bar" role="tablist" aria-label="Filter optimizations by status">${chips}</div>`;
}

function buildRowHtml(r: PromptOptimizationRecord, now: Date, canAct: boolean): string {
    const deltaClass = r.rewardDelta > 0 ? 'apo-delta-pos' : (r.rewardDelta < 0 ? 'apo-delta-neg' : '');
    const statusClass = statusBadgeClass(r.status);
    const rowClass = canAct ? 'apo-history-row apo-history-row--actions' : 'apo-history-row';
    const actions = canAct ? buildRowActionsHtml(r) : '';
    return `
        <div class="${rowClass}" data-history-row="${escapeHtml(r.id)}" role="button" tabindex="0">
            <span title="${escapeHtml(r.createdAt)}">${escapeHtml(formatRelative(r.createdAt, now))}</span>
            <span class="apo-agent">${escapeHtml(r.agentName)}</span>
            <span><span class="apo-status-badge ${statusClass}">${escapeHtml(r.status)}</span></span>
            <span class="apo-history-delta ${deltaClass}">${formatReward(r.rewardDelta)}</span>
            <span>${r.rounds}×${r.beamWidth}·n=${r.nSamples}</span>
            ${actions}
        </div>
    `;
}

function buildRowActionsHtml(r: PromptOptimizationRecord): string {
    if (r.status !== 'proposed') {
        return '<span class="apo-history-actions apo-history-actions--muted">—</span>';
    }
    const id = escapeHtml(r.id);
    return `
        <span class="apo-history-actions">
            <button type="button" class="btn-primary apo-action-btn"
                    data-apo-action="accept" data-apo-target="${id}"
                    title="Apply (a)">Accept</button>
            <button type="button" class="btn-secondary apo-action-btn"
                    data-apo-action="reject" data-apo-target="${id}"
                    title="Reject (r)">Reject</button>
        </span>
    `;
}

export function buildDiffHtml(r: PromptOptimizationRecord): string {
    const diffRows = diffLines(r.baselinePrompt, r.optimizedPrompt);
    const diffHtml = diffRows.map((row) => {
        const cls = row.kind === 'added'
            ? 'apo-diff-add'
            : row.kind === 'removed'
                ? 'apo-diff-del'
                : 'apo-diff-same';
        const sigil = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' ';
        return `<div class="apo-diff-line ${cls}"><span class="apo-diff-sigil">${sigil}</span><span>${escapeHtml(row.text)}</span></div>`;
    }).join('');

    const appliedLabel = r.appliedAt === null
        ? '—'
        : escapeHtml(r.appliedAt);

    return `
        <div class="apo-diff-meta">
            <div><strong>Agent:</strong> ${escapeHtml(r.agentName)}</div>
            <div><strong>Status:</strong> <span class="apo-status-badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></div>
            <div><strong>Baseline reward:</strong> ${formatReward(r.baselineReward)}</div>
            <div><strong>Optimized reward:</strong> ${formatReward(r.optimizedReward)}</div>
            <div><strong>Δ:</strong> <span class="${r.rewardDelta > 0 ? 'apo-delta-pos' : r.rewardDelta < 0 ? 'apo-delta-neg' : ''}">${formatReward(r.rewardDelta)}</span></div>
            <div><strong>Search:</strong> beam=${r.beamWidth}, branch=${r.branchFactor}, rounds=${r.rounds}</div>
            <div><strong>Samples:</strong> ${r.nSamples}</div>
            <div><strong>Created:</strong> ${escapeHtml(r.createdAt)}</div>
            <div><strong>Applied:</strong> ${appliedLabel}</div>
        </div>
        <div class="apo-diff-body">
            ${diffHtml}
        </div>
    `;
}

function buildErrorHtml(message: string): string {
    return `
        <div class="apo-history-header">
            <h3>APO Optimization History</h3>
            <button type="button" class="btn-secondary" data-action="apo-history-refresh">Refresh</button>
        </div>
        <div class="error-banner">Failed to load APO history: ${escapeHtml(message)}</div>
    `;
}

// ── Pure helpers ──────────────────────────────────────

export function statusBadgeClass(status: PromptOptimizationStatus): string {
    switch (status) {
        case 'accepted': return 'apo-status-accepted';
        case 'rolled_back': return 'apo-status-rolled-back';
        case 'proposed':
        default: return 'apo-status-proposed';
    }
}

export function formatReward(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(4)}`;
}

export function formatRelative(iso: string, now: Date): string {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return iso;
    const deltaMs = now.getTime() - then.getTime();
    const abs = Math.abs(deltaMs);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (abs < minute) return 'just now';
    if (abs < hour) return `${Math.floor(abs / minute)}m ago`;
    if (abs < day) return `${Math.floor(abs / hour)}h ago`;
    if (abs < 7 * day) return `${Math.floor(abs / day)}d ago`;
    return then.toISOString().slice(0, 10);
}

export function escapeHtml(raw: string): string {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Diff algorithm ────────────────────────────────────

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
    readonly kind: DiffKind;
    readonly text: string;
}

/**
 * Line-level LCS diff. Produces a unified list of lines with kind:
 * 'same' | 'added' | 'removed'. Good enough for prompt comparison where
 * prompts are typically 5–50 lines long; O(n·m) time and memory.
 */
export function diffLines(a: string, b: string): readonly DiffLine[] {
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const n = aLines.length;
    const m = bLines.length;

    // LCS table — dp[i][j] = LCS of aLines[0..i-1] and bLines[0..j-1].
    const dp: number[][] = [];
    for (let i = 0; i <= n; i++) {
        const row: number[] = new Array(m + 1).fill(0);
        dp.push(row);
    }
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (aLines[i - 1] === bLines[j - 1]) {
                dp[i]![j] = dp[i - 1]![j - 1]! + 1;
            } else {
                dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
            }
        }
    }

    // Backtrack.
    const out: DiffLine[] = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
        if (aLines[i - 1] === bLines[j - 1]) {
            out.push({ kind: 'same', text: aLines[i - 1]! });
            i--; j--;
        } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
            out.push({ kind: 'removed', text: aLines[i - 1]! });
            i--;
        } else {
            out.push({ kind: 'added', text: bLines[j - 1]! });
            j--;
        }
    }
    while (i > 0) {
        out.push({ kind: 'removed', text: aLines[i - 1]! });
        i--;
    }
    while (j > 0) {
        out.push({ kind: 'added', text: bLines[j - 1]! });
        j--;
    }

    return out.reverse();
}
