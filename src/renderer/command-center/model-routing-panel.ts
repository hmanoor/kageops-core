/**
 * KageOps Command Center — Model Routing Panel
 *
 * Preset cards: click a card to activate that preset.
 * All nine agents' models are shown in each card.
 * Design Provider lives below the preset grid.
 * Custom presets (create / duplicate / delete) remain accessible.
 */

import {
    PRESETS,
    AGENT_IDS,
    modelLabel,
    costTierLabel,
    type CostTier,
    type PresetDef,
} from '../../shared/model-registry';

// ── Types ────────────────────────────────────────────

export interface AgentModelConfig {
    readonly name: string;
    readonly model: string;
    readonly provider: string;
    readonly fallbackModels: readonly string[];
}

interface PresetInfo {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly exists: boolean;
    readonly isBuiltIn?: boolean;
}

interface DesignProviderInfo {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly available: boolean;
}

interface PresetAgentEntry {
    readonly model: string;
    readonly provider: string;
    readonly fallbackModels?: readonly string[];
}

interface ModelRoutingCallbacks {
    listPresets(): Promise<{ presets: readonly PresetInfo[]; active: string | null }>;
    setActivePreset(preset: string | null): Promise<{ success: boolean; active?: string | null; error?: string }>;
    listDesignProviders(): Promise<{ providers: readonly DesignProviderInfo[]; active: string }>;
    setActiveDesignProvider(providerId: string): Promise<{ success: boolean; active?: string; error?: string }>;
    createPreset?: (
        name: string,
        agents: Record<string, PresetAgentEntry>,
        overwrite?: boolean,
    ) => Promise<{ success: boolean; name?: string; error?: string }>;
    deletePreset?: (name: string) => Promise<{ success: boolean; error?: string }>;
    getPreset?: (name: string) => Promise<{
        success: boolean;
        config?: { agents: Record<string, PresetAgentEntry> };
        error?: string;
    }>;
}

// ── Design provider extended metadata ────────────────
// Supplements the server-side DesignProviderInfo with display-only data.

interface DesignProviderMeta {
    readonly statusLabel: string;
    readonly statusClass: string;
    readonly detail: string;       // what it does right now
    readonly roadmap?: string;     // what's coming / planned
    readonly costNote?: string;    // cost hint for available providers
}

const DESIGN_PROVIDER_META: Readonly<Record<string, DesignProviderMeta>> = {
    'in-house': {
        statusLabel: 'Live',
        statusClass: 'mr-dp-badge--live',
        detail: 'Routes Pixel through whatever model the active preset assigns — zero extra config. On budget presets this is the cheapest path.',
        costNote: 'Cost follows your active preset model.',
    },
    'claude-ui': {
        statusLabel: 'Live',
        statusClass: 'mr-dp-badge--live',
        detail: 'Pins Claude Sonnet 4.6 with a design-focused system prompt tuned for HTML/CSS output quality.',
        costNote: '$3/M in · $15/M out (Anthropic API pricing).',
    },
    'openai-ui': {
        statusLabel: 'Live',
        statusClass: 'mr-dp-badge--live',
        detail: 'Routes Pixel directly through the OpenAI API using GPT-4o. Requires OPENAI_API_KEY in keychain or env.',
        costNote: '$2.50/M in · $10/M out (GPT-4o pricing).',
    },
    'v0': {
        statusLabel: 'Coming soon',
        statusClass: 'mr-dp-badge--soon',
        detail: 'Vercel v0 design-to-code. Pixel submits a prompt and receives production-ready React + Tailwind.',
        roadmap: 'generateUI() scaffold is in place. Awaiting V0_API_KEY support and response adapter. ETA: next sprint.',
    },
    'figma': {
        statusLabel: 'Coming soon',
        statusClass: 'mr-dp-badge--soon',
        detail: 'Figma frame importer. Pixel reads existing designs from a Figma URL and converts them to clean HTML/CSS output.',
        roadmap: 'Read-only REST API integration planned. Requires FIGMA_API_TOKEN. Will support frame selection by URL.',
    },
    'locofy': {
        statusLabel: 'Coming soon',
        statusClass: 'mr-dp-badge--soon',
        detail: 'Locofy.ai design-to-code conversion. Converts design assets to React/Next.js components automatically.',
        roadmap: 'API integration planned. Will support Figma and Adobe XD source files. Requires LOCOFY_API_KEY.',
    },
};

