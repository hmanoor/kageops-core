/**
 * KageOps Agent Detail Panel (v2.0)
 *
 * Opened when the user clicks an agent row in the Agents panel or config list.
 * Shows full character portrait, speciality description, config, stats, and tasks.
 */

import { marked } from 'marked';
import { AGENT_PROFILES } from './agent-profiles';
import { getSigilHtml } from './sigils';
import { sanitizeHtml } from '../shared/sanitize-html';

// ── Known Models & Providers ─────────────────────────

const KNOWN_MODELS: readonly string[] = [
    // Claude CLI — aliases (auto-resolve to latest) + pinned versions
    'claude-cli/sonnet',
    'claude-cli/haiku',
    'claude-cli/opus',
    'claude-cli/claude-opus-4-7',
    'claude-cli/claude-opus-4-6',
    'claude-cli/claude-sonnet-4-6',
    'claude-cli/claude-haiku-4-5-20251001',
    'ollama/glm-5.1:cloud',
    'ollama/qwen3-coder-next:cloud',
    'ollama/devstral-small-2:24b-cloud',
    'ollama/gpt-oss:120b-cloud',
    'ollama/glm-5:cloud',
    'ollama/minimax-m2.7:cloud',
    'ollama/deepseek-v3.1:671b-cloud',
    'ollama/qwen3-coder:480b-cloud',
    'ollama/qwen3.5:9b',
    'ollama/gemma3:12b',
    'ollama/llama3.2',
    'openrouter/anthropic/claude-sonnet-4',
    'openrouter/anthropic/claude-haiku-3-5',
    'openrouter/google/gemini-2.5-flash',
    'openrouter/meta-llama/llama-4-maverick',
    'openrouter/deepseek/deepseek-chat-v3',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/o3-mini',
    'google/gemini-2.0-flash',
];

const KNOWN_PROVIDERS: readonly string[] = [
    'claude-cli', 'claude', 'openai', 'ollama', 'google', 'openrouter', 'codex', 'copilot',
];

// ── Types ─────────────────────────────────────────────

interface AgentDetailInfo {
    name: string;
    role: string;
    status: 'idle' | 'busy' | 'error';
    model: string | null;
    provider: string | null;
    currentTask: AgentDetailTask | null;
    recentTasks: AgentDetailTask[];
    stats: AgentStats;
}

interface AgentDetailTask {
    id: string;
    title: string;
    taskType: string;
    phase: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    qualityScore: number | null;
    hasOutput: boolean;
    responseText: string | null;
    outputPath: string | null;
}

interface AgentStats {
    totalCompleted: number;
    totalFailed: number;
    avgQualityScore: number | null;
}

/**
 * P1-01f: one row from the `task_checkpoints` table, shaped for the
 * renderer. Heavy payload/output JSONB bodies are stripped on the
 * main-process side — only the small `meta` projection per op_type
 * survives the IPC.
 */
export interface CheckpointTimelineEntry {
    readonly id: string;
    readonly opIndex: number;
    readonly opType: 'askai' | 'write' | 'exec' | 'other';
    readonly status: 'in-flight' | 'completed' | 'failed';
    readonly createdAt: string;
    readonly completedAt: string | null;
    readonly errorText: string | null;
    readonly meta: Record<string, unknown>;
}

