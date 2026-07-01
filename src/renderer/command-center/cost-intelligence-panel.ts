import { modelLabel } from '../../shared/model-registry';

/**
 * KageOps Cost Intelligence Panel
 *
 * Displays operational AI spend (what KageOps costs to run) sourced from
 * LiteLLM_SpendLogs → operational_costs table.
 *
 * Layout:
 *   ┌──────────┐  ┌──────────┐  ┌──────────┐
 *   │ Today    │  │ Week     │  │ Month    │
 *   └──────────┘  └──────────┘  └──────────┘
 *   BY AGENT                BY PROVIDER
 *   forge  ████ $0.42       claude ██████ $0.61
 *   scout  ██   $0.18       openai ███    $0.15
 */

// ── Types (mirrored from orchestrator — browser-safe, no DB imports) ──

export interface AgentCostEntry {
    readonly agent: string;
    readonly totalCostUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly callCount: number;
}

export interface ProviderCostEntry {
    readonly provider: string;
    readonly totalCostUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly callCount: number;
}

export interface ProjectCostEntry {
    readonly projectId: string;
    readonly projectName: string | null;
    readonly totalCostUsd: number;
    readonly callCount: number;
}

export interface OperationalCostSummary {
    readonly totalToday: number;
    readonly totalThisWeek: number;
    readonly totalThisMonth: number;
    readonly byAgent: readonly AgentCostEntry[];
    readonly byProvider: readonly ProviderCostEntry[];
    readonly byProject: readonly ProjectCostEntry[];
    readonly lastSyncAt: string | null;
}

/** One row per active/paused project returned by the run-budgets IPC. */
export interface RunBudgetEntry {
    readonly projectId: string;
    readonly projectName: string;
    readonly status: string;
    /** DB-persisted cap; null means the env fallback is in effect. */
    readonly capUsd: number | null;
    readonly spentUsd: number;
    readonly tokensOut: number;
}

/** Callbacks the panel needs from the renderer to save edits. */
export interface RunBudgetControls {
    readonly setProjectBudget: (
        projectId: string,
        capUsd: number
    ) => Promise<{ ok: boolean; capUsd?: number; clamped?: boolean; error?: string }>;
    readonly refresh: () => void;
}

/** Header context: which preset + which model each agent is running.
 *  Surfacing this in the cost panel answers the most common user
 *  question — "what models are you actually using?" — without making
 *  them tab over to Model Routing.                                   */
export interface CostHeaderContext {
    readonly activePreset: string | null;
    readonly agents: readonly { readonly name: string; readonly model: string; readonly provider: string }[];
    /** When true, render an explainer note saying $0 is expected. */
    readonly subscriptionMode: boolean;
    /** Click handler that should switch the user to Model Routing. */
    readonly onOpenRouting?: () => void;
}

// ── SVG icons ─────────────────────────────────────────

const SVG_TOKEN   = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v5M5.5 8h5"/></svg>`;
const SVG_PRICING = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v12M5 4.5h4.5a2 2 0 0 1 0 4H5m0 0h5a2 2 0 0 1 0 4H5"/></svg>`;
const SVG_SYNCI   = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 8A5 5 0 1 1 8 3M13 3v5H8"/></svg>`;

// ── Render ────────────────────────────────────────────

/**
 * Render the Cost Intelligence panel into the given container element.
 *
 * When `budgets` is provided and non-empty, the panel also renders a
 * "Run Budgets" section for every active/paused project — live
 * consumption bars plus an editable cap that writes back through
 * `controls.setProjectBudget`. The poller in headless-runner re-reads
 * the DB cap each tick, so edits take effect in a few seconds without
 * restarting the run.
 */
