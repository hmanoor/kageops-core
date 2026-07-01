/**
 * KageOps Command Center — Autonauts View (AU)
 *
 * Full-page agent dossier — left sidebar lists agents, right side shows
 * a scrollable "story card" with hero portrait, speciality scorecard,
 * model config, performance stats, recent missions, and a chat input.
 */

import { marked } from 'marked';
import { AGENT_PROFILES, type AgentProfile } from './agent-profiles';
import { getSigilHtml } from './sigils';
import { MODELS, PROVIDERS, PRESETS, getPresetById, modelLabel, costTierLabel, presetModelIds } from '../../shared/model-registry';
import { ThinkingRotator } from '../shared/thinking-rotator';
import {
    renderIntercept,
    wireIntercept,
    resetInterceptState,
    type AgentStreamEvent,
    type InterceptAckEvent,
} from './intercept-panel';

// ── Types ────────────────────────────────────────────

export interface AutonautsApi {
    getAgents(): Promise<readonly AgentInfo[]>;
    getAgentDetail(name: string): Promise<AgentDetailInfo | null>;
    getMatrix(): Promise<readonly MatrixEntry[]>;
    getAgentModelConfigs(): Promise<readonly AgentModelEntry[]>;
    getAgentConfigs(): Promise<readonly AgentConfigEntry[]>;
    setAgentModel(name: string, model: string, provider: string): Promise<{ success: boolean; error?: string }>;
    testAgentModel(name: string, model: string, provider: string): Promise<{ success: boolean; latencyMs?: number; error?: string }>;
    setAgentEnabled(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
    sendToSensei(msg: string): Promise<string>;
    getOperationalCosts(days?: number): Promise<CostSummary | null>;
    listPresets(): Promise<{ presets: readonly { readonly name: string }[]; active: string | null }>;
    // Agent Intercept (v2.3)
    pauseAgent(name: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    resumeAgent(name: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    injectGuidance(name: string, taskId: string, guidance: string): Promise<{ success: boolean; error?: string }>;
    takeoverTask(name: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    handbackTask(taskId: string, name: string, guidance?: string): Promise<{ success: boolean; error?: string }>;
    onAgentStreamEvent(callback: (event: AgentStreamEvent) => void): void;
    onInterceptAck(callback: (ack: InterceptAckEvent) => void): void;
    getAgentStreamHistory(args: { agent: string; taskId?: string | null; limit?: number }): Promise<readonly AgentStreamEvent[]>;
}

interface AgentInfo {
    readonly name: string;
    readonly role: string;
    readonly status: 'idle' | 'busy' | 'error';
    readonly currentTaskTitle: string | null;
    readonly model?: string | null;
    readonly provider?: string | null;
}

interface AgentDetailInfo {
    readonly name: string;
    readonly role: string;
    readonly status: 'idle' | 'busy' | 'error';
    readonly model: string | null;
    readonly provider: string | null;
    readonly currentTask: AgentDetailTask | null;
    readonly recentTasks: readonly AgentDetailTask[];
    readonly stats: AgentStats;
}

interface AgentDetailTask {
    readonly id: string;
    readonly title: string;
    readonly taskType: string;
    readonly phase: string;
    readonly status: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly qualityScore: number | null;
    readonly hasOutput: boolean;
    readonly responseText: string | null;
    readonly outputPath: string | null;
}

interface AgentStats {
    readonly totalCompleted: number;
    readonly totalFailed: number;
    readonly avgQualityScore: number | null;
}

interface MatrixEntry {
    readonly agent: string;
    readonly skill: string;
    readonly score: number;
}

interface AgentModelEntry {
    readonly name: string;
    readonly model: string;
    readonly provider: string;
    readonly fallbackModels: readonly string[];
}

interface AgentConfigEntry {
    readonly name: string;
    readonly role: string;
    readonly status: 'idle' | 'busy' | 'error';
    readonly model: string;
    readonly enabled: boolean;
}

interface AgentCostEntry {
    readonly agent: string;
    readonly totalCostUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly callCount: number;
}


interface CostSummary {
    readonly totalToday: number;
    readonly totalThisWeek: number;
    readonly totalThisMonth: number;
    readonly byAgent: readonly AgentCostEntry[];
}

// ── Skill labels (for heatmap) ───────────────────────

const SKILL_LABELS: Readonly<Record<string, string>> = {
    strategy: 'Strategy',
    architecture: 'Architecture',
    frontend: 'Frontend',
    backend: 'Backend',
    testing: 'Testing',
    devops: 'DevOps',
    security: 'Security',
    data: 'Data',
    design: 'Design',
    marketing: 'Marketing',
    documentation: 'Docs',
    research: 'Research',
};

// ── Models and providers — derived from shared registry ──────────

const KNOWN_MODELS: readonly string[] = [
    // CLI aliases (resolved by the Claude binary at runtime)
    'claude-cli/sonnet',
    'claude-cli/haiku',
    'claude-cli/opus',
    // Registry models
    ...MODELS.map((m) => m.id),
];

const KNOWN_PROVIDERS: readonly string[] = PROVIDERS.map((p) => p.id);

const AGENT_ORDER: readonly string[] = [
    'sensei', 'scout', 'blueprint', 'pixel', 'forge', 'cipher', 'aegis', 'vigil', 'herald',
];

// ── State ────────────────────────────────────────────

let selectedAgent: string | null = 'scout'; // null = Team Overview
interface ChatEntry {
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly timestamp: string;
}
let chatMessages: readonly ChatEntry[] = [];


// ── Public API ───────────────────────────────────────

export function initAutonautsView(container: HTMLElement, api: AutonautsApi): void {
    container.innerHTML = `
        <div class="au-view">
            <aside class="au-sidebar" id="au-sidebar">
                <div class="au-sidebar-header">KageOps Agents</div>
                <div class="au-sidebar-list" id="au-sidebar-list">
                    <div class="empty-state">Loading\u2026</div>
                </div>
            </aside>
            <main class="au-main" id="au-main">
                <div class="au-main-scroll" id="au-main-scroll">
                    <div class="empty-state">Select an agent</div>
                </div>
            </main>
        </div>`;

    void loadSidebar(container, api);
}

// ── Sidebar ──────────────────────────────────────────

async function loadSidebar(root: HTMLElement, api: AutonautsApi): Promise<void> {
    const listEl = root.querySelector('#au-sidebar-list') as HTMLElement;
    const [agentsResult, configsResult] = await Promise.allSettled([
        api.getAgents(),
        api.getAgentConfigs(),
    ]);

    const agents: readonly AgentInfo[] =
        agentsResult.status === 'fulfilled' ? agentsResult.value : [];
    const configs: readonly AgentConfigEntry[] =
        configsResult.status === 'fulfilled' ? configsResult.value : [];

    // Build a lookup for enabled status
    const enabledMap = new Map<string, boolean>();
    for (const c of configs) {
        enabledMap.set(c.name.toLowerCase(), c.enabled);
    }

    // ── Sensei (Orchestrator) — pinned at top ────────────────
    const senseiInfo = agents.find((a) => a.name.toLowerCase() === 'sensei');
    const senseiStatus = senseiInfo?.status ?? 'idle';
    const senseiSelected = selectedAgent === 'sensei' ? ' au-agent-row--selected' : '';
    const senseiBlock = `
        <div class="au-sidebar-section-label">Orchestrator</div>
        <div class="au-agent-row au-agent-row--sensei${senseiSelected} au-agent-row--${esc(senseiStatus)}"
             data-agent="sensei" data-status="${esc(senseiStatus)}">
            <span class="au-agent-thumb sigil-host">${getSigilHtml('sensei', { label: 'Sensei' })}</span>
            <div class="au-agent-info">
                <span class="au-agent-name">Sensei</span>
                <span class="au-agent-title">The Orchestrator</span>
            </div>
            <span class="au-status-dot au-status--${esc(senseiStatus)}" title="${esc(senseiStatus)}"></span>
        </div>
        <div class="au-sidebar-divider"></div>`;

    // Team Overview entry
    const teamSelected = selectedAgent === null ? ' au-agent-row--selected' : '';
    const teamRow = `
        <div class="au-sidebar-section-label">Autonauts</div>
        <div class="au-agent-row au-agent-row--team${teamSelected}" data-agent="__team__">
            <span class="au-agent-thumb au-agent-thumb--team">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="7" cy="7" r="3"/><circle cx="14" cy="7" r="3"/>
                    <path d="M1 17c0-3.3 2.7-6 6-6h6c3.3 0 6 2.7 6 6"/>
                </svg>
            </span>
            <div class="au-agent-info">
                <span class="au-agent-name">Team</span>
                <span class="au-agent-title">Roster &amp; Analytics</span>
            </div>
        </div>`;

    // Render in canonical order, falling back to profiles for agents not yet online
    const agentKeys = AGENT_ORDER.filter((k) => k !== 'sensei');
    const rows = agentKeys.map((key) => {
        const info = agents.find((a) => a.name.toLowerCase() === key);
        const profile = AGENT_PROFILES[key];
        const status = info?.status ?? 'idle';
        const enabled = enabledMap.get(key) ?? true;
        const name = info?.name ?? capitalize(key);
        const title = profile?.title ?? info?.role ?? '';
        const disabledCls = enabled ? '' : ' au-agent-row--disabled';
        const selectedCls = key === selectedAgent ? ' au-agent-row--selected' : '';
        // Add an explicit `au-agent-row--<status>` class so CSS can
        // visibly highlight the agent currently doing work without
        // depending on attribute selectors.
        const statusCls = ` au-agent-row--${esc(status)}`;
        return `
            <div class="au-agent-row${selectedCls}${disabledCls}${statusCls}" data-agent="${esc(key)}" data-status="${esc(status)}">
                <span class="au-agent-thumb sigil-host">${getSigilHtml(key, { label: name })}</span>
                <div class="au-agent-info">
                    <span class="au-agent-name">${esc(name)}</span>
                    <span class="au-agent-title">${esc(title)}</span>
                </div>
                <span class="au-status-dot au-status--${esc(status)}" title="${esc(status)}"></span>
            </div>`;
    });

    listEl.innerHTML = senseiBlock + teamRow + rows.join('');

    // Attach click handlers
    listEl.querySelectorAll<HTMLElement>('.au-agent-row').forEach((row) => {
        row.addEventListener('click', () => {
            const key = row.dataset['agent'];
            if (key === undefined) return;
            // Update sidebar selection
            listEl.querySelectorAll('.au-agent-row').forEach((r) =>
                r.classList.toggle('au-agent-row--selected', r === row));
            if (key === '__team__') {
                selectedAgent = null;
                void loadTeamOverview(root, api);
            } else {
                selectedAgent = key;
                void loadDossier(root, api);
            }
        });
    });

    // Load initial view
    if (selectedAgent === null) {
        void loadTeamOverview(root, api);
    } else {
        void loadDossier(root, api);
    }
}

// ── Dossier (main panel) ─────────────────────────────

async function loadDossier(root: HTMLElement, api: AutonautsApi): Promise<void> {
    const mainScroll = root.querySelector('#au-main-scroll') as HTMLElement;
    if (mainScroll === null) return;
    if (selectedAgent === null) { void loadTeamOverview(root, api); return; }
    mainScroll.innerHTML = '<div class="empty-state">Loading dossier\u2026</div>';

    const key = selectedAgent;
    const profile: AgentProfile | undefined = AGENT_PROFILES[key];

    // Each query gets a 10s timeout so a single hanging IPC call doesn't block the page
    const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
        Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    try {
    // Fire all queries in parallel
    const [detailResult, matrixResult, modelsResult, configsResult, costsResult, presetsResult] =
        await Promise.allSettled([
            timeout(api.getAgentDetail(key), 10_000),
            timeout(api.getMatrix(), 10_000),
            timeout(api.getAgentModelConfigs(), 10_000),
            timeout(api.getAgentConfigs(), 10_000),
            timeout(api.getOperationalCosts(30), 10_000),
            timeout(api.listPresets(), 10_000),
        ]);

    const detail: AgentDetailInfo | null =
        detailResult.status === 'fulfilled' ? detailResult.value : null;
    const matrixRows: readonly MatrixEntry[] =
        matrixResult.status === 'fulfilled' ? matrixResult.value : [];
    const modelConfigs: readonly AgentModelEntry[] =
        modelsResult.status === 'fulfilled' ? modelsResult.value : [];
    const agentConfigs: readonly AgentConfigEntry[] =
        configsResult.status === 'fulfilled' ? configsResult.value : [];
    const costs: CostSummary | null =
        costsResult.status === 'fulfilled' ? costsResult.value : null;
    const activePreset: string | null =
        presetsResult.status === 'fulfilled' ? presetsResult.value.active : null;

    // Build model list filtered to the active preset (Custom = show all)
    const availableModels: readonly string[] = (() => {
        if (activePreset === null) return KNOWN_MODELS;
        const preset = PRESETS.find((p) => p.id === activePreset);
        if (preset === undefined) return KNOWN_MODELS;
        return presetModelIds(preset);
    })();

    const name = detail?.name ?? capitalize(key);
    const status = detail?.status ?? 'idle';
    const configEntry = agentConfigs.find((c) => c.name.toLowerCase() === key);
    const modelEntry = modelConfigs.find((m) => m.name.toLowerCase() === key);
    const isEnabled = configEntry?.enabled ?? true;
    const currentModel = modelEntry?.model ?? detail?.model ?? '';
    const currentProvider = modelEntry?.provider ?? detail?.provider ?? '';

    // Speciality scores for this agent
    const agentScores = matrixRows.filter((m) => m.agent.toLowerCase() === key);

    // Cost for this agent
    const agentCost = costs?.byAgent.find((c) => c.agent.toLowerCase() === key);

    // Stats
    const stats = detail?.stats ?? { totalCompleted: 0, totalFailed: 0, avgQualityScore: null };
    const successRate = (stats.totalCompleted + stats.totalFailed) > 0
        ? Math.round((stats.totalCompleted / (stats.totalCompleted + stats.totalFailed)) * 100)
        : null;

    // Reset intercept state when switching agents
    resetInterceptState();

    // ── Build HTML sections ──
    const heroHtml = renderHero(key, name, status, profile);
    const scorecardHtml = renderScorecard(agentScores);
    const configHtml = renderConfig(key, currentModel, currentProvider, isEnabled);
    const presetHtml = renderPresetPicker();
    const perfHtml = renderPerformance(stats, successRate, agentCost);
    const missionsHtml = renderMissions(detail);
    const activeTask = detail?.currentTask !== null && detail?.currentTask !== undefined
        ? { id: detail.currentTask.id, title: detail.currentTask.title }
        : null;
    const interceptHtml = renderIntercept(activeTask);
    const chatHtml = renderChat();

    mainScroll.innerHTML = `
        <div class="au-dossier" data-agent="${esc(key)}">
            ${heroHtml}
            ${scorecardHtml}
            ${configHtml}
            ${presetHtml}
            ${perfHtml}
            ${missionsHtml}
            ${interceptHtml}
            ${chatHtml}
        </div>`;

    // Wire interactive elements
    wireConfig(root, api, key, availableModels);
    wireIntercept(root, api, key, activeTask);
    wireChat(root, api, key);

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mainScroll.innerHTML = `<div class="empty-state">Failed to load dossier: ${esc(msg)}</div>`;
    }
}

// ── Team Overview ─────────────────────────────────────

async function loadTeamOverview(root: HTMLElement, api: AutonautsApi): Promise<void> {
    const mainScroll = root.querySelector('#au-main-scroll') as HTMLElement;
    if (mainScroll === null) return;
    mainScroll.innerHTML = '<div class="empty-state">Loading team data…</div>';

    const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
        Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    const [configsResult, modelsResult, matrixResult, costsResult, detailsResult] = await Promise.allSettled([
        timeout(api.getAgentConfigs(), 10_000),
        timeout(api.getAgentModelConfigs(), 10_000),
        timeout(api.getMatrix(), 10_000),
        timeout(api.getOperationalCosts(30), 10_000),
        timeout(
            Promise.allSettled(AGENT_ORDER.map((name) => api.getAgentDetail(name))),
            10_000,
        ),
    ]);

    const configs = configsResult.status === 'fulfilled' ? [...configsResult.value] : [];
    const models  = modelsResult.status === 'fulfilled' ? [...modelsResult.value] : [];
    const matrix  = matrixResult.status === 'fulfilled' ? [...matrixResult.value] : [];
    const costs   = costsResult.status === 'fulfilled' ? costsResult.value : null;
    const settledDetails = detailsResult.status === 'fulfilled' ? detailsResult.value : [];

    const modelMap = new Map(models.map((m) => [m.name.toLowerCase(), m]));
    const costMap  = new Map((costs?.byAgent ?? []).map((c) => [c.agent.toLowerCase(), c]));
    const detailMap = new Map(
        settledDetails
            .filter((r): r is PromiseFulfilledResult<AgentDetailInfo | null> => r.status === 'fulfilled' && r.value !== null)
            .map((r) => [(r as PromiseFulfilledResult<AgentDetailInfo>).value.name.toLowerCase(), (r as PromiseFulfilledResult<AgentDetailInfo>).value])
    );

    const rosterHtml  = renderTeamRoster(configs, modelMap, costMap, detailMap);
    const analyticsHtml = renderTeamAnalytics(configs, costMap, detailMap);
    const matrixHtml  = renderTeamMatrix(matrix);

    mainScroll.innerHTML = `
        <div class="au-team-overview">
            <section class="au-section">
                <h3 class="au-section-title">Agent Roster</h3>
                <div class="au-roster-grid">${rosterHtml}</div>
            </section>
            <section class="au-section">
                <details class="au-scorecard-details" open>
                    <summary class="au-scorecard-summary">Performance Analytics</summary>
                    ${analyticsHtml}
                </details>
            </section>
            <section class="au-section">
                <details class="au-scorecard-details">
                    <summary class="au-scorecard-summary">Speciality Matrix <span class="au-live-badge">live</span></summary>
                    ${matrixHtml}
                </details>
            </section>
        </div>`;
}

function renderTeamRoster(
    configs: readonly AgentConfigEntry[],
    modelMap: ReadonlyMap<string, AgentModelEntry>,
    costMap: ReadonlyMap<string, AgentCostEntry>,
    detailMap: ReadonlyMap<string, AgentDetailInfo>,
): string {
    const sorted = [...configs].sort((a, b) => {
        const ai = AGENT_ORDER.indexOf(a.name.toLowerCase());
        const bi = AGENT_ORDER.indexOf(b.name.toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    if (sorted.length === 0) return '<div class="au-empty">No agents registered</div>';

    return sorted.map((cfg) => {
        const key = cfg.name.toLowerCase();
        const profile = AGENT_PROFILES[key];
        const model = modelMap.get(key);
        const cost = costMap.get(key);
        const detail = detailMap.get(key);
        const color = profile?.color ?? 'oklch(0.66 0.12 150)';

        const completed = detail?.stats.totalCompleted ?? 0;
        const failed = detail?.stats.totalFailed ?? 0;
        const total = completed + failed;
        const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
        const quality = detail?.stats.avgQualityScore ?? null;
        const totalCost = cost?.totalCostUsd ?? 0;

        return `
        <div class="au-roster-card" data-agent="${esc(key)}" style="--agent-color:${color}">
            <div class="au-roster-card-header">
                <span class="au-roster-portrait sigil-host">${getSigilHtml(key, { label: cfg.name })}</span>
                <span class="au-roster-status au-status--${cfg.status}" title="${esc(cfg.status)}"></span>
                <div class="au-roster-identity">
                    <span class="au-roster-name">${esc(cfg.name)}</span>
                    ${profile !== undefined ? `<span class="au-roster-title">${esc(profile.title)}</span>` : ''}
                </div>
            </div>
            ${profile !== undefined ? `<p class="au-roster-desc">${esc(profile.description)}</p>` : ''}
            <div class="au-roster-model" title="${esc(model?.model ?? cfg.model)}">
                ${esc(truncate(model?.model ?? cfg.model, 32))} · ${esc(model?.provider ?? 'default')}
            </div>
            <div class="au-roster-stats">
                <span>${completed} done</span>
                <span>${successRate}%</span>
                <span>${quality !== null ? quality.toFixed(1) : '—'} quality</span>
                <span>$${totalCost.toFixed(3)}</span>
            </div>
            ${total > 0 ? `<div class="au-roster-bar-wrap"><div class="au-roster-bar-fill" style="width:${successRate}%"></div></div>` : ''}
        </div>`;
    }).join('');
}

function renderTeamAnalytics(
    configs: readonly AgentConfigEntry[],
    costMap: ReadonlyMap<string, AgentCostEntry>,
    detailMap: ReadonlyMap<string, AgentDetailInfo>,
): string {
    const totalCalls = [...costMap.values()].reduce((s, c) => s + c.callCount, 0);
    const totalSpend = [...costMap.values()].reduce((s, c) => s + c.totalCostUsd, 0);
    const totalCompleted = [...detailMap.values()].reduce((s, d) => s + d.stats.totalCompleted, 0);
    const totalFailed = [...detailMap.values()].reduce((s, d) => s + d.stats.totalFailed, 0);

    const rows = AGENT_ORDER
        .filter((name) => configs.some((c) => c.name.toLowerCase() === name))
        .map((name) => {
            const detail = detailMap.get(name);
            const cost = costMap.get(name);
            const completed = detail?.stats.totalCompleted ?? 0;
            const failed = detail?.stats.totalFailed ?? 0;
            const total = completed + failed;
            const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
            const quality = detail?.stats.avgQualityScore ?? null;
            const totalCost = cost?.totalCostUsd ?? 0;
            const calls = cost?.callCount ?? 0;
            const tokIn = cost?.tokensIn ?? 0;
            const tokOut = cost?.tokensOut ?? 0;
            const costPerTask = total > 0 ? totalCost / total : 0;
            return `<tr>
                <td class="au-tbl-agent">${esc(name)}</td>
                <td class="au-tbl-num">${completed}</td>
                <td class="au-tbl-num">${failed}</td>
                <td class="au-tbl-num">${successRate}%</td>
                <td class="au-tbl-num">${quality !== null ? quality.toFixed(1) : '—'}</td>
                <td class="au-tbl-num">${calls}</td>
                <td class="au-tbl-num">${formatTokens(tokIn)}</td>
                <td class="au-tbl-num">${formatTokens(tokOut)}</td>
                <td class="au-tbl-num">$${totalCost.toFixed(3)}</td>
                <td class="au-tbl-num">$${costPerTask.toFixed(4)}</td>
            </tr>`;
        }).join('');

    return `
        <div class="au-analytics-summary">
            <div class="au-summary-stat"><span class="au-summary-val">${totalCompleted}</span><span class="au-summary-lbl">Tasks Done</span></div>
            <div class="au-summary-stat"><span class="au-summary-val">${totalFailed}</span><span class="au-summary-lbl">Failed</span></div>
            <div class="au-summary-stat"><span class="au-summary-val">${totalCalls}</span><span class="au-summary-lbl">API Calls</span></div>
            <div class="au-summary-stat"><span class="au-summary-val">$${totalSpend.toFixed(2)}</span><span class="au-summary-lbl">Spend (30d)</span></div>
        </div>
        <div class="au-analytics-table-wrap">
            <table class="au-analytics-table">
                <thead><tr>
                    <th>Agent</th><th>Done</th><th>Failed</th><th>Rate</th>
                    <th>Quality</th><th>Calls</th><th>Tok In</th><th>Tok Out</th>
                    <th>Cost</th><th>$/Task</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function renderTeamMatrix(entries: readonly MatrixEntry[]): string {
    if (entries.length === 0) {
        return '<div class="au-empty">No speciality data yet. Run projects to populate the matrix.</div>';
    }

    // Sorted agents (columns)
    const agents = [...new Set(entries.map((e) => e.agent))].sort((a, b) => {
        const ai = AGENT_ORDER.indexOf(a);
        const bi = AGENT_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const scoreMap = new Map(entries.map((e) => [`${e.agent}:${e.skill}`, Number(e.score)]));

    // Skills as rows — only those with at least one non-zero score, sorted by max score desc
    const allSkills = [...new Set(entries.map((e) => e.skill))];
    const skills = allSkills
        .map((skill) => ({
            skill,
            max: Math.max(...agents.map((a) => scoreMap.get(`${a}:${skill}`) ?? 0)),
        }))
        .filter((s) => s.max > 0)
        .sort((a, b) => b.max - a.max || a.skill.localeCompare(b.skill))
        .map((s) => s.skill);

    if (skills.length === 0) {
        return '<div class="au-empty">No non-zero scores yet. Run projects to populate.</div>';
    }

    // Agent column headers
    const headerCells = agents.map((a) =>
        `<th class="au-hm-agent-col">${esc(capitalize(a))}</th>`
    ).join('');

    // One row per skill
    const rows = skills.map((skill) => {
        const label = SKILL_LABELS[skill] ?? skill;
        const maxScore = Math.max(...agents.map((a) => scoreMap.get(`${a}:${skill}`) ?? 0));

        const cells = agents.map((agent) => {
            const score = scoreMap.get(`${agent}:${skill}`) ?? 0;
            if (score === 0) return `<td class="au-hm-cell au-hm-cell--zero">—</td>`;
            const intensity = score / 9;
            const alpha = (0.12 + intensity * 0.52).toFixed(2);
            const display = Number.isInteger(score) ? String(score) : score.toFixed(1);
            return `<td class="au-hm-cell" style="background:rgba(99,179,237,${alpha})">${display}</td>`;
        }).join('');

        const rowClass = maxScore >= 7 ? ' au-hm-row--hot' : '';
        return `<tr class="au-hm-row${rowClass}"><td class="au-hm-skill-label">${esc(label)}</td>${cells}</tr>`;
    }).join('');

    return `
        <div class="au-matrix-wrap">
            <table class="au-matrix-table">
                <thead>
                    <tr>
                        <th class="au-hm-corner"></th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="au-matrix-legend">
            <span>Score intensity:</span>
            <span class="au-legend-low">low</span>
            <div class="au-legend-bar"></div>
            <span class="au-legend-high">high</span>
            <span class="au-legend-note">· Zero scores hidden · Sorted by peak score</span>
        </div>`;
}

// ── Section: Hero ────────────────────────────────────

function renderHero(
    key: string,
    name: string,
    status: string,
    profile: AgentProfile | undefined,
): string {
    const title = profile?.title ?? '';
    const description = profile?.description ?? '';
    const specialities = profile?.specialities ?? [];

    return `
        <section class="au-hero">
            <div class="au-hero-portrait-wrap">
                <span class="au-hero-portrait sigil-host">${getSigilHtml(key, { label: name })}</span>
                <span class="au-hero-status au-status--${status}"></span>
            </div>
            <div class="au-hero-identity">
                <h2 class="au-hero-name">${esc(name)}</h2>
                ${title !== '' ? `<span class="au-hero-title">${esc(title)}</span>` : ''}
                ${description !== '' ? `<p class="au-hero-desc">${esc(description)}</p>` : ''}
                ${specialities.length > 0 ? `
                    <div class="au-hero-tags">
                        ${specialities.map((s) => `<span class="au-hero-tag">${esc(s)}</span>`).join('')}
                    </div>` : ''}
            </div>
        </section>`;
}

// ── Section: Speciality Scorecard ────────────────────

function renderScorecard(scores: readonly MatrixEntry[]): string {
    if (scores.length === 0) {
        return `
            <section class="au-section">
                <h3 class="au-section-title">Speciality Scorecard</h3>
                <div class="au-empty">No speciality data yet. Run projects to populate.</div>
            </section>`;
    }

    // Sort descending by score (pg returns NUMERIC as strings)
    const sorted = [...scores].sort((a, b) => Number(b.score) - Number(a.score));
    const maxScore = 10;

    const bars = sorted.map((entry) => {
        const score = Number(entry.score);
        const pct = Math.round((score / maxScore) * 100);
        return `
            <div class="au-score-row">
                <span class="au-score-label">${esc(capitalize(entry.skill))}</span>
                <div class="au-score-bar-track">
                    <div class="au-score-bar-fill" style="width:${pct}%"></div>
                </div>
                <span class="au-score-value">${score.toFixed(1)}</span>
            </div>`;
    }).join('');

    return `
        <section class="au-section">
            <details class="au-scorecard-details">
                <summary class="au-scorecard-summary">Speciality Scorecard</summary>
                <div class="au-scorecard">${bars}</div>
            </details>
        </section>`;
}

// ── Section: Preset Picker ────────────────────────────

function renderPresetPicker(): string {
    const presetCards = PRESETS.map((p) => {
        const modelList = presetModelIds(p)
            .map((id) => `<span class="au-preset-model-tag">${esc(modelLabel(id))}</span>`)
            .join('');
        return `
            <div class="au-preset-card" data-preset="${escAttr(p.id)}">
                <div class="au-preset-card-header">
                    <span class="au-preset-name">${esc(p.label)}</span>
                    <span class="au-preset-cost">${esc(costTierLabel(p.costTier))}</span>
                </div>
                <p class="au-preset-desc">${esc(p.description)}</p>
                <p class="au-preset-tradeoff">${esc(p.tradeoff)}</p>
                <div class="au-preset-models">${modelList}</div>
                <button class="au-btn au-btn--secondary au-preset-apply" data-preset="${escAttr(p.id)}">Apply preset</button>
            </div>`;
    }).join('');

    return `
        <section class="au-section">
            <details class="au-scorecard-details">
                <summary class="au-scorecard-summary">Presets</summary>
                <div class="au-preset-grid">${presetCards}</div>
            </details>
        </section>`;
}

// ── Section: Configuration ───────────────────────────

function renderConfig(
    key: string,
    currentModel: string,
    currentProvider: string,
    isEnabled: boolean,
): string {

    // Resolve "what does this alias actually map to?" so the user can
    // see whether they're on Opus 4.6 / 4.7 / etc rather than a hidden
    // alias-resolved-by-CLI shrug. Only meaningful for claude-cli aliases.
    const aliasResolution = describeModelAlias(currentModel);

    return `
        <section class="au-section">
            <h3 class="au-section-title">Configuration</h3>
            <div class="au-config-wrap">
            <div class="au-config-form" data-agent="${esc(key)}">
                <div class="au-config-row">
                    <label class="au-config-label">
                        Model
                        <span class="au-tooltip" aria-label="The AI model this agent will use. For claude-cli, use aliases like claude-cli/sonnet. For API providers, use the full model path e.g. openrouter/google/gemini-2.5-flash.">
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6.5" r="5.5"/><line x1="6.5" y1="4.5" x2="6.5" y2="4.5" stroke-width="2"/><line x1="6.5" y1="6.5" x2="6.5" y2="9"/></svg>
                            <span class="au-tooltip-text">The AI model this agent will use. For Claude CLI, use short aliases like <code>claude-cli/sonnet</code>. For API providers, use the full path e.g. <code>openrouter/google/gemini-2.5-flash</code>.</span>
                        </span>
                    </label>
                    <div class="au-combobox">
                        <input class="au-config-select au-config-input" id="au-cfg-model"
                               type="text"
                               value="${escAttr(currentModel)}"
                               placeholder="provider/model-id"
                               autocomplete="off" spellcheck="false" />
                        <ul class="au-combobox-list" id="au-cfg-model-list" hidden></ul>
                    </div>
                </div>
                ${aliasResolution !== '' ? `<div class="au-config-hint">${esc(aliasResolution)}</div>` : ''}
                <div class="au-config-row">
                    <label class="au-config-label">
                        Provider
                        <span class="au-tooltip" aria-label="The AI service routing this agent's requests. Must match the prefix in the model field.">
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6.5" r="5.5"/><line x1="6.5" y1="4.5" x2="6.5" y2="4.5" stroke-width="2"/><line x1="6.5" y1="6.5" x2="6.5" y2="9"/></svg>
                            <span class="au-tooltip-text">The AI service routing this agent's requests. Must match the prefix used in the model field — e.g. <code>claude-cli</code> for <code>claude-cli/sonnet</code>, or <code>openrouter</code> for <code>openrouter/…</code> models.</span>
                        </span>
                    </label>
                    <div class="au-combobox">
                        <input class="au-config-select au-config-input" id="au-cfg-provider"
                               type="text"
                               value="${escAttr(currentProvider)}"
                               placeholder="provider"
                               autocomplete="off" spellcheck="false" />
                        <ul class="au-combobox-list" id="au-cfg-provider-list" hidden></ul>
                    </div>
                </div>
                <div class="au-config-actions">
                    <button class="au-btn au-btn--primary" id="au-cfg-save">Save</button>
                    <button class="au-btn au-btn--secondary" id="au-cfg-test">Test</button>
                </div>
                <div class="au-config-feedback" id="au-cfg-feedback"></div>
                <div class="au-config-toggle-row">
                    <span class="au-config-label">Agent Enabled</span>
                    <label class="au-toggle">
                        <input type="checkbox" id="au-cfg-enabled" ${isEnabled ? 'checked' : ''}>
                        <span class="au-toggle-slider"></span>
                    </label>
                </div>
            </div>
            <aside class="au-config-preset-note">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="flex-shrink:0;margin-top:2px"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5.5v.5"/></svg>
                <div>
                    When a preset is active in <strong>Model Routing</strong>, the preset model overrides these settings.
                    Switch to <strong>Custom</strong> preset to make per-agent overrides stick.
                </div>
            </aside>
            </div>
        </section>`;
}

/**
 * For claude-cli aliases, surface the model the CLI is most likely
 * resolving to. This is informational only — the actual resolution is
 * done inside the Claude Code CLI binary at request time.
 */
function describeModelAlias(model: string): string {
    const ALIAS_MAP: Record<string, string> = {
        'claude-cli/opus':   'opus → currently resolves to claude-opus-4-7 (latest Opus)',
        'claude-cli/sonnet': 'sonnet → currently resolves to claude-sonnet-4-6 (latest Sonnet)',
        'claude-cli/haiku':  'haiku → currently resolves to claude-haiku-4-5-20251001 (latest Haiku)',
    };
    return ALIAS_MAP[model] ?? '';
}

// ── Section: Performance ─────────────────────────────

function renderPerformance(
    stats: AgentStats,
    successRate: number | null,
    agentCost: AgentCostEntry | undefined,
): string {
    return `
        <section class="au-section">
            <h3 class="au-section-title">Performance</h3>
            <div class="au-perf-grid">
                <div class="au-perf-stat">
                    <span class="au-perf-value">${stats.totalCompleted}</span>
                    <span class="au-perf-label">Completed</span>
                </div>
                <div class="au-perf-stat">
                    <span class="au-perf-value">${stats.totalFailed}</span>
                    <span class="au-perf-label">Failed</span>
                </div>
                <div class="au-perf-stat">
                    <span class="au-perf-value">${successRate !== null ? successRate + '%' : '\u2014'}</span>
                    <span class="au-perf-label">Success Rate</span>
                </div>
                <div class="au-perf-stat">
                    <span class="au-perf-value">${stats.avgQualityScore !== null ? stats.avgQualityScore.toFixed(1) : '\u2014'}</span>
                    <span class="au-perf-label">Avg Quality</span>
                </div>
                <div class="au-perf-stat">
                    <span class="au-perf-value">${agentCost !== undefined ? '$' + agentCost.totalCostUsd.toFixed(2) : '\u2014'}</span>
                    <span class="au-perf-label">Total Cost</span>
                </div>
                <div class="au-perf-stat">
                    <span class="au-perf-value">${agentCost !== undefined ? agentCost.callCount.toString() : '\u2014'}</span>
                    <span class="au-perf-label">AI Calls</span>
                </div>
            </div>
        </section>`;
}

// ── Section: Recent Missions ─────────────────────────

function renderMissions(detail: AgentDetailInfo | null): string {
    const tasks = detail?.recentTasks ?? [];
    const current = detail?.currentTask ?? null;

    if (tasks.length === 0 && current === null) {
        return `
            <section class="au-section">
                <h3 class="au-section-title">Recent Missions</h3>
                <div class="au-empty">No missions recorded yet.</div>
            </section>`;
    }

    let html = '';

    if (current !== null) {
        html += `
            <div class="au-mission au-mission--active">
                <div class="au-mission-header">
                    <span class="au-mission-title">${esc(current.title)}</span>
                    <span class="au-mission-badge au-mission-badge--active">in progress</span>
                </div>
                <div class="au-mission-meta">
                    ${esc(current.taskType)} \u00b7 ${esc(current.phase)}
                    ${current.startedAt !== null ? ` \u00b7 Started ${formatTime(current.startedAt)}` : ''}
                </div>
            </div>`;
    }

    const recent = tasks.slice(0, 8);
    for (const t of recent) {
        const statusCls = t.status === 'completed' ? 'au-mission-badge--done'
            : t.status === 'failed' ? 'au-mission-badge--fail' : '';
        html += `
            <div class="au-mission">
                <div class="au-mission-header">
                    <span class="au-mission-title">${esc(t.title)}</span>
                    <span class="au-mission-badge ${statusCls}">${esc(t.status)}</span>
                </div>
                <div class="au-mission-meta">
                    ${esc(t.taskType)} \u00b7 ${esc(t.phase)}
                    ${t.qualityScore !== null ? ` \u00b7 Quality: ${t.qualityScore.toFixed(1)}` : ''}
                    ${t.completedAt !== null ? ` \u00b7 ${formatTime(t.completedAt)}` : ''}
                </div>
            </div>`;
    }

    return `
        <section class="au-section">
            <h3 class="au-section-title">Recent Missions</h3>
            <div class="au-missions-list">${html}</div>
        </section>`;
}

// ── Section: Chat ────────────────────────────────────

function renderChat(): string {
    const messagesHtml = chatMessages.map(renderChatBubble).join('');

    return `
        <section class="au-section au-section--chat">
            <h3 class="au-section-title">Chat</h3>
            <div class="au-chat-messages" id="au-chat-messages">${messagesHtml}</div>
            <div class="au-chat-input-row">
                <input type="text" class="au-chat-input" id="au-chat-input"
                       placeholder="Message this agent via Sensei\u2026" autocomplete="off">
                <button class="au-btn au-btn--primary au-chat-send" id="au-chat-send">\u2191</button>
            </div>
        </section>`;
}

/**
 * Render a single chat bubble — assistant messages run through `marked`
 * so `**bold**` and lists turn into real HTML; user messages are
 * escaped. Both surfaces include a timestamp meta line.
 */
function renderChatBubble(m: ChatEntry): string {
    const time = formatRelativeTime(m.timestamp);
    const labelText = m.role === 'user' ? 'You' : 'Sensei';
    const body = m.role === 'assistant'
        ? marked.parse(m.text ?? '', { async: false, gfm: true, breaks: true }) as string
        : esc(m.text ?? '');
    return `
        <div class="au-chat-msg au-chat-msg--${m.role}">
            <div class="au-chat-msg-meta">
                <span class="au-chat-msg-label">${esc(labelText)}</span>
                <span class="au-chat-msg-time" title="${esc(formatAbsoluteTime(m.timestamp))}">${esc(time)}</span>
            </div>
            <div class="au-chat-msg-body">${body}</div>
        </div>`;
}

function formatRelativeTime(iso: string): string {
    try {
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return '';
        const diffMs = Date.now() - then;
        if (diffMs < 60_000) return 'just now';
        if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
        if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
        return `${Math.floor(diffMs / 86_400_000)}d ago`;
    } catch { return ''; }
}

function formatAbsoluteTime(iso: string): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString();
    } catch { return iso; }
}

// ── Combobox helper ───────────────────────────────────

function inferProviderFromModel(model: string): string | null {
    const slash = model.indexOf('/');
    if (slash > 0) {
        const prefix = model.slice(0, slash);
        if (KNOWN_PROVIDERS.includes(prefix)) return prefix;
    }
    return MODELS.find((m) => m.id === model)?.provider ?? null;
}

function wireCombobox(
    root: HTMLElement,
    inputId: string,
    listId: string,
    options: readonly string[],
    onSelect?: (value: string) => void,
): void {
    const input = root.querySelector<HTMLInputElement>(`#${inputId}`);
    const rawList = root.querySelector<HTMLUListElement>(`#${listId}`);
    if (input === null || rawList === null) return;
    const listEl: HTMLUListElement = rawList;

    options.forEach((opt) => {
        const li = document.createElement('li');
        li.textContent = opt;
        li.dataset['value'] = opt;
        li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = opt;
            listEl.hidden = true;
            onSelect?.(opt);
        });
        listEl.appendChild(li);
    });

    function filterList(query: string): void {
        const q = query.toLowerCase();
        let hasVisible = false;
        listEl.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
            const visible = q === '' || (li.dataset['value'] ?? '').toLowerCase().includes(q);
            li.toggleAttribute('hidden', !visible);
            if (visible) hasVisible = true;
        });
        listEl.hidden = !hasVisible;
    }

    input.addEventListener('focus', () => filterList(input.value));
    input.addEventListener('input', () => filterList(input.value));
    input.addEventListener('blur', () => { setTimeout(() => { listEl.hidden = true; }, 150); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { listEl.hidden = true; input.blur(); return; }
        if (e.key === 'Enter' && !listEl.hidden) {
            const first = listEl.querySelector<HTMLLIElement>('li:not([hidden])');
            if (first !== null) {
                input.value = first.dataset['value'] ?? input.value;
                listEl.hidden = true;
                onSelect?.(input.value);
            }
        }
    });
}

// ── Wiring: Config ─────────────────────────��─────────

function wireConfig(root: HTMLElement, api: AutonautsApi, agentKey: string, availableModels: readonly string[]): void {
    const saveBtn = root.querySelector('#au-cfg-save') as HTMLButtonElement | null;
    const testBtn = root.querySelector('#au-cfg-test') as HTMLButtonElement | null;
    const enabledCb = root.querySelector('#au-cfg-enabled') as HTMLInputElement | null;
    const feedbackEl = root.querySelector('#au-cfg-feedback') as HTMLElement | null;

    // Wire custom model combobox — auto-updates provider on selection
    wireCombobox(root, 'au-cfg-model', 'au-cfg-model-list', availableModels, (selected) => {
        const provider = inferProviderFromModel(selected);
        if (provider !== null) {
            const providerEl = root.querySelector<HTMLInputElement>('#au-cfg-provider');
            if (providerEl !== null) providerEl.value = provider;
        }
    });

    // Wire custom provider combobox
    wireCombobox(root, 'au-cfg-provider', 'au-cfg-provider-list', KNOWN_PROVIDERS);

    if (saveBtn !== null) {
        saveBtn.addEventListener('click', async () => {
            const modelEl = root.querySelector('#au-cfg-model') as HTMLInputElement | HTMLSelectElement | null;
            const providerEl = root.querySelector('#au-cfg-provider') as HTMLSelectElement | null;
            const model = (modelEl?.value ?? '').trim();
            const provider = (providerEl?.value ?? '').trim();
            showFeedback(feedbackEl, 'Saving\u2026', 'info');
            try {
                const res = await api.setAgentModel(agentKey, model, provider);
                if (res.success) {
                    showFeedback(feedbackEl, 'Saved', 'success');
                } else {
                    showFeedback(feedbackEl, res.error ?? 'Save failed', 'error');
                }
            } catch (err: unknown) {
                showFeedback(feedbackEl, err instanceof Error ? err.message : String(err), 'error');
            }
        });
    }

    if (testBtn !== null) {
        testBtn.addEventListener('click', async () => {
            const modelEl = root.querySelector('#au-cfg-model') as HTMLInputElement | null;
            const providerEl = root.querySelector('#au-cfg-provider') as HTMLSelectElement | null;
            const model = (modelEl?.value ?? '').trim();
            const provider = (providerEl?.value ?? '').trim();
            showFeedback(feedbackEl, 'Testing\u2026', 'info');
            try {
                const res = await api.testAgentModel(agentKey, model, provider);
                if (res.success) {
                    const ms = res.latencyMs !== undefined ? ` (${res.latencyMs}ms)` : '';
                    showFeedback(feedbackEl, `Connected${ms}`, 'success');
                } else {
                    showFeedback(feedbackEl, res.error ?? 'Test failed', 'error');
                }
            } catch (err: unknown) {
                showFeedback(feedbackEl, err instanceof Error ? err.message : String(err), 'error');
            }
        });
    }

    if (enabledCb !== null) {
        enabledCb.addEventListener('change', async () => {
            try {
                const res = await api.setAgentEnabled(agentKey, enabledCb.checked);
                if (!res.success) {
                    showFeedback(feedbackEl, res.error ?? 'Toggle failed', 'error');
                    enabledCb.checked = !enabledCb.checked; // revert
                }
            } catch (err: unknown) {
                showFeedback(feedbackEl, err instanceof Error ? err.message : String(err), 'error');
                enabledCb.checked = !enabledCb.checked;
            }
        });
    }

    // Preset apply buttons — apply a preset's model for this agent
    root.querySelectorAll<HTMLButtonElement>('.au-preset-apply').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const presetId = btn.dataset['preset'] ?? '';
            const preset = getPresetById(presetId);
            if (preset === undefined) return;
            const model = preset.agentModels[agentKey as keyof typeof preset.agentModels];
            if (model === undefined) return;
            const providerEntry = MODELS.find((m) => m.id === model);
            const provider = providerEntry?.provider ?? '';
            showFeedback(feedbackEl, `Applying ${preset.label}…`, 'info');
            try {
                const res = await api.setAgentModel(agentKey, model, provider);
                if (res.success) {
                    // Update the model input to reflect the new value
                    const modelEl = root.querySelector<HTMLInputElement>('#au-cfg-model');
                    const providerEl = root.querySelector<HTMLSelectElement>('#au-cfg-provider');
                    if (modelEl !== null) modelEl.value = model;
                    if (providerEl !== null) providerEl.value = provider;
                    showFeedback(feedbackEl, `Applied: ${modelLabel(model)}`, 'success');
                } else {
                    showFeedback(feedbackEl, res.error ?? 'Apply failed', 'error');
                }
            } catch (err: unknown) {
                showFeedback(feedbackEl, err instanceof Error ? err.message : String(err), 'error');
            }
        });
    });
}