const AGENT_ORDER: readonly string[] = [
    'sensei', 'scout', 'blueprint', 'pixel', 'forge', 'cipher', 'aegis', 'vigil', 'herald',
];

const KNOWN_PROVIDERS: readonly string[] = [
    'claude-cli', 'claude', 'openai', 'ollama', 'google', 'openrouter', 'codex', 'copilot',
];

const KNOWN_MODELS: readonly string[] = [
    'claude-cli/sonnet',
    'claude-cli/haiku',
    'claude-cli/opus',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'ollama/glm-5.1:cloud',
    'ollama/qwen3-coder-next:cloud',
    'ollama/devstral-small-2:24b-cloud',
    'ollama/gpt-oss:120b-cloud',
    'ollama/qwen3.5:9b',
    'openrouter/anthropic/claude-sonnet-4',
    'openrouter/anthropic/claude-haiku-3-5',
    'openrouter/google/gemini-2.5-flash',
    'openrouter/deepseek/deepseek-chat-v3',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
];

// ── Render entry point ────────────────────────────────

export function renderModelRoutingPanel(
    container: HTMLElement,
    callbacks: ModelRoutingCallbacks
): void {
    container.innerHTML = '<div class="empty-state">Loading…</div>';
    void loadAndRender(container, callbacks);
}

async function loadAndRender(
    container: HTMLElement,
    callbacks: ModelRoutingCallbacks
): Promise<void> {
    let presetData: { presets: readonly PresetInfo[]; active: string | null } = { presets: [], active: null };
    let designData: { providers: readonly DesignProviderInfo[]; active: string } = { providers: [], active: 'in-house' };
    try { presetData = await callbacks.listPresets(); } catch { /* non-fatal */ }
    try { designData = await callbacks.listDesignProviders(); } catch { /* non-fatal */ }

    const canEdit = callbacks.createPreset !== undefined;
    container.innerHTML = buildPanelHtml(presetData, designData, canEdit);
    wireInteractions(container, callbacks, presetData);
}

// ── Panel HTML ────────────────────────────────────────

function buildPanelHtml(
    presetData: { presets: readonly PresetInfo[]; active: string | null },
    designData: { providers: readonly DesignProviderInfo[]; active: string },
    canEditPresets: boolean,
): string {
    const activeId = presetData.active ?? '';

    // Registry preset IDs for lookup
    const registryIds = new Set(PRESETS.map((p) => p.id));

    // Custom (user-created) presets not in the registry
    const customServerPresets = presetData.presets.filter(
        (p) => !registryIds.has(p.name) && p.exists !== false && p.isBuiltIn !== true,
    );

    // "Custom mode" card (no preset)
    const customModeCard = buildCustomModeCard(activeId === '');

    // Built-in preset cards from registry
    const registryCards = PRESETS.map((p) => {
        const serverInfo = presetData.presets.find((s) => s.name === p.id);
        return buildPresetCard(p, activeId === p.id, serverInfo?.exists ?? true);
    }).join('');

    // User-created preset cards
    const customUserCards = customServerPresets.map((p) =>
        buildCustomUserPresetCard(p, activeId === p.name),
    ).join('');

    const feedbackHtml = '<div class="mr-feedback preset-feedback" role="alert"></div>';

    const actionsHtml = canEditPresets ? `
        <div class="mr-custom-actions">
            <button type="button" class="mr-action-btn preset-new-btn">+ New preset</button>
            <button type="button" class="mr-action-btn preset-duplicate-btn">Duplicate active</button>
            <button type="button" class="mr-action-btn mr-action-btn--danger preset-delete-btn"${isActiveCustomUserPreset(presetData) ? '' : ' disabled'}>Delete active</button>
        </div>` : '';

    const designSection = buildDesignSection(designData);

    return `
        <div class="mr-panel">
            <div class="mr-section">
                <div class="mr-section-header">
                    <span class="mr-section-title">PROVIDER PRESET</span>
                    <span class="mr-section-sub">Controls which model each Autonaut uses — takes effect on the next task</span>
                </div>
                <div class="mr-preset-grid">
                    ${customModeCard}
                    ${registryCards}
                    ${customUserCards}
                </div>
                ${feedbackHtml}
                ${actionsHtml}
            </div>
            ${designSection}
            ${buildPresetEditorModal()}
        </div>`;
}