export function renderCostIntelligencePanel(
    container: HTMLElement,
    summary: OperationalCostSummary | null,
    budgets: readonly RunBudgetEntry[] = [],
    controls?: RunBudgetControls,
    header?: CostHeaderContext
): void {
    if (summary === null) {
        container.innerHTML = '<div class="empty-state">Cost data unavailable</div>';
        return;
    }

    const lastSync = summary.lastSyncAt !== null
        ? formatTime(summary.lastSyncAt)
        : 'Never';

    // Sum tokens across all agents — useful when cost is $0 (subscription or local)
    // because tokens are still the user's actual quota burn.
    const totalTokensIn  = summary.byAgent.reduce((s, a) => s + a.tokensIn,  0);
    const totalTokensOut = summary.byAgent.reduce((s, a) => s + a.tokensOut, 0);
    const totalTokens    = totalTokensIn + totalTokensOut;

    container.innerHTML = `
        ${header !== undefined ? renderModelsInUse(header) : ''}
        <div class="ci-totals">
            <div class="ci-total-card ci-total-card--today">
                <div class="ci-total-card__period">Today</div>
                <div class="ci-amount">${formatCost(summary.totalToday)}</div>
                <div class="ci-total-card__calls">${countCalls(summary.byAgent)} calls</div>
            </div>
            <div class="ci-total-card">
                <div class="ci-total-card__period">This week</div>
                <div class="ci-amount">${formatCost(summary.totalThisWeek)}</div>
            </div>
            <div class="ci-total-card">
                <div class="ci-total-card__period">This month</div>
                <div class="ci-amount">${formatCost(summary.totalThisMonth)}</div>
                <div class="ci-total-card__calls">${formatTokens(totalTokens)} tokens</div>
            </div>
        </div>
        ${header?.subscriptionMode === true && summary.totalThisMonth < 0.001 ? `
            <div class="ci-explainer">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5.5v.5"/></svg>
                <span>
                    Spend stays at $0 because the active preset routes through subscription
                    or local providers (Claude CLI, Ollama).
                    <strong style="color:var(--text)">~${formatTokens(totalTokens)} tokens</strong>
                    burned this month against your quota.
                    Switch to a metered preset in
                    <a href="#" class="ci-routing-link">Model Routing</a> to track per-call cost.
                </span>
            </div>` : ''}
        ${budgets.length > 0 ? renderRunBudgets(budgets) : ''}
        <div class="ci-breakdowns">
            <div class="ci-breakdown">
                <div class="ci-section-header">
                    <span class="ci-breakdown-title">BY AGENT</span>
                    <span class="ci-breakdown-sub">${summary.byAgent.length} agents</span>
                </div>
                ${renderBarList(summary.byAgent, (e) => e.agent, (e) => e.totalCostUsd, (e) => e.callCount)}
            </div>
            <div class="ci-breakdown">
                <div class="ci-section-header">
                    <span class="ci-breakdown-title">BY PROVIDER</span>
                    <span class="ci-breakdown-sub">${summary.byProvider.length} providers</span>
                </div>
                ${renderBarList(summary.byProvider, (e) => e.provider, (e) => e.totalCostUsd, (e) => e.callCount)}
            </div>
        </div>
        ${renderInfoCards(lastSync)}
    `;

    if (budgets.length > 0 && controls !== undefined) {
        wireBudgetControls(container, budgets, controls);
    }

    // Wire "Model Routing" link + the header preset pill so users can
    // reach the routing screen from Cost Intelligence in one click.
    if (header?.onOpenRouting !== undefined) {
        const open = header.onOpenRouting;
        container.querySelectorAll<HTMLElement>('.ci-routing-link, .ci-models-link, .ci-preset-pill')
            .forEach((el) => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    open();
                });
            });
    }
}

// ── Models In Use header ─────────────────────────────