// ── Wiring: Chat ─────────────────────────────────────

function wireChat(root: HTMLElement, api: AutonautsApi, agentKey: string): void {
    const input = root.querySelector('#au-chat-input') as HTMLInputElement | null;
    const sendBtn = root.querySelector('#au-chat-send') as HTMLButtonElement | null;
    const messagesEl = root.querySelector('#au-chat-messages') as HTMLElement | null;

    async function send(): Promise<void> {
        if (input === null || messagesEl === null) return;
        const text = input.value.trim();
        if (text === '') return;

        // Slash commands (e.g. `/add-requirement add a contact form`) are
        // global dispatch tokens that Sensei interprets directly — never
        // prepend an `@AgentName:` mention to them, or the slash regex
        // misses and Sensei falls through to the LLM (which then
        // hallucinates dispatch — see #158 / v0.2.0-beta.0).
        const userMsg = text.startsWith('/')
            ? text
            : `@${capitalize(agentKey)}: ${text}`;
        const now = new Date().toISOString();
        const userEntry: ChatEntry = { role: 'user', text, timestamp: now };
        chatMessages = [...chatMessages, userEntry];
        messagesEl.insertAdjacentHTML('beforeend', renderChatBubble(userEntry));
        input.value = '';

        // Typing indicator — kanji-stroke loader + rotating phrase. Lives
        // in the DOM only until the reply arrives; never persisted.
        const typingRow = document.createElement('div');
        typingRow.className = 'au-chat-msg au-chat-msg--typing';
        typingRow.id = 'au-chat-typing';
        const typingHost = document.createElement('span');
        typingHost.className = 'au-chat-typing-host';
        typingRow.appendChild(typingHost);
        messagesEl.appendChild(typingRow);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        const rotator = new ThinkingRotator(typingHost);
        rotator.start();

        try {
            const reply = await api.sendToSensei(userMsg);
            const replyEntry: ChatEntry = { role: 'assistant', text: reply, timestamp: new Date().toISOString() };
            chatMessages = [...chatMessages, replyEntry];
            rotator.stop();
            typingRow.remove();
            messagesEl.insertAdjacentHTML('beforeend', renderChatBubble(replyEntry));
        } catch (err: unknown) {
            rotator.stop();
            typingRow.remove();
            const errText = err instanceof Error ? err.message : String(err);
            const errEntry = `<div class="au-chat-msg au-chat-msg--error">${esc(errText)}</div>`;
            messagesEl.insertAdjacentHTML('beforeend', errEntry);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    if (input !== null) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') void send();
        });
    }
    if (sendBtn !== null) {
        sendBtn.addEventListener('click', () => void send());
    }
}

// ── Utilities ────────────────────────────────────────

function showFeedback(el: HTMLElement | null, msg: string, level: 'info' | 'success' | 'error'): void {
    if (el === null) return;
    el.textContent = msg;
    el.className = `au-config-feedback au-config-feedback--${level}`;
    if (level !== 'info') {
        setTimeout(() => { el.textContent = ''; el.className = 'au-config-feedback'; }, 4000);
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Same helper as in agent-detail-panel — surfaces live values that
 *  fall outside the canonical KNOWN_* lists as a "Custom" option. */

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function formatTime(iso: string): string {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso;
    }
}