function buildCustomModeCard(isActive: boolean): string {
    const activeCls = isActive ? ' mr-preset-card--active' : '';
    const check = isActive ? '<span class="mr-card-check">✓</span>' : '';
    return `
        <div class="mr-preset-card mr-preset-card--custom${activeCls}" data-preset-id="" role="button" tabindex="0">
            ${check}
            <div class="mr-card-header">
                <span class="mr-card-name">Custom</span>
                <span class="mr-cost-badge mr-cost-badge--neutral">Manual</span>
            </div>
            <p class="mr-card-desc">No preset active — each agent uses the model configured individually in Autonauts.</p>
            <p class="mr-card-tradeoff">Full control. Changes in Autonauts → Configuration take effect immediately.</p>
        </div>`;
}

function buildPresetCard(preset: PresetDef, isActive: boolean, exists: boolean): string {
    const activeCls = isActive ? ' mr-preset-card--active' : '';
    const missingCls = !exists ? ' mr-preset-card--missing' : '';
    const check = isActive ? '<span class="mr-card-check">✓</span>' : '';
    const missingBadge = !exists ? '<span class="mr-cost-badge mr-cost-badge--warn">file missing</span>' : '';

    const agentRows = AGENT_IDS.map((agentId) => {
        const modelId = preset.agentModels[agentId] ?? '';
        const label = modelLabel(modelId);
        return `<span class="mr-agent-name">${agentId}</span><span class="mr-agent-model" title="${escapeAttr(label)}">${escapeHtml(truncateModel(label))}</span>`;
    }).join('');

    return `
        <div class="mr-preset-card${activeCls}${missingCls}" data-preset-id="${escapeAttr(preset.id)}" role="button" tabindex="0">
            ${check}
            <div class="mr-card-header">
                <span class="mr-card-name">${escapeHtml(preset.label)}</span>
                <span class="mr-cost-badge ${costTierClass(preset.costTier)}">${escapeHtml(costTierLabel(preset.costTier))}${missingBadge}</span>
            </div>
            <p class="mr-card-desc">${escapeHtml(preset.description)}</p>
            <p class="mr-card-tradeoff">${escapeHtml(preset.tradeoff)}</p>
            <div class="mr-agent-table">${agentRows}</div>
        </div>`;
}

function buildCustomUserPresetCard(info: PresetInfo, isActive: boolean): string {
    const activeCls = isActive ? ' mr-preset-card--active' : '';
    const check = isActive ? '<span class="mr-card-check">✓</span>' : '';
    return `
        <div class="mr-preset-card${activeCls}" data-preset-id="${escapeAttr(info.name)}" role="button" tabindex="0">
            ${check}
            <div class="mr-card-header">
                <span class="mr-card-name">${escapeHtml(info.label)}</span>
                <span class="mr-cost-badge mr-cost-badge--neutral">Custom</span>
            </div>
            <p class="mr-card-desc">${escapeHtml(info.description)}</p>
        </div>`;
}

function buildDesignSection(designData: { providers: readonly DesignProviderInfo[]; active: string }): string {
    const cards = designData.providers.map((p) => buildDesignCard(p, p.id === designData.active)).join('');

    return `
        <div class="mr-section mr-section--design">
            <div class="mr-section-header">
                <span class="mr-section-title">DESIGN PROVIDER</span>
                <span class="mr-section-sub">Overrides Pixel's UI-generation model independently of the preset</span>
            </div>
            <div class="mr-dp-grid">${cards}</div>
            <div class="design-provider-feedback mr-feedback" role="alert"></div>
        </div>`;
}

function buildDesignCard(provider: DesignProviderInfo, isActive: boolean): string {
    const meta = DESIGN_PROVIDER_META[provider.id] ?? {
        statusLabel: provider.available ? 'Live' : 'Coming soon',
        statusClass: provider.available ? 'mr-dp-badge--live' : 'mr-dp-badge--soon',
        detail: provider.description,
    };

    const activeCls = isActive ? ' mr-preset-card--active' : '';
    const unavailCls = !provider.available ? ' mr-dp-card--soon' : '';
    const check = isActive ? '<span class="mr-card-check">✓</span>' : '';

    const costRow = meta.costNote !== undefined
        ? `<p class="mr-dp-cost">${escapeHtml(meta.costNote)}</p>`
        : '';

    const roadmapRow = meta.roadmap !== undefined
        ? `<p class="mr-dp-roadmap"><span class="mr-dp-roadmap-label">Planned —</span> ${escapeHtml(meta.roadmap)}</p>`
        : '';

    const dataAttr = provider.available ? `data-design-provider="${escapeAttr(provider.id)}" role="button" tabindex="0"` : 'aria-disabled="true"';

    return `
        <div class="mr-preset-card mr-dp-card${activeCls}${unavailCls}" ${dataAttr}>
            ${check}
            <div class="mr-card-header">
                <span class="mr-card-name">${escapeHtml(provider.label)}</span>
                <span class="mr-dp-badge ${meta.statusClass}">${escapeHtml(meta.statusLabel)}</span>
            </div>
            <p class="mr-card-desc">${escapeHtml(meta.detail)}</p>
            ${costRow}
            ${roadmapRow}
        </div>`;
}