export interface AgentDetailCallbacks {
    getAgentDetail(agentName: string): Promise<AgentDetailInfo | null>;
    getTaskOutput(taskId: string): Promise<{ content: string } | null>;
    /**
     * P1-01f: per-task checkpoint timeline (read-only). Optional so
     * older renderer wires that haven't been migrated don't break;
     * when undefined, the detail panel skips the timeline section.
     */
    getTaskCheckpoints?(taskId: string): Promise<readonly CheckpointTimelineEntry[]>;
    getAgentModelConfig?(agentName: string): Promise<{ model: string; provider: string; fallbackModels: readonly string[] } | null>;
    setAgentModel?(agentName: string, model: string, provider: string): Promise<{ success: boolean; error?: string }>;
    testAgentModel?(agentName: string, model: string, provider: string): Promise<{ success: boolean; latencyMs?: number; error?: string }>;
    setAgentEnabled?(agentName: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
    isAgentEnabled?(agentName: string): Promise<boolean>;
}

// ── Render ────────────────────────────────────────────

export function renderAgentDetailPanel(
    container: HTMLElement,
    agentName: string,
    callbacks: AgentDetailCallbacks
): void {
    container.innerHTML = `
        <div class="agent-detail-panel">
            <div class="agent-detail-header">
                <button class="agent-detail-close" id="agent-detail-close">\u2715</button>
                <div class="agent-detail-title" id="agent-detail-title">Loading\u2026</div>
            </div>
            <div class="agent-detail-body" id="agent-detail-body">
                <div class="empty-state">Loading agent details\u2026</div>
            </div>
            <div class="agent-detail-task-content" id="agent-detail-task-content" style="display:none">
                <div class="task-content-nav">
                    <button class="task-back-btn" id="agent-detail-back">\u2190 Back</button>
                    <span class="task-content-title" id="agent-detail-task-title"></span>
                    <div class="task-view-toggle" id="agent-detail-view-toggle">
                        <button class="task-toggle-btn active" data-view="preview">Preview</button>
                        <button class="task-toggle-btn" data-view="code">Code</button>
                    </div>
                </div>
                <div class="task-content-body task-content-body--preview" id="agent-detail-task-preview"></div>
                <pre class="task-content-body" id="agent-detail-task-body" style="display:none"></pre>
            </div>
        </div>`;

    const titleEl = container.querySelector('#agent-detail-title') as HTMLElement;
    const bodyEl = container.querySelector('#agent-detail-body') as HTMLElement;
    const taskContentEl = container.querySelector('#agent-detail-task-content') as HTMLElement;
    const taskTitleEl = container.querySelector('#agent-detail-task-title') as HTMLElement;
    const taskBodyEl = container.querySelector('#agent-detail-task-body') as HTMLElement;
    const taskPreviewEl = container.querySelector('#agent-detail-task-preview') as HTMLElement;
    const viewToggleEl = container.querySelector('#agent-detail-view-toggle') as HTMLElement;

    const closeBtn = container.querySelector('#agent-detail-close') as HTMLButtonElement;
    const backBtn = container.querySelector('#agent-detail-back') as HTMLButtonElement;

    viewToggleEl.querySelectorAll('.task-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const view = (btn as HTMLElement).dataset['view'] ?? 'preview';
            setView(view);
        });
    });

    function setView(view: string): void {
        viewToggleEl.querySelectorAll('.task-toggle-btn').forEach((b) => {
            b.classList.toggle('active', (b as HTMLElement).dataset['view'] === view);
        });
        if (view === 'code') {
            taskBodyEl.style.display = '';
            taskPreviewEl.style.display = 'none';
        } else {
            taskBodyEl.style.display = 'none';
            taskPreviewEl.style.display = '';
        }
    }

    closeBtn.addEventListener('click', () => {
        const section = document.getElementById('agent-detail-section');
        if (section !== null) section.style.display = 'none';
    });

    backBtn.addEventListener('click', () => {
        taskContentEl.style.display = 'none';
        bodyEl.style.display = '';
    });

    void callbacks.getAgentDetail(agentName).then((detail) => {
        if (detail === null) {
            titleEl.textContent = agentName;
            bodyEl.innerHTML = '<div class="empty-state">Agent details unavailable.</div>';
            return;
        }

        const key = detail.name.toLowerCase();
        const profile = AGENT_PROFILES[key];
        const accentColor = profile?.color ?? 'oklch(0.66 0.12 150)';

        // Header — text only (hero portrait below is the single portrait)
        titleEl.innerHTML = `
            <span class="status-dot ${detail.status}"></span>
            <strong>${escHtml(detail.name)}</strong>
            <span class="agent-detail-role">${escHtml(detail.role)}</span>`;

        // ── Profile hero section ──
        const heroHtml = `
            <div class="agent-profile-hero">
                <div class="agent-profile-portrait-wrap" style="--agent-color: ${accentColor}">
                    <span class="agent-profile-portrait sigil-host" style="border-color: ${accentColor}">${getSigilHtml(key, { label: detail.name })}</span>
                    <div class="agent-profile-status-ring ${detail.status}" style="border-color: ${accentColor}"></div>
                </div>
                <div class="agent-profile-identity">
                    <h3 class="agent-profile-name" style="color: ${accentColor}">${escHtml(detail.name)}</h3>
                    ${profile ? `<span class="agent-profile-title">${escHtml(profile.title)}</span>` : ''}
                    <span class="agent-profile-role">${escHtml(detail.role)}</span>
                </div>
            </div>`;

        // ── Description ──
        const descHtml = profile ? `
            <div class="agent-profile-section">
                <div class="agent-profile-section-title">About</div>
                <p class="agent-profile-desc">${escHtml(profile.description)}</p>
            </div>` : '';

        // ── Specialities ──
        const specHtml = profile ? `
            <div class="agent-profile-section">
                <div class="agent-profile-section-title">Specialities</div>
                <div class="agent-profile-tags">
                    ${profile.specialities.map((s) =>
                        `<span class="agent-profile-tag" style="border-color: ${accentColor}40; color: ${accentColor}">${escHtml(s)}</span>`
                    ).join('')}
                </div>
            </div>` : '';

        // ── Model Configuration (interactive) ──
        // Bug we fix here: KNOWN_MODELS / KNOWN_PROVIDERS are static lists.
        // If the live config uses a value not in the list (e.g. claude-cli/*
        // when the dropdown only knew ollama/*), no <option> is marked
        // selected and the browser silently shows the FIRST option as
        // selected — making it look like the agent is on `ollama/glm-5.1`
        // with provider `claude` when it really isn't. We synthesise an
        // option for the live value if it is missing.
        const modelOptions = buildSelectOptions(KNOWN_MODELS, detail.model ?? '');
        const providerOptions = buildSelectOptions(KNOWN_PROVIDERS, detail.provider ?? '');

        const configHtml = `
            <div class="agent-profile-section">
                <div class="agent-profile-section-title">Model Configuration</div>
                <div class="agent-detail-config-form">
                    <div class="agent-config-field">
                        <label class="agent-config-label">Model</label>
                        <select class="agent-config-select" id="agent-detail-model">${modelOptions}</select>
                    </div>
                    <div class="agent-config-field">
                        <label class="agent-config-label">Provider</label>
                        <select class="agent-config-select" id="agent-detail-provider">${providerOptions}</select>
                    </div>
                    <div class="agent-config-actions">
                        <button class="btn-sm btn-primary" id="agent-detail-save">Save</button>
                        <button class="btn-sm btn-secondary" id="agent-detail-test">Test</button>
                    </div>
                    <div class="agent-config-feedback" id="agent-detail-feedback"></div>
                    <div class="agent-config-field agent-config-toggle-row">
                        <span class="agent-config-label">Agent Enabled</span>
                        <label class="agent-toggle">
                            <input type="checkbox" id="agent-detail-enabled" ${detail.status !== 'error' ? 'checked' : ''}>
                            <span class="agent-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="agent-config-item">
                        <span class="agent-config-label">Status</span>
                        <span class="agent-config-value agent-config-status--${detail.status}">${escHtml(detail.status)}</span>
                    </div>
                </div>
            </div>`;

        // ── Stats ──
        const statsHtml = `
            <div class="agent-profile-section">
                <div class="agent-profile-section-title">Performance</div>
                <div class="agent-stats-row">
                    <span class="stat-item">
                        <span class="stat-value">${detail.stats.totalCompleted}</span>
                        <span class="stat-label">Completed</span>
                    </span>
                    <span class="stat-item">
                        <span class="stat-value">${detail.stats.totalFailed}</span>
                        <span class="stat-label">Failed</span>
                    </span>
                    <span class="stat-item">
                        <span class="stat-value">${detail.stats.avgQualityScore !== null ? detail.stats.avgQualityScore.toFixed(1) : '\u2014'}</span>
                        <span class="stat-label">Avg Quality</span>
                    </span>
                </div>
            </div>`;

        // ── Current Task ──
        const currentHtml = detail.currentTask !== null
            ? `<div class="agent-profile-section">
                   <div class="agent-profile-section-title">Current Task</div>
                   <div class="agent-current-task">
                       <div class="task-row task-row--active">
                           <div class="task-row-left">
                               <span class="task-row-title">${escHtml(detail.currentTask.title)}</span>
                           </div>
                           <div class="task-row-right">
                               <span class="task-type-label">${escHtml(detail.currentTask.taskType)}</span>
                               <span class="task-badge task-badge--assigned">in progress</span>
                           </div>
                       </div>
                       <div class="task-meta">
                           Phase: ${escHtml(detail.currentTask.phase)}
                           ${detail.currentTask.startedAt ? ` \u00b7 Started: ${formatTime(detail.currentTask.startedAt)}` : ''}
                       </div>
                   </div>
               </div>`
            : '';

        // ── Recent Tasks ──
        const recentHtml = detail.recentTasks.length > 0
            ? `<div class="agent-profile-section">
                   <div class="agent-profile-section-title">Recent Tasks</div>
                   <div class="agent-recent-tasks">
                       ${detail.recentTasks.map((t) => `
                           <div class="task-row ${t.hasOutput ? 'task-row--clickable' : ''}"
                                data-task-id="${escAttr(t.id)}"
                                data-has-output="${t.hasOutput ? '1' : '0'}">
                               <div class="task-row-left">
                                   <span class="task-row-title">${escHtml(t.title)}</span>
                               </div>
                               <div class="task-row-right">
                                   <span class="task-type-label">${escHtml(t.taskType)}</span>
                                   ${statusBadge(t.status)}
                                   ${t.qualityScore !== null ? `<span class="quality-score">${t.qualityScore.toFixed(1)}</span>` : ''}
                               </div>
                           </div>`).join('')}
                   </div>
               </div>`
            : '';

        bodyEl.innerHTML = heroHtml + descHtml + specHtml + configHtml + statsHtml + currentHtml + recentHtml;

        // Wire clicks on recent tasks that have output
        bodyEl.querySelectorAll('.task-row--clickable').forEach((row) => {
            (row as HTMLElement).addEventListener('click', () => {
                const taskId = (row as HTMLElement).dataset['taskId'] ?? '';
                void loadTaskContent(taskId);
            });
        });

        // Wire model config controls
        wireModelConfig(bodyEl, detail.name, callbacks);

        // Load actual enabled state
        if (callbacks.isAgentEnabled !== undefined) {
            void callbacks.isAgentEnabled(detail.name).then((enabled) => {
                const toggle = bodyEl.querySelector<HTMLInputElement>('#agent-detail-enabled');
                if (toggle !== null) toggle.checked = enabled;
            });
        }

        // Load actual model config (may differ from detail.model)
        if (callbacks.getAgentModelConfig !== undefined) {
            void callbacks.getAgentModelConfig(detail.name).then((cfg) => {
                if (cfg === null) return;
                const modelSel = bodyEl.querySelector<HTMLSelectElement>('#agent-detail-model');
                const provSel = bodyEl.querySelector<HTMLSelectElement>('#agent-detail-provider');
                if (modelSel !== null) modelSel.value = cfg.model;
                if (provSel !== null) provSel.value = cfg.provider;
            });
        }
    });

    async function loadTaskContent(taskId: string): Promise<void> {
        taskBodyEl.textContent = 'Loading\u2026';
        taskPreviewEl.textContent = 'Loading\u2026';
        taskTitleEl.textContent = '';
        bodyEl.style.display = 'none';
        taskContentEl.style.display = '';
        setView('preview');

        const output = await callbacks.getTaskOutput(taskId);
        const outputContent = output === null ? 'Output not available.' : output.content;

        // P1-01f: load + render the per-task checkpoint timeline in
        // parallel with the output fetch. Best-effort \u2014 when the
        // callback is missing OR returns an empty array, the panel
        // just doesn't render the section (no "checkpoints enabled?"
        // hint \u2014 that's operator infrastructure config, not a UI
        // surface for in-task work).
        let timelineHtml = '';
        if (callbacks.getTaskCheckpoints !== undefined) {
            try {
                const checkpoints = await callbacks.getTaskCheckpoints(taskId);
                if (checkpoints.length > 0) {
                    timelineHtml = renderCheckpointTimeline(checkpoints);
                }
            } catch {
                /* non-fatal \u2014 fall back to no timeline */
            }
        }

        taskBodyEl.textContent = outputContent;
        // KO-SEC-005/030: task output is AI-generated — sanitize before innerHTML.
        const renderedOutput = sanitizeHtml(marked.parse(outputContent, { async: false, gfm: true, breaks: true }) as string);
        taskPreviewEl.innerHTML = timelineHtml + renderedOutput;
    }
}