function renderModelsInUse(header: CostHeaderContext): string {
    const presetLabel = header.activePreset !== null && header.activePreset !== ''
        ? escapeHtml(header.activePreset)
        : 'Custom';
    const rows = header.agents.length === 0
        ? '<div class="empty-state ci-models-empty">No agents loaded</div>'
        : header.agents.map((a) => `
            <div class="ci-model-row">
                <span class="ci-model-agent">${escapeHtml(a.name)}</span>
                <div class="ci-model-info">
                    <span class="ci-model-provider-badge">${escapeHtml(a.provider)}</span>
                    <span class="ci-model-name" title="${escapeHtml(a.model)}">${escapeHtml(modelLabel(a.model))}</span>
                </div>
            </div>
        `).join('');

    return `
        <div class="ci-models">
            <div class="ci-models-head">
                <div class="ci-models-head-left">
                    <span class="ci-breakdown-title">MODELS IN USE</span>
                </div>
                <div class="ci-models-head-right">
                    <button type="button" class="ci-preset-pill" title="Click to change preset">
                        <span class="ci-preset-pill__label">PRESET</span>
                        <span class="ci-preset-pill__value">${presetLabel}</span>
                    </button>
                    <a href="#" class="ci-models-link">Edit</a>
                </div>
            </div>
            <div class="ci-model-list">${rows}</div>
        </div>
    `;
}

// ── Run Budgets section ──────────────────────────────