function buildPresetEditorModal(): string {
    return `
        <div class="preset-editor-modal" data-state="closed" hidden>
            <div class="preset-editor-modal__backdrop"></div>
            <div class="preset-editor-modal__sheet" role="dialog" aria-label="New preset">
                <header class="preset-editor-modal__head">
                    <h3 class="preset-editor-modal__title">New preset</h3>
                    <button type="button" class="preset-editor-modal__close" aria-label="Close">&#x2715;</button>
                </header>
                <div class="preset-editor-modal__body">
                    <label class="preset-editor-row">
                        <span class="preset-editor-label">Preset name</span>
                        <input type="text" class="preset-editor-name" maxlength="32"
                               placeholder="e.g. claude_premium_lite"
                               pattern="[a-z][a-z0-9_-]*">
                    </label>
                    <p class="preset-editor-hint">Lowercase letters, digits, _ or -. 1–32 chars. Starts with a letter.</p>
                    <div class="preset-editor-grid">
                        <div class="preset-editor-grid__head">
                            <span>Agent</span><span>Provider</span><span>Model</span>
                        </div>
                        <div class="preset-editor-grid__body" data-role="agents-grid"></div>
                    </div>
                    <div class="preset-editor-feedback" role="alert"></div>
                </div>
                <footer class="preset-editor-modal__foot">
                    <button type="button" class="preset-editor-cancel btn-secondary">Cancel</button>
                    <button type="button" class="preset-editor-save btn-primary">Save preset</button>
                </footer>
            </div>
        </div>`;
}

// ── Helpers ───────────────────────────────────────────

function costTierClass(tier: CostTier): string {
    switch (tier) {
        case 'free': return 'mr-cost-badge--free';
        case '$':    return 'mr-cost-badge--low';
        case '$$':   return 'mr-cost-badge--mid';
        case '$$$':  return 'mr-cost-badge--high';
    }
}

function isActiveCustomUserPreset(presetData: { presets: readonly PresetInfo[]; active: string | null }): boolean {
    if (presetData.active === null || presetData.active === '') return false;
    const entry = presetData.presets.find((p) => p.name === presetData.active);
    return entry !== undefined && entry.isBuiltIn === false;
}

function truncateModel(label: string): string {
    return label.length > 22 ? `${label.slice(0, 21)}…` : label;
}

// ── Interactions ──────────────────────────────────────

function wireInteractions(
    container: HTMLElement,
    callbacks: ModelRoutingCallbacks,
    presetData: { presets: readonly PresetInfo[]; active: string | null },
): void {
    wirePresetCards(container, callbacks);
    wireDesignProviderSelect(container, callbacks);
    wirePresetActions(container, callbacks, presetData);
}

function wirePresetCards(container: HTMLElement, callbacks: ModelRoutingCallbacks): void {
    const feedback = container.querySelector<HTMLElement>('.preset-feedback');

    container.querySelectorAll<HTMLElement>('.mr-preset-card').forEach((card) => {
        const activate = async (): Promise<void> => {
            const presetId = card.dataset['presetId'] ?? '';
            const value = presetId === '' ? null : presetId;

            if (feedback !== null) {
                feedback.textContent = 'Applying…';
                feedback.style.color = 'var(--text-muted)';
            }

            try {
                const result = await callbacks.setActivePreset(value);
                if (result.success) {
                    if (feedback !== null) {
                        feedback.textContent = value !== null
                            ? `Preset "${value}" active — applies to next task`
                            : 'Custom mode active — per-agent settings apply';
                        feedback.style.color = 'var(--color-success, oklch(0.78 0.17 145))';
                        setTimeout(() => { if (feedback !== null) feedback.textContent = ''; }, 3500);
                    }
                    setTimeout(() => loadAndRender(container, callbacks), 300);
                } else if (feedback !== null) {
                    feedback.textContent = `Error: ${result.error ?? 'unknown'}`;
                    feedback.style.color = 'var(--color-danger, oklch(0.72 0.18 25))';
                }
            } catch (err) {
                if (feedback !== null) {
                    feedback.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
                    feedback.style.color = 'var(--color-danger, oklch(0.72 0.18 25))';
                }
            }
        };

        card.addEventListener('click', () => void activate());
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void activate(); }
        });
    });
}