// \u2500\u2500 P1-01f: checkpoint timeline rendering \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Render the per-task checkpoint timeline as a single inline section.
 * Compact by design \u2014 operators want a glance ("18 ops, all cached on
 * resume") not a debugger surface. Each row shows op_index, op_type
 * badge, status pip, timestamp, and the per-op-type meta summary
 * (model+tokens+$ for askai; filePath+bytes for write; command+exit
 * for exec).
 */
export function renderCheckpointTimeline(
    entries: readonly CheckpointTimelineEntry[],
): string {
    const counts = entries.reduce(
        (acc, e) => {
            acc.total += 1;
            if (e.status === 'completed') acc.completed += 1;
            else if (e.status === 'in-flight') acc.inFlight += 1;
            else if (e.status === 'failed') acc.failed += 1;
            return acc;
        },
        { total: 0, completed: 0, inFlight: 0, failed: 0 },
    );

    const rowsHtml = entries
        .map((e) => `
            <div class="ckpt-row ckpt-row--${e.status}">
                <span class="ckpt-idx">#${e.opIndex}</span>
                <span class="ckpt-type ckpt-type--${e.opType}">${e.opType}</span>
                <span class="ckpt-status ckpt-status--${e.status}">${e.status}</span>
                <span class="ckpt-meta">${escHtml(formatCheckpointMeta(e))}</span>
                <span class="ckpt-time">${formatTime(e.completedAt ?? e.createdAt)}</span>
            </div>`).join('');

    return `
        <details class="checkpoint-timeline" open>
            <summary class="checkpoint-timeline-summary">
                Checkpoint timeline
                <span class="ckpt-tally">
                    ${counts.total} op${counts.total === 1 ? '' : 's'}
                    \u00b7 <span class="ckpt-tally-ok">${counts.completed} completed</span>
                    ${counts.inFlight > 0 ? `\u00b7 <span class="ckpt-tally-warn">${counts.inFlight} in-flight</span>` : ''}
                    ${counts.failed > 0 ? `\u00b7 <span class="ckpt-tally-err">${counts.failed} failed</span>` : ''}
                </span>
            </summary>
            <div class="checkpoint-timeline-rows">${rowsHtml}</div>
        </details>`;
}

/**
 * Format the per-op-type metadata into a single short line for the
 * timeline row. Keep it compact \u2014 the timeline is glanceable.
 */
export function formatCheckpointMeta(entry: CheckpointTimelineEntry): string {
    const m = entry.meta;
    switch (entry.opType) {
        case 'askai': {
            const model = typeof m['model'] === 'string' ? m['model'] : '\u2014';
            const tIn = typeof m['tokensIn'] === 'number' ? m['tokensIn'] : 0;
            const tOut = typeof m['tokensOut'] === 'number' ? m['tokensOut'] : 0;
            const cost = typeof m['costUsd'] === 'number' ? (m['costUsd'] as number) : 0;
            return `${model} \u00b7 ${tIn}\u2192${tOut} tok \u00b7 $${cost.toFixed(4)}`;
        }
        case 'write': {
            const filePath = typeof m['filePath'] === 'string' ? m['filePath'] : '\u2014';
            const bytes = typeof m['bytes'] === 'number' ? m['bytes'] : 0;
            return `${filePath} (${formatBytes(bytes)})`;
        }
        case 'exec': {
            const command = typeof m['command'] === 'string' ? m['command'] : '\u2014';
            const args = typeof m['args'] === 'string' ? m['args'] : '';
            const exitCode = typeof m['exitCode'] === 'number' ? m['exitCode'] : null;
            const exitStr = exitCode === null ? '' : ` \u2192 exit ${exitCode}`;
            return `${command} ${args}${exitStr}`.trim();
        }
        default:
            return entry.errorText ?? '';
    }
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Model Config Wiring ──────────────────────────────

function wireModelConfig(
    bodyEl: HTMLElement,
    agentName: string,
    callbacks: AgentDetailCallbacks
): void {
    const saveBtn = bodyEl.querySelector<HTMLButtonElement>('#agent-detail-save');
    const testBtn = bodyEl.querySelector<HTMLButtonElement>('#agent-detail-test');
    const enabledToggle = bodyEl.querySelector<HTMLInputElement>('#agent-detail-enabled');
    const feedbackEl = bodyEl.querySelector<HTMLElement>('#agent-detail-feedback');

    if (saveBtn !== null && callbacks.setAgentModel !== undefined) {
        const setModel = callbacks.setAgentModel;
        saveBtn.addEventListener('click', () => {
            const model = (bodyEl.querySelector<HTMLSelectElement>('#agent-detail-model'))?.value ?? '';
            const provider = (bodyEl.querySelector<HTMLSelectElement>('#agent-detail-provider'))?.value ?? '';
            showConfigFeedback(feedbackEl, 'Saving\u2026', 'neutral');
            void setModel(agentName, model, provider).then((result) => {
                if (result.success) {
                    showConfigFeedback(feedbackEl, 'Saved', 'success');
                } else {
                    showConfigFeedback(feedbackEl, `Error: ${result.error ?? 'unknown'}`, 'error');
                }
            });
        });
    }

    if (testBtn !== null && callbacks.testAgentModel !== undefined) {
        const testModel = callbacks.testAgentModel;
        testBtn.addEventListener('click', () => {
            const model = (bodyEl.querySelector<HTMLSelectElement>('#agent-detail-model'))?.value ?? '';
            const provider = (bodyEl.querySelector<HTMLSelectElement>('#agent-detail-provider'))?.value ?? '';
            showConfigFeedback(feedbackEl, 'Testing\u2026', 'neutral');
            void testModel(agentName, model, provider).then((result) => {
                if (result.success) {
                    const latency = result.latencyMs !== undefined ? ` (${result.latencyMs}ms)` : '';
                    showConfigFeedback(feedbackEl, `OK${latency}`, 'success');
                } else {
                    showConfigFeedback(feedbackEl, `Failed: ${result.error ?? 'no response'}`, 'error');
                }
            });
        });
    }

    if (enabledToggle !== null && callbacks.setAgentEnabled !== undefined) {
        const setEnabled = callbacks.setAgentEnabled;
        enabledToggle.addEventListener('change', () => {
            void setEnabled(agentName, enabledToggle.checked).then((result) => {
                if (!result.success) {
                    enabledToggle.checked = !enabledToggle.checked; // revert
                }
            });
        });
    }
}

function showConfigFeedback(el: HTMLElement | null, message: string, type: 'success' | 'error' | 'neutral'): void {
    if (el === null) return;
    el.textContent = message;
    el.className = `agent-config-feedback agent-config-feedback--${type}`;
    if (type === 'success') {
        setTimeout(() => { el.textContent = ''; }, 3000);
    }
}

// ── Helpers ───────────────────────────────────────────

function statusBadge(status: string): string {
    const map: Record<string, string> = {
        pending:   '<span class="task-badge task-badge--pending">pending</span>',
        assigned:  '<span class="task-badge task-badge--assigned">assigned</span>',
        completed: '<span class="task-badge task-badge--done">done</span>',
        failed:    '<span class="task-badge task-badge--error">failed</span>',
    };
    return map[status] ?? `<span class="task-badge">${escHtml(status)}</span>`;
}

function formatTime(iso: string): string {
    try {
        return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '--:--';
    }
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
    return s.replace(/"/g, '&quot;');
}

/**
 * Build <option> markup for a select where the live value should be
 * surfaced even if it isn't in the canonical list. Marks the live
 * value selected and prepends a "Custom · <value>" option when needed.
 */
function buildSelectOptions(known: readonly string[], current: string): string {
    const trimmed = current.trim();
    const isKnown = trimmed !== '' && known.includes(trimmed);
    const head = !isKnown && trimmed !== ''
        ? `<option value="${escAttr(trimmed)}" selected>Custom \u00B7 ${escHtml(trimmed)}</option>`
        : '';
    const tail = known.map((v) =>
        `<option value="${escAttr(v)}"${v === trimmed ? ' selected' : ''}>${escHtml(v)}</option>`
    ).join('');
    return head + tail;
}