function renderRunBudgets(budgets: readonly RunBudgetEntry[]): string {
    const rows = budgets.map((b) => {
        // Cap comes from DB; null means the env fallback is in effect.
        // Display "—" in that case and let the input be editable anyway.
        const hasCap = typeof b.capUsd === 'number' && b.capUsd > 0;
        const cap = hasCap ? (b.capUsd as number) : 0;
        const pct = hasCap ? Math.min(100, Math.round((b.spentUsd / cap) * 100)) : 0;
        const severity =
            pct >= 85 ? 'ci-bar-crit' : pct >= 60 ? 'ci-bar-warn' : 'ci-bar-ok';
        const statusBadge = b.status === 'paused'
            ? '<span class="ci-budget-badge ci-badge-paused">paused</span>'
            : '<span class="ci-budget-badge ci-badge-active">active</span>';

        const defaultVal = hasCap ? (b.capUsd as number).toFixed(2) : '';
        return `
            <div class="ci-budget-row" data-project-id="${escapeHtml(b.projectId)}">
                <div class="ci-budget-head">
                    <span class="ci-budget-name" title="${escapeHtml(b.projectName)}">${escapeHtml(truncate(b.projectName, 28))}</span>
                    ${statusBadge}
                    <span class="ci-budget-spend">${formatCost(b.spentUsd)} / ${hasCap ? formatCost(cap) : '—'}</span>
                </div>
                <div class="ci-bar-track">
                    <div class="ci-bar-fill ${severity}" style="width:${pct}%"></div>
                </div>
                <div class="ci-budget-controls">
                    <label class="ci-budget-label">
                        Cap $
                        <input
                            type="number"
                            class="ci-budget-input"
                            min="0.01"
                            max="100"
                            step="0.05"
                            value="${defaultVal}"
                            placeholder="0.25"
                            aria-label="Budget cap in USD for ${escapeHtml(b.projectName)}"
                        />
                    </label>
                    <button class="ci-budget-save" type="button">Save</button>
                    <span class="ci-budget-feedback" aria-live="polite"></span>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="ci-budgets">
            <div class="ci-breakdown-title">RUN BUDGETS</div>
            ${rows}
        </div>
    `;
}

function wireBudgetControls(
    container: HTMLElement,
    budgets: readonly RunBudgetEntry[],
    controls: RunBudgetControls
): void {
    const rows = container.querySelectorAll<HTMLElement>('.ci-budget-row');
    rows.forEach((row) => {
        const projectId = row.dataset['projectId'] ?? '';
        const input = row.querySelector<HTMLInputElement>('.ci-budget-input');
        const button = row.querySelector<HTMLButtonElement>('.ci-budget-save');
        const feedback = row.querySelector<HTMLElement>('.ci-budget-feedback');
        if (input === null || button === null || feedback === null) return;

        button.addEventListener('click', async () => {
            const capUsd = Number.parseFloat(input.value);
            if (!Number.isFinite(capUsd) || capUsd <= 0) {
                feedback.textContent = 'Invalid cap';
                feedback.className = 'ci-budget-feedback ci-budget-err';
                return;
            }
            button.disabled = true;
            feedback.textContent = 'Saving…';
            feedback.className = 'ci-budget-feedback';
            const res = await controls.setProjectBudget(projectId, capUsd);
            button.disabled = false;
            if (res.ok) {
                const savedAt = typeof res.capUsd === 'number' ? res.capUsd : capUsd;
                feedback.textContent = res.clamped === true
                    ? `Saved (clamped to $${savedAt.toFixed(2)})`
                    : `Saved — applies within ~3s`;
                feedback.className = 'ci-budget-feedback ci-budget-ok';
                // Suppress reference to avoid shadow of budgets param in closure
                void budgets;
                controls.refresh();
            } else {
                feedback.textContent = res.error ?? 'Save failed';
                feedback.className = 'ci-budget-feedback ci-budget-err';
            }
        });
    });
}

// ── Bar list helper ───────────────────────────────────

function renderBarList<T>(
    entries: readonly T[],
    getLabel: (entry: T) => string,
    getValue: (entry: T) => number,
    getCalls?: (entry: T) => number
): string {
    if (entries.length === 0) {
        return '<div class="empty-state">No data</div>';
    }

    const maxValue = Math.max(...entries.map(getValue), 0.000001);

    return entries.map((entry) => {
        const value = getValue(entry);
        const pct = Math.round((value / maxValue) * 100);
        const label = getLabel(entry);
        const isZero = value < 0.000001;
        const calls = getCalls !== undefined ? getCalls(entry) : null;

        return `
            <div class="ci-bar-row">
                <span class="ci-bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                <div class="ci-bar-track">
                    <div class="ci-bar-fill ${isZero ? 'ci-bar-zero' : ''}" style="width:${pct}%"></div>
                </div>
                <span class="ci-bar-value">${isZero ? '—' : formatCost(value)}</span>
                ${calls !== null && calls > 0 ? `<span class="ci-bar-calls">${calls}×</span>` : ''}
            </div>
        `;
    }).join('');
}

function renderInfoCards(lastSync: string): string {
    return `
        <div class="ci-info-section">
            <div class="ci-section-header" style="margin-bottom:10px;">
                <span class="ci-breakdown-title">HOW THIS IS CALCULATED</span>
            </div>
            <div class="ci-info-cards">
                <div class="ci-info-card">
                    <div class="ci-info-card__icon">${SVG_TOKEN}</div>
                    <div class="ci-info-card__title">Token Tracking</div>
                    <p class="ci-info-card__body">Every AI call logs input tokens, output tokens, the model used, and which Autonaut made the call. Forge and Pixel typically dominate spend. Vigil dominating is a signal to tighten its review prompt.</p>
                </div>
                <div class="ci-info-card">
                    <div class="ci-info-card__icon">${SVG_PRICING}</div>
                    <div class="ci-info-card__title">Pricing Table</div>
                    <p class="ci-info-card__body">Dollar amounts come from KageOps' built-in rate table, not your provider invoice. Typically within ±2% for OpenRouter. Claude CLI always shows $0 — subscription billing is flat-fee with no per-call cost to track.</p>
                </div>
                <div class="ci-info-card">
                    <div class="ci-info-card__icon">${SVG_SYNCI}</div>
                    <div class="ci-info-card__title">Last Sync · ${escapeHtml(lastSync)}</div>
                    <p class="ci-info-card__body">When KageOps last pulled cross-provider cost data. "Never" is fine — local tracking works without cloud sync. For expense reconciliation, cross-check against your OpenRouter dashboard or Anthropic console.</p>
                </div>
            </div>
        </div>`;
}

function countCalls(agents: readonly AgentCostEntry[]): number {
    return agents.reduce((sum, a) => sum + a.callCount, 0);
}

// ── Utilities ─────────────────────────────────────────

function formatCost(usd: number): string {
    if (usd < 0.001) return '$0.00';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
    return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}M`;
}

function formatTime(isoString: string): string {
    try {
        const d = new Date(isoString);
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
        return '--:--';
    }
}

function truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