function wireDesignProviderSelect(container: HTMLElement, callbacks: ModelRoutingCallbacks): void {
    const feedback = container.querySelector<HTMLElement>('.design-provider-feedback');

    container.querySelectorAll<HTMLElement>('[data-design-provider]').forEach((card) => {
        const activate = async (): Promise<void> => {
            const providerId = card.dataset['designProvider'] ?? '';
            if (providerId === '') return;
            if (feedback !== null) { feedback.textContent = 'Saving…'; feedback.style.color = 'var(--text-muted)'; }
            try {
                const result = await callbacks.setActiveDesignProvider(providerId);
                if (result.success) {
                    if (feedback !== null) {
                        feedback.textContent = 'Saved — applies to next run';
                        feedback.style.color = 'var(--color-success, oklch(0.78 0.17 145))';
                        setTimeout(() => { if (feedback !== null) feedback.textContent = ''; }, 3000);
                    }
                    setTimeout(() => loadAndRender(container, callbacks), 300);
                } else if (feedback !== null) {
                    feedback.textContent = `Error: ${result.error ?? 'unknown'}`;
                    feedback.style.color = 'var(--color-danger, oklch(0.72 0.18 25))';
                }
            } catch (err) {
                if (feedback !== null) {
                    feedback.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
                    feedback.style.color = 'var(--color-danger, oklch(0.72 0.18 25))';
                }
            }
        };

        card.addEventListener('click', () => void activate());
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void activate(); }
        });
    });
}

// ── Custom preset CRUD ────────────────────────────────

function wirePresetActions(
    container: HTMLElement,
    callbacks: ModelRoutingCallbacks,
    presetData: { presets: readonly PresetInfo[]; active: string | null },
): void {
    if (callbacks.createPreset === undefined) return;

    container.querySelector<HTMLButtonElement>('.preset-new-btn')?.addEventListener('click', () => {
        void openPresetEditor(container, callbacks, { mode: 'new', presetData });
    });
    container.querySelector<HTMLButtonElement>('.preset-duplicate-btn')?.addEventListener('click', () => {
        void openPresetEditor(container, callbacks, { mode: 'duplicate', presetData });
    });
    container.querySelector<HTMLButtonElement>('.preset-delete-btn')?.addEventListener('click', () => {
        void handleDeleteActive(container, callbacks, presetData);
    });
}

async function handleDeleteActive(
    container: HTMLElement,
    callbacks: ModelRoutingCallbacks,
    presetData: { presets: readonly PresetInfo[]; active: string | null },
): Promise<void> {
    if (callbacks.deletePreset === undefined || presetData.active === null) return;
    const active = presetData.active;
    const entry = presetData.presets.find((p) => p.name === active);
    if (entry === undefined || entry.isBuiltIn !== false) return;
    if (!window.confirm(`Delete custom preset "${active}"? This cannot be undone.`)) return;

    const feedback = container.querySelector<HTMLElement>('.preset-feedback');
    if (feedback !== null) { feedback.textContent = 'Deleting…'; feedback.style.color = 'var(--text-muted)'; }
    const result = await callbacks.deletePreset(active);
    if (!result.success) {
        if (feedback !== null) { feedback.textContent = `Error: ${result.error ?? 'unknown'}`; feedback.style.color = 'var(--color-danger, oklch(0.72 0.18 25))'; }
        return;
    }
    void loadAndRender(container, callbacks);
}

interface PresetEditorContext {
    readonly mode: 'new' | 'duplicate';
    readonly presetData: { presets: readonly PresetInfo[]; active: string | null };
}

async function openPresetEditor(
    container: HTMLElement,
    callbacks: ModelRoutingCallbacks,
    ctx: PresetEditorContext,
): Promise<void> {
    const modal = container.querySelector<HTMLElement>('.preset-editor-modal');
    const grid = container.querySelector<HTMLElement>('[data-role="agents-grid"]');
    const nameInput = container.querySelector<HTMLInputElement>('.preset-editor-name');
    const feedback = container.querySelector<HTMLElement>('.preset-editor-feedback');
    if (modal === null || grid === null || nameInput === null) return;

    let seed: Record<string, PresetAgentEntry> = defaultAgentMap();
    if (callbacks.getPreset !== undefined && ctx.presetData.active !== null) {
        try {
            const result = await callbacks.getPreset(ctx.presetData.active);
            if (result.success && result.config !== undefined) seed = result.config.agents;
        } catch { /* fall back to defaults */ }
    }

    grid.innerHTML = AGENT_ORDER.map((name) => {
        const e = seed[name] ?? { model: 'claude-cli/sonnet', provider: 'claude-cli' };
        return `
            <div class="preset-editor-row-item" data-agent="${escapeAttr(name)}">
                <span class="preset-editor-agent">${escapeHtml(name)}</span>
                <select class="preset-editor-provider field-select">${buildProviderOptions(e.provider)}</select>
                <input type="text" class="preset-editor-model field-input"
                       value="${escapeAttr(e.model)}" list="preset-editor-models" placeholder="provider/model-name">
            </div>`;
    }).join('') + `<datalist id="preset-editor-models">${KNOWN_MODELS.map((m) => `<option value="${escapeAttr(m)}"></option>`).join('')}</datalist>`;

    nameInput.value = ctx.mode === 'duplicate' && ctx.presetData.active !== null
        ? `${ctx.presetData.active}_copy`
        : '';
    if (feedback !== null) feedback.textContent = '';

    modal.hidden = false;
    modal.dataset['state'] = 'open';

    const cleanup = (): void => { modal.hidden = true; modal.dataset['state'] = 'closed'; };

    modal.querySelector<HTMLElement>('.preset-editor-modal__backdrop')?.addEventListener('click', cleanup, { once: true });
    modal.querySelector<HTMLElement>('.preset-editor-modal__close')?.addEventListener('click', cleanup, { once: true });
    modal.querySelector<HTMLElement>('.preset-editor-cancel')?.addEventListener('click', cleanup, { once: true });

    const saveBtn = modal.querySelector<HTMLButtonElement>('.preset-editor-save');
    if (saveBtn !== null) {
        const handler = async (): Promise<void> => {
            if (callbacks.createPreset === undefined) return;
            const name = nameInput.value.trim();
            if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
                if (feedback !== null) { feedback.textContent = 'Name must be 1–32 chars, start with a letter, only lowercase + digits + _ or -.'; feedback.style.color = 'var(--color-danger,red)'; }
                return;
            }
            const agents: Record<string, PresetAgentEntry> = {};
            grid.querySelectorAll<HTMLElement>('.preset-editor-row-item').forEach((row) => {
                const agent = row.dataset['agent'] ?? '';
                const provider = row.querySelector<HTMLSelectElement>('.preset-editor-provider')?.value.trim() ?? '';
                const model = row.querySelector<HTMLInputElement>('.preset-editor-model')?.value.trim() ?? '';
                if (agent !== '' && provider !== '' && model !== '') agents[agent] = { model, provider, fallbackModels: [] };
            });
            if (Object.keys(agents).length === 0) {
                if (feedback !== null) { feedback.textContent = 'At least one agent must have a model + provider.'; feedback.style.color = 'var(--color-danger,red)'; }
                return;
            }
            saveBtn.disabled = true;
            if (feedback !== null) { feedback.textContent = 'Saving…'; feedback.style.color = 'var(--text-muted)'; }
            const result = await callbacks.createPreset(name, agents, false);
            saveBtn.disabled = false;
            if (!result.success) {
                if (feedback !== null) { feedback.textContent = `Error: ${result.error ?? 'unknown'}`; feedback.style.color = 'var(--color-danger,red)'; }
                return;
            }
            cleanup();
            await callbacks.setActivePreset(name).catch(() => null);
            void loadAndRender(container, callbacks);
        };
        saveBtn.addEventListener('click', () => void handler());
    }
}

function defaultAgentMap(): Record<string, PresetAgentEntry> {
    const out: Record<string, PresetAgentEntry> = {};
    for (const a of AGENT_ORDER) out[a] = { model: 'claude-cli/sonnet', provider: 'claude-cli' };
    return out;
}

function buildProviderOptions(current: string): string {
    const options = KNOWN_PROVIDERS.map((p) =>
        `<option value="${escapeAttr(p)}"${p === current ? ' selected' : ''}>${escapeHtml(p)}</option>`
    );
    if (current !== '' && !KNOWN_PROVIDERS.includes(current)) {
        options.unshift(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)}</option>`);
    }
    return options.join('');
}

// ── Utilities ─────────────────────────────────────────

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
