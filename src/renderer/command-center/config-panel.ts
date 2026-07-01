/**
 * KageOps Configuration Panel
 *
 * Full-page overlay panel for managing API keys, agent providers,
 * environment variables, and app information.
 */

import { icon } from '../../shared/icons';

// ── Types ────────────────────────────────────────────

interface ProviderStatus {
    readonly hasKey: boolean;
    /**
     * - 'keychain'      = user-stored value is the live one (green badge)
     * - 'env'           = env var is the live one (orange — only when keychain
     *                     empty AND env-fallback is enabled)
     * - 'env-shadowed'  = env var is set but keychain wins → blue/info badge
     *                     "Stored — env var also set, can be removed"
     * - 'none'          = no key found anywhere (red badge)
     */
    readonly source: 'keychain' | 'env' | 'env-shadowed' | 'none';
    readonly label: string;
    /** F-313: env var name (e.g. "ANTHROPIC_API_KEY") so the UI can name it. */
    readonly envVarName?: string;
    /** F-313: whether the env var is actually present in the process. */
    readonly envVarPresent?: boolean;
    /** F-313: whether env-var fallback is honoured at runtime. */
    readonly envFallbackEnabled?: boolean;
}

interface AgentEntry {
    readonly model: string;
    readonly provider: string;
    readonly fallbackModels: readonly string[];
}

interface ConfigSnapshot {
    readonly providers: Record<string, ProviderStatus>;
    readonly agents: Record<string, AgentEntry>;
    readonly envVars: Record<string, string | null>;
}

interface ProviderKeySummary {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly projectId: string | null;
    readonly isDefault: boolean;
    readonly hasKey: boolean;
    readonly createdAt: string;
}

export interface ConfigCallbacks {
    getConfigSnapshot(): Promise<ConfigSnapshot>;
    configSaveApiKey(provider: string, key: string): Promise<{ success: boolean; error?: string }>;
    /** F-313: copy current env-var value into keychain so the env can be safely cleared. */
    configPromoteEnvKey?(provider: string): Promise<{ success: boolean; error?: string }>;
    configDeleteApiKey(provider: string): Promise<{ success: boolean; error?: string }>;
    testProvider(provider: string): Promise<{ success: boolean; latencyMs?: number; error?: string }>;
    saveEnvVar(key: string, value: string): Promise<{ success: boolean; error?: string }>;
    getEnvVars(): Promise<Record<string, string | null>>;
    setAgentProvider(agentName: string, provider: string, model: string): Promise<{ success: boolean; error?: string }>;
    listProviderKeys(provider?: string, projectId?: string | null): Promise<{ success: boolean; keys: readonly ProviderKeySummary[]; error?: string }>;
    addProviderKey(provider: string, label: string, apiKey: string, projectId?: string | null, isDefault?: boolean): Promise<{ success: boolean; key?: ProviderKeySummary; error?: string }>;
    updateProviderKey(keyId: string, updates: { label?: string; isDefault?: boolean; projectId?: string | null; apiKey?: string }): Promise<{ success: boolean; error?: string }>;
    deleteProviderKey(keyId: string): Promise<{ success: boolean; error?: string }>;
}

// ── Constants ────────────────────────────────────────

const PROVIDER_ORDER = ['claude', 'openrouter', 'openai', 'gemini', 'ollama', 'github'] as const;
const AGENT_NAMES = ['sensei', 'scout', 'blueprint', 'forge', 'vigil', 'aegis', 'pixel', 'cipher', 'herald'] as const;
const AGENT_PROVIDER_OPTIONS = ['claude', 'openrouter', 'openai', 'gemini', 'ollama'] as const;

const ENV_VAR_DESCRIPTIONS: Record<string, string> = {
    // Core paths + DB
    KAGEOPS_PROJECTS_DIR:
        'Root directory for all KageOps project workspaces. Each project gets its own subdir here.',
    KAGEOPS_DATA_DIR:
        'Directory for KageOps runtime data: PGlite database, agent-config presets, settings.json. Default: ~/.kageops.',
    KAGEOPS_MAX_CONCURRENCY:
        'Max parallel agent tasks. Default: 3. Higher values speed up multi-task phases at the cost of more concurrent AI calls.',
    DATABASE_URL:
        'PostgreSQL connection string. When set, KageOps uses external Postgres instead of embedded PGlite. Format: postgres://user:pass@host:5432/db.',

    // Cost guardrails
    KAGEOPS_MAX_RUN_USD:
        'Hard budget cap per project run (USD). Budget-kill polls every 3s and cancels the project once SUM(cost_usd) >= cap. Default: 0.25.',
    KAGEOPS_MAX_AI_CALLS_PER_TASK:
        'Per-task AI-call cap. Prevents runaway TDD/review loops from burning 40+ calls on one task. Default: 8.',
    KAGEOPS_HEADLESS_TIMEOUT_MS:
        'Timeout for headless-runner pipelines (milliseconds). npx swallows the --timeout flag, so this env var is the reliable way to extend it. Default: 600000 (10 min).',
    KAGEOPS_ZOMBIE_TIMEOUT_MS:
        'Abort projects with zero decomposed tasks after this many ms. Default: 60000.',

    // Preset + design provider routing
    KAGEOPS_PRESET:
        'Active model preset. Overrides active-preset.txt. Options: claude-cli, claude-cli-premium, codex-cli, ollama, openrouter_budget, openrouter_standard, or any custom preset name.',
    KAGEOPS_DESIGN_PROVIDER:
        'Design provider for Pixel\'s ui-build task. Options: in-house (uses preset), claude-ui (pinned Claude Opus 4.7 on subscription), openai-ui (pinned GPT-5 family via direct OpenAI API), v0, figma, locofy. Routes ONLY Pixel ui-build calls; other agents are unaffected.',
    KAGEOPS_CLAUDE_UI_MODEL:
        'Override the model used by claude-ui design provider. Default: claude-cli/claude-opus-4-7 (subscription, free). Examples: claude-cli/claude-sonnet-4-6, claude/claude-opus-4-20250514 (paid API).',
    KAGEOPS_CLAUDE_UI_MAX_TOKENS:
        'Max output tokens for claude-ui calls. Defaults to the provider\'s sensible cap.',
    KAGEOPS_OPENAI_UI_MODEL:
        'Override the model used by openai-ui design provider. Default: openai/gpt-5.4. Other options: openai/gpt-5.5, openai/gpt-5.3, openai/gpt-4o (cheaper fallback), openai/o1 (extra-careful UI).',
    KAGEOPS_OPENAI_UI_MAX_TOKENS:
        'Max output tokens for openai-ui calls. Defaults to the provider\'s sensible cap.',

    // Behavior toggles
    KAGEOPS_DISABLE_GIT:
        'Set to 1 to skip ALL git operations (init, branch, commit, merge, push). Useful for benchmark + test runs where commit history is unwanted. Default: git enabled.',
    KAGEOPS_DRY_RUN:
        'Set to 1 to enable dry-run mode in the headless runner — decomposes phases, prints task plan, no AI calls or spend.',
    KAGEOPS_DB_MODE:
        'Force DB mode regardless of DATABASE_URL. Options: embedded (PGlite WASM) or external (real Postgres). Default: auto-detect based on DATABASE_URL.',

    // APO (Automatic Prompt Optimization — opt-in nightly loop)
    KAGEOPS_APO_ENABLED:
        'Set to 1 to enable the nightly APO scheduler. Off by default. APO mutates baseline prompts for scout/herald/pixel and writes proposals to prompt_optimizations table; humans review + accept via the APO panel.',
    KAGEOPS_APO_EVAL_MODEL:
        'Model that scores each mutated prompt candidate against the golden-task corpus (0.0–1.0). Runs many times per cycle — prefer a fast, cheap model. A reasoning model (DeepSeek R1, o3-mini) gives more accurate scores at higher cost. Default: openrouter/openai/gpt-4o-mini.',
    KAGEOPS_APO_MUTATOR_MODEL:
        'Model that generates prompt mutations from the baseline. Needs strong instruction-following and creativity. A thinking model (Sonnet, Opus, R1) produces higher-quality rewrites; Haiku/mini is cheaper but shallower. Default: claude/claude-haiku-4-5-20251001.',
    KAGEOPS_APO_MIN_DELTA:
        'How much better a mutated prompt must score vs. the baseline before it is saved as a proposal. Scores are 0.0–1.0. Examples: 0.02 = save anything with even a small gain (permissive); 0.05 = recommended default, filters noise; 0.10 = only keep substantial improvements (strict). If baseline scores 0.65 and min_delta is 0.05, a candidate needs ≥ 0.70 to be saved.',

    // Skills hooks (opt-in)
    KAGEOPS_SKILLS_HOOKS:
        'Set to true to enable the skill-augmentation hooks (system-prompt enrichment from a skill library). Default: off.',
};

// Suggested values shown in a datalist dropdown for specific env vars.
// Free-form input still works — datalist is hints, not a hard constraint.
const ENV_VAR_SUGGESTIONS: Readonly<Record<string, ReadonlyArray<{ readonly value: string; readonly label: string }>>> = {
    KAGEOPS_APO_EVAL_MODEL: [
        { value: 'openrouter/openai/gpt-4o-mini',          label: 'GPT-4o mini — default, fast + cheap' },
        { value: 'openrouter/openai/gpt-4o',               label: 'GPT-4o — better scoring accuracy' },
        { value: 'openrouter/openai/o3-mini',              label: 'o3-mini — reasoning model, highest accuracy' },
        { value: 'openrouter/deepseek/deepseek-r1',        label: 'DeepSeek R1 — reasoning model, very accurate' },
        { value: 'openrouter/anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — strong structured eval' },
        { value: 'claude/claude-haiku-4-5-20251001',       label: 'Claude Haiku 4.5 — fast, direct API' },
    ],
    KAGEOPS_APO_MUTATOR_MODEL: [
        { value: 'claude/claude-haiku-4-5-20251001',       label: 'Claude Haiku 4.5 — default, fast + cheap' },
        { value: 'claude/claude-sonnet-4-6',               label: 'Claude Sonnet 4.6 — recommended, better mutations' },
        { value: 'claude/claude-opus-4-7',                 label: 'Claude Opus 4.7 — highest quality, expensive' },
        { value: 'openrouter/openai/gpt-4o-mini',          label: 'GPT-4o mini — cheap OpenAI alternative' },
        { value: 'openrouter/deepseek/deepseek-r1',        label: 'DeepSeek R1 — thinks through rewrites carefully' },
    ],
};

// ── Helpers ──────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls !== undefined) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
}

function statusBadge(status: ProviderStatus): string {
    const envVar = status.envVarName !== undefined && status.envVarName !== ''
        ? status.envVarName
        : '';
    const envHint = envVar !== '' ? ` title="Env var: ${envVar}"` : '';

    // Decision #74 / F-313: badge reflects the *actual* runtime source, not
    // just "anything present". Keychain ALWAYS wins when set; env var is only
    // the live value when keychain is empty AND the runtime is configured
    // to use env-var fallback. Wording is action-oriented and avoids the
    // confusing "Not set + env ignored" compound that an earlier iteration
    // shipped — see screenshot feedback 2026-05-10.
    if (status.hasKey && status.source === 'keychain') {
        // Plain green — KageOps owns this key, no env var present.
        return `<span class="config-status" style="color:var(--status-success,#22c55e)"${envHint}>${icon('check-circle', { size: 12 })} Stored</span>`;
    }
    if (status.hasKey && status.source === 'env-shadowed') {
        // Stored in keychain (winning) but env var is also set in the OS — the
        // env value is silently ignored. Friendly nudge: "you can clean this up".
        const tip = envVar !== ''
            ? `Stored in keychain (active). ${envVar} is also set in your OS environment but ignored — you can remove it for tidiness.`
            : 'Stored in keychain (active).';
        return `<span class="config-status" style="color:var(--status-success,#22c55e)" title="${tip}">${icon('check-circle', { size: 12 })} Stored<span style="opacity:0.55;margin-left:6px;font-size:10px;font-weight:500">env can be removed</span></span>`;
    }
    if (status.hasKey && status.source === 'env') {
        // Env var is the live value. Action: click "Move to keychain" so KageOps
        // owns it authoritatively, then remove the env var.
        const tip = envVar !== ''
            ? `Currently using ${envVar} from your OS environment. Click "Move to keychain" so KageOps owns the key, then remove the env var.`
            : 'Currently using an environment variable.';
        return `<span class="config-status" style="color:var(--status-warning,#f59e0b)" title="${tip}">${icon('alert-triangle', { size: 12 })} From environment</span>`;
    }
    if (!status.hasKey && status.envVarPresent === true && status.envFallbackEnabled === false) {
        // Env var is set but the runtime ignores it (production safety).
        // The user can either: (a) Move to keychain to capture the env value,
        // or (b) type a fresh key + Save. Either way, no surprise.
        const tip = envVar !== ''
            ? `Found ${envVar} in your OS environment, but KageOps ignores env vars in production mode for safety. Click "Move to keychain" to capture this value, OR type a new key + Save.`
            : 'Env var detected but ignored.';
        return `<span class="config-status" style="color:var(--status-warning,#f59e0b)" title="${tip}">${icon('alert-triangle', { size: 12 })} Env detected<span style="opacity:0.55;margin-left:6px;font-size:10px;font-weight:500">click Move to capture</span></span>`;
    }
    // Truly nothing — no keychain, no env. Action: type a key, click Save.
    return `<span class="config-status" style="color:var(--status-danger,#ef4444)"${envHint}>${icon('x-circle', { size: 12 })} Not configured</span>`;
}

function showFeedback(el: HTMLElement, msg: string, isError = false): void {
    el.textContent = msg;
    el.className = isError ? 'config-feedback error' : 'config-feedback';
    setTimeout(() => { el.textContent = ''; }, 3000);
}

/**
 * Banner shown at the top of every config tab. Explains the tab's purpose
 * and the most common gotcha so the user doesn't have to context-switch
 * to the Help guide for routine work.
 */
function tabIntro(title: string, body: string, tip?: string): HTMLElement {
    const wrap = el('div', 'config-tab-intro');
    const t = el('h3', 'config-tab-intro__title');
    t.textContent = title;
    const p = el('p', 'config-tab-intro__body');
    p.textContent = body;
    wrap.appendChild(t);
    wrap.appendChild(p);
    if (tip !== undefined) {
        const hint = el('p', 'config-tab-intro__tip');
        hint.innerHTML = `<strong>Tip:</strong> ${tip}`;
        wrap.appendChild(hint);
    }
    return wrap;
}

// ── Tab 1 — API Keys ─────────────────────────────────

function buildApiKeysTab(snapshot: ConfigSnapshot, callbacks: ConfigCallbacks): HTMLElement {
    const wrap = el('div');

    wrap.appendChild(tabIntro(
        'API keys per provider',
        'Drop one key per AI provider. Saved keys live in the OS Keychain (Windows Credential Manager / macOS Keychain / Linux libsecret) — never in plaintext on disk. Whichever key is here becomes the default for any agent on that provider.',
        'For multiple keys per provider (e.g. team key for prod, personal key for sandbox), use the Key Registry tab instead. The badge after each label shows whether the key is from Keychain, an env var, or unset — env-var keys can\'t be deleted from the UI.'
    ));

    for (const providerName of PROVIDER_ORDER) {
        const status = snapshot.providers[providerName];
        if (status === undefined) continue;

        const row = el('div', 'config-row');

        const label = el('span', 'config-label');
        label.textContent = status.label;
        row.appendChild(label);

        const badge = el('span');
        badge.innerHTML = statusBadge(status);
        row.appendChild(badge);

        const input = el('input', 'config-input') as HTMLInputElement;
        input.type = 'password';
        input.placeholder = providerName === 'ollama'
            ? 'Ollama cloud API key (ollama.com/settings/keys)'
            : 'Enter API key…';
        input.autocomplete = 'off';
        row.appendChild(input);

        const feedback = el('span', 'config-feedback');
        row.appendChild(feedback);

        const saveBtn = el('button', 'config-btn config-btn-primary');
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const key = input.value.trim();
            if (key === '') { showFeedback(feedback, 'Enter a key first', true); return; }
            saveBtn.disabled = true;
            const result = await callbacks.configSaveApiKey(providerName, key);
            saveBtn.disabled = false;
            if (result.success) {
                input.value = '';
                badge.innerHTML = statusBadge({ hasKey: true, source: 'keychain', label: status.label });
                showFeedback(feedback, 'Saved');
            } else {
                showFeedback(feedback, result.error ?? 'Failed', true);
            }
        });
        row.appendChild(saveBtn);

        // F-313: "Move to keychain" — only shown when an env var is the
        // current source OR is shadowed by keychain but still present in the
        // process. One click copies the env value into keychain so the user
        // can then safely delete it from .env / shell / system env.
        if (
            callbacks.configPromoteEnvKey !== undefined &&
            (status.source === 'env' || (status.envVarPresent === true && status.source !== 'keychain'))
        ) {
            const moveBtn = el('button', 'config-btn');
            moveBtn.textContent = 'Move to keychain';
            const envName = status.envVarName ?? '';
            moveBtn.title = envName !== ''
                ? `Copy ${envName} into the OS Keychain so you can remove the env var.`
                : 'Copy env var value into the OS Keychain.';
            moveBtn.addEventListener('click', async () => {
                if (callbacks.configPromoteEnvKey === undefined) return;
                moveBtn.disabled = true;
                const result = await callbacks.configPromoteEnvKey(providerName);
                moveBtn.disabled = false;
                if (result.success) {
                    badge.innerHTML = statusBadge({
                        ...status,
                        hasKey: true,
                        source: status.envVarPresent === true ? 'env-shadowed' : 'keychain',
                    });
                    const next = envName !== ''
                        ? `Saved. You can now remove ${envName} from your environment.`
                        : 'Saved.';
                    showFeedback(feedback, next);
                } else {
                    showFeedback(feedback, result.error ?? 'Failed', true);
                }
            });
            row.appendChild(moveBtn);
        }

        const delBtn = el('button', 'config-btn config-btn-danger');
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', async () => {
            delBtn.disabled = true;
            const result = await callbacks.configDeleteApiKey(providerName);
            delBtn.disabled = false;
            if (result.success) {
                // After delete, source goes back to env (if present + fallback enabled)
                // or 'none'. Pass full status so envVarName etc. are preserved.
                const next: ProviderStatus = {
                    ...status,
                    hasKey: status.envVarPresent === true && status.envFallbackEnabled === true,
                    source: status.envVarPresent === true && status.envFallbackEnabled === true ? 'env' : 'none',
                };
                badge.innerHTML = statusBadge(next);
                showFeedback(feedback, 'Deleted');
            } else {
                showFeedback(feedback, result.error ?? 'Failed', true);
            }
        });
        row.appendChild(delBtn);

        const testFeedback = el('span', 'config-feedback');
        row.appendChild(testFeedback);

        const testBtn = el('button', 'config-btn');
        testBtn.textContent = 'Test';
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            testBtn.textContent = '…';
            const result = await callbacks.testProvider(providerName);
            testBtn.disabled = false;
            testBtn.textContent = 'Test';
            if (result.success) {
                showFeedback(testFeedback, `OK · ${result.latencyMs ?? 0}ms`);
            } else {
                showFeedback(testFeedback, result.error ?? 'Failed', true);
            }
        });
        row.appendChild(testBtn);

        wrap.appendChild(row);
    }

    return wrap;
}

// ── Tab 2 — Key Registry ────────────────────────────

function buildKeyRegistryTab(callbacks: ConfigCallbacks): HTMLElement {
    const wrap = el('div');
    wrap.appendChild(tabIntro(
        'Multi-key vault',
        'Register multiple keys per provider, label them, scope to specific projects, mark one as default. Useful when you want different billing tiers per project — e.g. a team key for prod work and a personal key for sandbox runs. Keys here override the default key from the API Keys tab when a project is scoped to one.',
        'A scoped key only fires when a project\'s id matches the scope. Default keys (one per provider) are the fallback for everything else. If you only need one key per provider, the simpler API Keys tab is enough — you don\'t need this one.'
    ));
    const listContainer = el('div', 'config-key-list');
    const formContainer = el('div', 'config-key-form');

    // ── Add Key Form ────────────────────────────
    const formTitle = el('h4');
    formTitle.textContent = 'Add New Key';
    formTitle.style.margin = '0 0 8px 0';
    formContainer.appendChild(formTitle);

    const formRow = el('div', 'config-row');
    formRow.style.flexWrap = 'wrap';
    formRow.style.gap = '6px';

    const providerSel = el('select') as HTMLSelectElement;
    for (const opt of PROVIDER_ORDER) {
        if (opt === 'github') continue; // GitHub token managed separately
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        providerSel.appendChild(o);
    }
    formRow.appendChild(providerSel);

    const labelInput = el('input', 'config-input') as HTMLInputElement;
    labelInput.placeholder = 'Label (e.g., "work", "personal")';
    labelInput.style.width = '150px';
    formRow.appendChild(labelInput);

    const keyInput = el('input', 'config-input') as HTMLInputElement;
    keyInput.type = 'password';
    keyInput.placeholder = 'API key';
    keyInput.style.width = '200px';
    keyInput.autocomplete = 'off';
    formRow.appendChild(keyInput);

    const defaultChk = el('label');
    defaultChk.style.display = 'flex';
    defaultChk.style.alignItems = 'center';
    defaultChk.style.gap = '4px';
    defaultChk.style.fontSize = '11px';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    defaultChk.appendChild(chk);
    defaultChk.appendChild(document.createTextNode('Default'));
    formRow.appendChild(defaultChk);

    const formFeedback = el('span', 'config-feedback');

    const addBtn = el('button', 'config-btn config-btn-primary');
    addBtn.textContent = 'Add Key';
    addBtn.addEventListener('click', async () => {
        const provider = providerSel.value;
        const label = labelInput.value.trim();
        const apiKey = keyInput.value.trim();
        if (label === '') { showFeedback(formFeedback, 'Label required', true); return; }
        if (apiKey === '') { showFeedback(formFeedback, 'Key required', true); return; }
        addBtn.disabled = true;
        const result = await callbacks.addProviderKey(provider, label, apiKey, null, chk.checked);
        addBtn.disabled = false;
        if (result.success) {
            labelInput.value = '';
            keyInput.value = '';
            chk.checked = false;
            showFeedback(formFeedback, 'Added');
            void refreshKeyList();
        } else {
            showFeedback(formFeedback, result.error ?? 'Failed', true);
        }
    });
    formRow.appendChild(addBtn);
    formRow.appendChild(formFeedback);

    formContainer.appendChild(formRow);

    // ── Key List ────────────────────────────────
    async function refreshKeyList(): Promise<void> {
        listContainer.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:11px">Loading keys…</div>';
        const result = await callbacks.listProviderKeys();
        listContainer.innerHTML = '';

        if (!result.success || result.keys.length === 0) {
            const empty = el('div');
            empty.style.padding = '12px';
            empty.style.color = 'var(--text-muted)';
            empty.style.fontSize = '11px';
            empty.textContent = result.keys.length === 0
                ? 'No keys registered yet. Add your first key above.'
                : (result.error ?? 'Failed to load keys');
            listContainer.appendChild(empty);
            return;
        }

        // Group by provider
        const grouped: Record<string, ProviderKeySummary[]> = {};
        for (const key of result.keys) {
            const arr = grouped[key.provider] ?? [];
            arr.push(key);
            grouped[key.provider] = arr;
        }

        for (const [provider, keys] of Object.entries(grouped)) {
            const section = el('div', 'config-key-section');
            const header = el('div', 'config-key-section-header');
            header.textContent = `${provider} (${keys.length} key${keys.length > 1 ? 's' : ''})`;
            section.appendChild(header);

            for (const key of keys) {
                const row = el('div', 'config-key-row');

                const info = el('div', 'config-key-info');
                const labelEl = el('span', 'config-key-label');
                labelEl.textContent = key.label;
                info.appendChild(labelEl);

                if (key.isDefault) {
                    const badge = el('span', 'config-key-default-badge');
                    badge.textContent = 'default';
                    info.appendChild(badge);
                }

                const statusEl = el('span');
                statusEl.innerHTML = key.hasKey
                    ? '<span style="color:var(--success,#22c55e);font-size:10px">has key</span>'
                    : '<span style="color:var(--error,#ef4444);font-size:10px">missing</span>';
                info.appendChild(statusEl);

                if (key.projectId !== null) {
                    const scopeEl = el('span');
                    scopeEl.style.fontSize = '10px';
                    scopeEl.style.color = 'var(--text-muted)';
                    scopeEl.textContent = `project: ${key.projectId.slice(0, 8)}…`;
                    info.appendChild(scopeEl);
                }

                row.appendChild(info);

                const actions = el('div', 'config-key-actions');

                if (!key.isDefault) {
                    const setDefaultBtn = el('button', 'config-btn');
                    setDefaultBtn.textContent = 'Set Default';
                    setDefaultBtn.style.fontSize = '10px';
                    setDefaultBtn.style.padding = '2px 6px';
                    setDefaultBtn.addEventListener('click', async () => {
                        setDefaultBtn.disabled = true;
                        await callbacks.updateProviderKey(key.id, { isDefault: true });
                        setDefaultBtn.disabled = false;
                        void refreshKeyList();
                    });
                    actions.appendChild(setDefaultBtn);
                }

                const delBtn = el('button', 'config-btn config-btn-danger');
                delBtn.textContent = 'Delete';
                delBtn.style.fontSize = '10px';
                delBtn.style.padding = '2px 6px';
                delBtn.addEventListener('click', async () => {
                    delBtn.disabled = true;
                    await callbacks.deleteProviderKey(key.id);
                    delBtn.disabled = false;
                    void refreshKeyList();
                });
                actions.appendChild(delBtn);

                row.appendChild(actions);
                section.appendChild(row);
            }

            listContainer.appendChild(section);
        }
    }

    wrap.appendChild(formContainer);
    wrap.appendChild(listContainer);

    // Load initial list
    void refreshKeyList();

    return wrap;
}

// ── Tab 3 — Agent Providers ──────────────────────────

function buildAgentProvidersTab(snapshot: ConfigSnapshot, callbacks: ConfigCallbacks): HTMLElement {
    const wrap = el('div');
    wrap.appendChild(tabIntro(
        'Per-agent model overrides',
        'Pin a specific model + provider for a single agent. This supersedes whatever the active preset has configured for that one agent — useful for "I want Opus only for Pixel, not for the rest of the team" or "Vigil should run on Haiku to save cost". The rest of the team continues to follow the preset.',
        'Override only the agents you have a strong opinion on. If most of your team should follow the preset, leave most rows alone. The change applies on the next task pickup, not the next process boot.'
    ));

    const table = el('table', 'config-agent-table') as HTMLTableElement;
    const thead = table.createTHead();
    const hrow = thead.insertRow();
    ['Agent', 'Provider', 'Model', ''].forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        hrow.appendChild(th);
    });

    const tbody = table.createTBody();

    for (const agentName of AGENT_NAMES) {
        const entry = snapshot.agents[agentName];
        if (entry === undefined) continue;

        const row = tbody.insertRow();

        const nameCell = row.insertCell();
        nameCell.textContent = agentName;

        const providerCell = row.insertCell();
        const providerSel = el('select') as HTMLSelectElement;
        for (const opt of AGENT_PROVIDER_OPTIONS) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            if (opt === entry.provider) o.selected = true;
            providerSel.appendChild(o);
        }
        providerCell.appendChild(providerSel);

        const modelCell = row.insertCell();
        const modelInput = el('input') as HTMLInputElement;
        modelInput.type = 'text';
        modelInput.value = entry.model;
        modelInput.placeholder = 'model name';
        modelCell.appendChild(modelInput);

        const actionCell = row.insertCell();
        const feedback = el('span', 'config-feedback');
        feedback.style.marginRight = '6px';

        const saveBtn = el('button', 'config-btn config-btn-primary');
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const provider = providerSel.value;
            const model = modelInput.value.trim();
            if (model === '') { showFeedback(feedback, 'Enter model', true); return; }
            saveBtn.disabled = true;
            const result = await callbacks.setAgentProvider(agentName, provider, model);
            saveBtn.disabled = false;
            showFeedback(feedback, result.success ? 'Saved' : (result.error ?? 'Failed'), !result.success);
        });

        actionCell.appendChild(feedback);
        actionCell.appendChild(saveBtn);
    }

    wrap.appendChild(table);
    return wrap;
}

// ── Tab 3 — Environment ──────────────────────────────

const ENV_GROUPS: ReadonlyArray<{
    readonly title: string;
    readonly subtitle: string;
    readonly keys: readonly string[];
}> = [
    {
        title: 'Core paths + DB',
        subtitle: 'Where KageOps stores work, runtime data, and how concurrent it runs.',
        keys: ['KAGEOPS_PROJECTS_DIR', 'KAGEOPS_DATA_DIR', 'KAGEOPS_MAX_CONCURRENCY', 'DATABASE_URL'],
    },
    {
        title: 'Cost guardrails',
        subtitle: 'Hard caps that prevent runaway spend. Always set KAGEOPS_MAX_RUN_USD before live runs.',
        keys: ['KAGEOPS_MAX_RUN_USD', 'KAGEOPS_MAX_AI_CALLS_PER_TASK', 'KAGEOPS_HEADLESS_TIMEOUT_MS', 'KAGEOPS_ZOMBIE_TIMEOUT_MS'],
    },
    {
        title: 'Routing — preset + design provider',
        subtitle: 'Pin a model preset or override the design provider for this run. See "Setting precedence" in the About tab.',
        keys: [
            'KAGEOPS_PRESET',
            'KAGEOPS_DESIGN_PROVIDER',
            'KAGEOPS_CLAUDE_UI_MODEL',
            'KAGEOPS_CLAUDE_UI_MAX_TOKENS',
            'KAGEOPS_OPENAI_UI_MODEL',
            'KAGEOPS_OPENAI_UI_MAX_TOKENS',
        ],
    },
    {
        title: 'Behavior toggles',
        subtitle: 'Opt-in flags for benchmark / test / dry-run modes.',
        keys: ['KAGEOPS_DISABLE_GIT', 'KAGEOPS_DRY_RUN', 'KAGEOPS_DB_MODE', 'KAGEOPS_SKILLS_HOOKS'],
    },
    {
        title: 'APO — Automatic Prompt Optimization',
        subtitle: 'Opt-in nightly loop that proposes prompt mutations for scout/herald/pixel. Off by default. Proposals require human approval before applying.',
        keys: ['KAGEOPS_APO_ENABLED', 'KAGEOPS_APO_EVAL_MODEL', 'KAGEOPS_APO_MUTATOR_MODEL', 'KAGEOPS_APO_MIN_DELTA'],
    },
];

function buildEnvTab(snapshot: ConfigSnapshot, callbacks: ConfigCallbacks): HTMLElement {
    const wrap = el('div');
    wrap.appendChild(tabIntro(
        'Runtime environment variables',
        'Paths, cost caps, routing toggles, APO settings, behaviour flags. These take precedence over UI selections — env wins everywhere. Edits here write to the persisted env config and apply on the next process boot (Electron restart for the app, next subprocess for headless).',
        'For day-to-day use, only KAGEOPS_MAX_RUN_USD (cost cap) and KAGEOPS_PRESET (model bundle) really matter. Everything else has sensible defaults. See the Help guide → Environment vars for the full precedence table.'
    ));

    // ── Search bar ───────────────────────────────────
    const searchWrap = el('div', 'config-env-search-wrap');
    const searchInput = el('input', 'config-env-search') as HTMLInputElement;
    searchInput.type = 'search';
    searchInput.placeholder = 'Filter variables…';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchWrap.appendChild(searchInput);
    wrap.appendChild(searchWrap);

    // ── Build groups with wrapper divs for filter visibility ──
    type GroupEntry = { readonly wrapper: HTMLElement; readonly rows: ReadonlyArray<{ readonly el: HTMLElement; readonly searchText: string }> };
    const groupEntries: GroupEntry[] = [];

    const noResults = el('div', 'config-env-no-results');
    noResults.textContent = 'No variables match your search.';
    noResults.style.display = 'none';

    for (const group of ENV_GROUPS) {
        const groupWrapper = el('div', 'config-env-group');

        const groupHeader = el('div', 'config-env-group-header');
        const titleEl = el('div', 'config-env-group-title');
        titleEl.textContent = group.title;
        groupHeader.appendChild(titleEl);
        const subtitleEl = el('div', 'config-env-group-subtitle');
        subtitleEl.textContent = group.subtitle;
        groupHeader.appendChild(subtitleEl);
        groupWrapper.appendChild(groupHeader);

        const rowEntries: Array<{ readonly el: HTMLElement; readonly searchText: string }> = [];
        for (const key of group.keys) {
            const rowEl = buildEnvRow(key, snapshot, callbacks);
            const desc = ENV_VAR_DESCRIPTIONS[key] ?? '';
            rowEntries.push({ el: rowEl, searchText: `${key} ${desc}`.toLowerCase() });
            groupWrapper.appendChild(rowEl);
        }

        groupEntries.push({ wrapper: groupWrapper, rows: rowEntries });
        wrap.appendChild(groupWrapper);
    }

    wrap.appendChild(noResults);

    // ── Filter logic ─────────────────────────────────
    searchInput.addEventListener('input', () => {
        const term = searchInput.value.trim().toLowerCase();
        let anyVisible = false;

        for (const group of groupEntries) {
            let groupHasMatch = false;
            for (const row of group.rows) {
                const matches = term === '' || row.searchText.includes(term);
                row.el.style.display = matches ? '' : 'none';
                if (matches) groupHasMatch = true;
            }
            group.wrapper.style.display = groupHasMatch ? '' : 'none';
            if (groupHasMatch) anyVisible = true;
        }

        noResults.style.display = anyVisible || term === '' ? 'none' : '';
    });

    return wrap;
}

function buildEnvRow(
    key: string,
    snapshot: ConfigSnapshot,
    callbacks: ConfigCallbacks,
): HTMLElement {
    const current = snapshot.envVars[key] ?? '';
    const desc = ENV_VAR_DESCRIPTIONS[key] ?? '';

    const row = el('div', 'config-env-row');

    const labelWrap = el('div');
    const labelEl = el('div', 'config-env-label');
    labelEl.textContent = key;
    // Wave 6 tooltips: hover the env-var name to read the full description.
    // Useful when descriptions wrap or are clipped.
    labelEl.title = desc;
    labelWrap.appendChild(labelEl);
    const descEl = el('div', 'config-env-desc');
    descEl.textContent = desc;
    labelWrap.appendChild(descEl);
    row.appendChild(labelWrap);

    const suggestions = ENV_VAR_SUGGESTIONS[key];
    let input: HTMLInputElement;

    if (suggestions !== undefined && suggestions.length > 0) {
        const { wrap: comboWrap, input: comboInput } = buildSuggestCombobox(current, suggestions);
        row.appendChild(comboWrap);
        input = comboInput;
    } else {
        input = el('input', 'config-input') as HTMLInputElement;
        input.type = 'text';
        input.value = current;
        input.placeholder = 'Not set';
        row.appendChild(input);
    }

    const btnWrap = el('div', 'config-row');
    btnWrap.style.flexDirection = 'column';
    btnWrap.style.gap = '2px';
    btnWrap.style.border = 'none';
    btnWrap.style.padding = '0';

    const feedback = el('span', 'config-feedback');
    const saveBtn = el('button', 'config-btn config-btn-primary');
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
        const value = input.value.trim();
        saveBtn.disabled = true;
        const result = await callbacks.saveEnvVar(key, value);
        saveBtn.disabled = false;
        showFeedback(feedback, result.success ? 'Saved' : (result.error ?? 'Failed'), !result.success);
    });

    btnWrap.appendChild(saveBtn);
    btnWrap.appendChild(feedback);
    row.appendChild(btnWrap);

    return row;
}

// ── Custom suggest combobox ──────────────────────────
// Replaces native <datalist> (uncontrollable CSS) with a fully-styled
// dropdown: text input + chevron + absolute suggestion list.

function buildSuggestCombobox(
    initialValue: string,
    suggestions: ReadonlyArray<{ readonly value: string; readonly label: string }>,
): { readonly wrap: HTMLElement; readonly input: HTMLInputElement } {
    const wrap = el('div', 'env-combobox');

    const input = el('input', 'config-input env-combobox__input') as HTMLInputElement;
    input.type = 'text';
    input.value = initialValue;
    input.placeholder = 'Not set';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const chevron = el('button', 'env-combobox__chevron');
    chevron.type = 'button';
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

    const list = el('div', 'env-combobox__list');
    list.setAttribute('role', 'listbox');
    list.style.display = 'none';

    function buildItems(filter: string): void {
        list.innerHTML = '';
        const term = filter.trim().toLowerCase();
        const filtered = term === ''
            ? suggestions
            : suggestions.filter((s) =>
                s.value.toLowerCase().includes(term) || s.label.toLowerCase().includes(term)
            );

        if (filtered.length === 0) {
            const empty = el('div', 'env-combobox__empty');
            empty.textContent = 'No matches';
            list.appendChild(empty);
            return;
        }

        for (const s of filtered) {
            const item = el('div', 'env-combobox__item');
            item.setAttribute('role', 'option');
            const valEl = el('span', 'env-combobox__item-val');
            valEl.textContent = s.value;
            const lblEl = el('span', 'env-combobox__item-lbl');
            lblEl.textContent = s.label;
            item.appendChild(valEl);
            item.appendChild(lblEl);
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // keep focus on input
                input.value = s.value;
                closeList();
            });
            list.appendChild(item);
        }
    }

    function openList(): void {
        buildItems(input.value);
        list.style.display = '';
        chevron.classList.add('env-combobox__chevron--open');
    }

    function closeList(): void {
        list.style.display = 'none';
        chevron.classList.remove('env-combobox__chevron--open');
    }

    input.addEventListener('focus', () => openList());
    input.addEventListener('input', () => { buildItems(input.value); list.style.display = ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeList(); });
    input.addEventListener('blur', () => { setTimeout(() => closeList(), 120); });
    chevron.addEventListener('mousedown', (e) => {
        e.preventDefault();
        list.style.display === 'none' ? openList() : closeList();
    });

    wrap.appendChild(input);
    wrap.appendChild(chevron);
    wrap.appendChild(list);

    return { wrap, input };
}

// ── Updates section (F-322) ─────────────────────────
//
// Lives inside the About tab. Renders a single "Auto-update" toggle (default
// ON), a "Check for updates now" button (works even when the toggle is off),
// and a "Last checked" timestamp. Wired to the renderer-side `kageOps.*`
// bridge — actual auto-updater is gated in src/main/auto-updater.ts on
// settings.autoUpdateEnabled.

interface UpdateStatus {
    readonly autoUpdateEnabled: boolean;
    readonly lastUpdateCheckAt: string | null;
    readonly currentVersion: string;
    readonly packaged: boolean;
    readonly channel: string;
    // F-395: surfaced so the UI can show *which* lever resolved the channel
    // (env / settings / embedded / default) and the embedded baseline.
    readonly channelSource?: 'env' | 'settings' | 'embedded' | 'default' | 'dev-fallback';
    readonly channelEmbedded?: string | null;
    readonly channelSetting?: 'latest' | 'beta' | null;
}

interface UpdatesBridge {
    getUpdateStatus(): Promise<UpdateStatus>;
    setAutoUpdateEnabled(enabled: boolean): Promise<{ success: boolean; autoUpdateEnabled?: boolean; error?: string }>;
    checkForUpdatesNow(): Promise<{ available: boolean; version?: string; error?: string; checkedAt?: string }>;
    // F-395 — optional (older preloads won't have it). Picker hides if missing.
    setReleaseChannel?(channel: 'latest' | 'beta' | null): Promise<{
        success: boolean;
        channel?: 'latest' | 'beta';
        version?: string;
        available?: boolean;
        error?: string;
    }>;
}

function getUpdatesBridge(): UpdatesBridge | null {
    const w = window as unknown as { kageOps?: Partial<UpdatesBridge> };
    if (
        typeof w.kageOps?.getUpdateStatus === 'function' &&
        typeof w.kageOps?.setAutoUpdateEnabled === 'function' &&
        typeof w.kageOps?.checkForUpdatesNow === 'function'
    ) {
        return w.kageOps as UpdatesBridge;
    }
    return null;
}

function formatRelative(iso: string | null): string {
    if (iso === null || iso === '') return 'never';
    try {
        const then = new Date(iso).getTime();
        const ago = Date.now() - then;
        if (!Number.isFinite(ago) || ago < 0) return 'just now';
        const min = Math.floor(ago / 60_000);
        if (min < 1) return 'just now';
        if (min < 60) return `${min} min ago`;
        const h = Math.floor(min / 60);
        if (h < 24) return `${h} h ago`;
        const d = Math.floor(h / 24);
        return `${d} day${d === 1 ? '' : 's'} ago`;
    } catch {
        return 'unknown';
    }
}

function buildUpdatesSection(): HTMLElement {
    const wrap = el('div');
    wrap.style.cssText = 'margin: 0 0 20px; padding: 16px 18px; background: var(--bg-secondary, rgba(255,255,255,0.02)); border: 1px solid var(--border-subtle, rgba(255,255,255,0.06)); border-radius: 8px;';

    const heading = el('div');
    heading.style.cssText = 'font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--text-primary)';
    heading.textContent = 'Updates';
    wrap.appendChild(heading);

    const lede = el('p');
    lede.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin: 0 0 12px; line-height: 1.55;';
    lede.textContent = 'KageOps checks for updates on launch and every 4 hours, then prompts you when one is ready. Untick to manage updates yourself — the "Check now" button still works either way.';
    wrap.appendChild(lede);

    // Toggle row
    const toggleRow = el('label');
    toggleRow.style.cssText = 'display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; user-select: none; padding: 8px 0; color: var(--text-primary)';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.style.cssText = 'width: 16px; height: 16px; accent-color: var(--accent, #5BB377); cursor: pointer; margin: 0;';
    toggle.disabled = true;  // enabled after first status load
    const toggleLabel = el('span');
    toggleLabel.textContent = 'Automatically install updates';
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(toggleLabel);
    wrap.appendChild(toggleRow);

    // Meta row — version, channel, last checked
    const metaRow = el('div');
    metaRow.style.cssText = 'display: flex; gap: 18px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-muted); padding: 4px 0 12px; font-family: var(--font-mono, "JetBrains Mono", monospace);';
    const versionSpan = el('span');
    versionSpan.textContent = 'Version: …';
    const channelSpan = el('span');
    channelSpan.textContent = 'Channel: …';
    const lastSpan = el('span');
    lastSpan.textContent = 'Last checked: …';
    metaRow.appendChild(versionSpan);
    metaRow.appendChild(channelSpan);
    metaRow.appendChild(lastSpan);
    wrap.appendChild(metaRow);

    // F-395: Release channel picker. Tri-state — Auto (follow embedded
    // app-update.yml channel) / latest / beta. Persists via
    // updates:set-channel IPC + repoints the live autoUpdater + triggers
    // an immediate check so the operator sees feedback within seconds.
    const channelRow = el('div');
    channelRow.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 0; font-size: 12.5px; flex-wrap: wrap;';
    const channelRowLabel = el('span');
    channelRowLabel.textContent = 'Release channel:';
    channelRowLabel.style.cssText = 'color: var(--text-secondary); margin-right: 4px;';
    channelRow.appendChild(channelRowLabel);

    const channelSelect = document.createElement('select');
    channelSelect.style.cssText = 'background: var(--bg-primary, #0b0d12); color: var(--text-primary); border: 1px solid var(--border-subtle, rgba(255,255,255,0.12)); border-radius: 4px; padding: 4px 8px; font-size: 12.5px; font-family: inherit;';
    channelSelect.disabled = true;
    const optAuto = document.createElement('option');
    optAuto.value = 'auto';
    optAuto.textContent = 'Auto (installer default)';
    const optLatest = document.createElement('option');
    optLatest.value = 'latest';
    optLatest.textContent = 'Latest (stable)';
    const optBeta = document.createElement('option');
    optBeta.value = 'beta';
    optBeta.textContent = 'Beta (pre-release)';
    channelSelect.appendChild(optAuto);
    channelSelect.appendChild(optLatest);
    channelSelect.appendChild(optBeta);
    channelRow.appendChild(channelSelect);

    const channelHint = el('span');
    channelHint.style.cssText = 'color: var(--text-muted); font-size: 11.5px; font-family: var(--font-mono, "JetBrains Mono", monospace);';
    channelHint.textContent = '';
    channelRow.appendChild(channelHint);
    wrap.appendChild(channelRow);

    // Actions row — check-now button + feedback
    const actionsRow = el('div');
    actionsRow.style.cssText = 'display: flex; align-items: center; gap: 12px; flex-wrap: wrap;';
    const checkBtn = el('button', 'config-btn');
    checkBtn.textContent = 'Check for updates now';
    checkBtn.disabled = true;
    actionsRow.appendChild(checkBtn);
    const feedback = el('span', 'config-feedback');
    actionsRow.appendChild(feedback);
    wrap.appendChild(actionsRow);

    const bridge = getUpdatesBridge();
    if (bridge === null) {
        // Bridge missing — older renderer / preload. Surface visibly so we
        // don't silently no-op.
        toggleLabel.textContent = 'Automatically install updates (bridge unavailable)';
        return wrap;
    }

    const applyStatus = (status: UpdateStatus): void => {
        toggle.checked = status.autoUpdateEnabled !== false;
        toggle.disabled = false;
        versionSpan.textContent = `Version: ${status.currentVersion}`;
        const sourceSuffix = status.channelSource !== undefined && status.channelSource !== 'default'
            ? ` (${status.channelSource})`
            : '';
        channelSpan.textContent = `Channel: ${status.channel}${sourceSuffix}`;
        lastSpan.textContent = `Last checked: ${formatRelative(status.lastUpdateCheckAt)}`;

        // F-395: seed the channel select from the persisted setting.
        // `null` setting (or unset) → "Auto" so the picker reflects the
        // fall-through to embedded / default.
        if (typeof bridge.setReleaseChannel === 'function') {
            const setting = status.channelSetting ?? null;
            channelSelect.value = setting === null ? 'auto' : setting;
            channelSelect.disabled = !status.packaged;
            const embedded = status.channelEmbedded ?? null;
            channelHint.textContent = embedded !== null
                ? `installer baseline: ${embedded}`
                : status.channelSource === 'env'
                    ? `env: KAGEOPS_RELEASE_CHANNEL`
                    : '';
            if (!status.packaged) {
                channelHint.textContent = 'installed builds only';
            }
        } else {
            // Older preload — hide the picker entirely.
            channelRow.style.display = 'none';
        }

        if (!status.packaged) {
            toggle.disabled = true;
            toggleLabel.textContent = 'Automatically install updates (dev mode — auto-update disabled in source builds)';
            checkBtn.disabled = true;
            checkBtn.title = 'Available in installed builds only';
        } else {
            checkBtn.disabled = false;
        }
    };

    void bridge.getUpdateStatus().then(applyStatus).catch(() => {
        // Status read failed — leave defaults visible
        toggle.disabled = false;
        toggle.checked = true;
    });

    // F-395: channel change handler — persist + re-check + show result.
    channelSelect.addEventListener('change', async () => {
        if (typeof bridge.setReleaseChannel !== 'function') return;
        channelSelect.disabled = true;
        const target: 'latest' | 'beta' | null =
            channelSelect.value === 'auto' ? null
            : channelSelect.value === 'beta' ? 'beta'
            : 'latest';
        showFeedback(feedback, `Switching to ${channelSelect.value}…`);
        try {
            const result = await bridge.setReleaseChannel(target);
            if (result.success === true) {
                const msg = result.available === true
                    ? `Channel set · update available: ${result.version ?? '?'}`
                    : `Channel set to ${result.channel ?? channelSelect.value} · up to date`;
                showFeedback(feedback, msg);
                // Refresh the meta line so Channel: <foo> (<source>) reflects the change.
                try { applyStatus(await bridge.getUpdateStatus()); } catch { /* */ }
            } else {
                showFeedback(feedback, result.error ?? 'Failed to switch channel', true);
            }
        } catch (err) {
            showFeedback(feedback, err instanceof Error ? err.message : String(err), true);
        } finally {
            channelSelect.disabled = false;
        }
    });

    toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        const result = await bridge.setAutoUpdateEnabled(toggle.checked);
        toggle.disabled = false;
        if (result.success === true) {
            const next = result.autoUpdateEnabled !== false;
            toggle.checked = next;
            showFeedback(feedback, next ? 'Auto-update on' : 'Auto-update off');
        } else {
            // Revert + surface error
            toggle.checked = !toggle.checked;
            showFeedback(feedback, result.error ?? 'Failed to save', true);
        }
    });

    checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        const original = checkBtn.textContent;
        checkBtn.textContent = 'Checking…';
        const result = await bridge.checkForUpdatesNow();
        checkBtn.textContent = original;
        checkBtn.disabled = false;
        if (result.checkedAt !== undefined) {
            lastSpan.textContent = `Last checked: ${formatRelative(result.checkedAt)}`;
        }
        if (result.error !== undefined && result.error !== '') {
            showFeedback(feedback, result.error, true);
        } else if (result.available === true && result.version !== undefined) {
            showFeedback(feedback, `Update available: v${result.version}`);
        } else {
            showFeedback(feedback, 'You\'re up to date');
        }
    });

    return wrap;
}

// ── Tab 4 — About ────────────────────────────────────

function buildAboutTab(snapshot: ConfigSnapshot): HTMLElement {
    const wrap = el('div');
    wrap.appendChild(tabIntro(
        'System status & precedence reference',
        'Read this when you\'re unsure how preset / per-agent override / design provider interact. Also shows the resolved values for paths, database, concurrency — useful when checking whether your env vars actually took effect.',
        'If a setting "isn\'t taking effect", it\'s almost always because a higher-precedence layer is overriding it. The precedence chain (highest first): Environment variable → Per-data-dir config file → UI dropdown → Hard-coded default.'
    ));

    // F-322 / decision #76 — auto-update opt-out toggle + manual check.
    // Section sits at the top of About so it's visible without scrolling.
    wrap.appendChild(buildUpdatesSection());

    const dbUrl = snapshot.envVars['DATABASE_URL'];
    const maskedDb = dbUrl !== null && dbUrl !== undefined && dbUrl !== ''
        ? dbUrl.replace(/:\/\/[^@]+@/, '://***@')
        : '(not set)';

    const rows: Array<[string, string]> = [
        ['Version', 'KageOps v1.1'],
        ['Platform', 'Electron (TypeScript)'],
        ['Data Dir', snapshot.envVars['KAGEOPS_DATA_DIR'] ?? '~/.kageops (default)'],
        ['Database', maskedDb],
        ['Projects Dir', snapshot.envVars['KAGEOPS_PROJECTS_DIR'] ?? '(not set)'],
        ['Max Concurrency', snapshot.envVars['KAGEOPS_MAX_CONCURRENCY'] ?? '3 (default)'],
        ['Agent Roster', 'Scout · Blueprint · Forge · Vigil · Aegis · Pixel · Cipher · Herald'],
        ['Orchestrator', 'Sensei'],
    ];

    for (const [label, value] of rows) {
        const row = el('div', 'config-row');
        const lbl = el('span', 'config-label');
        lbl.textContent = label;
        row.appendChild(lbl);
        const val = el('span');
        val.style.fontSize = '12px';
        val.style.fontFamily = 'var(--font-mono, monospace)';
        val.textContent = value;
        row.appendChild(val);
        wrap.appendChild(row);
    }

    // ── Setting precedence reference ─────────────────────
    // The single most-asked question from this product is "when I
    // change X, does it override Y?". Inline reference so users
    // don't have to leave the panel to find out.
    const precedenceHeader = el('div');
    precedenceHeader.style.cssText = 'margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.06)); font-weight: 600; font-size: 13px; margin-bottom: 8px;';
    precedenceHeader.textContent = 'Setting precedence — what overrides what?';
    wrap.appendChild(precedenceHeader);

    const precedenceBox = el('div');
    precedenceBox.style.cssText = 'font-size: 12px; line-height: 1.6; color: var(--text-secondary); max-width: 880px;';
    precedenceBox.innerHTML = `
        <p style="margin:0 0 10px"><strong>For an agent's effective model + provider, KageOps composes 3 layers (highest wins):</strong></p>
        <ol style="margin:0 0 14px 18px; padding:0">
            <li><strong>Per-agent override</strong> (Agent Providers tab) — sets <code>{model, provider}</code> for one agent. Overrides everything below for that agent only.</li>
            <li><strong>Active preset</strong> (Settings → Model Routing) — sets defaults for all 9 agents. Persisted to <code>active-preset.txt</code>; overridable via <code>KAGEOPS_PRESET</code>.</li>
            <li><strong>Built-in default</strong> — falls back to claude-cli/sonnet if nothing is configured.</li>
        </ol>
        <p style="margin:0 0 10px"><strong>Design provider sits beside this stack — it doesn't compose.</strong> When set to anything other than <code>in-house</code>, it ROUTES Pixel's <code>ui-build</code> task ONLY (not other Pixel tasks, not other agents) through a pinned provider with its own production-UI system prompt. Examples:</p>
        <ul style="margin:0 0 14px 18px; padding:0">
            <li><code>in-house</code> — Pixel's ui-build uses whatever model the preset assigns to Pixel. Default.</li>
            <li><code>claude-ui</code> — Pixel's ui-build pinned to Claude Opus 4.7 on subscription, regardless of preset. Other Pixel tasks (research/spec) still use the preset model. Override model via <code>KAGEOPS_CLAUDE_UI_MODEL</code>.</li>
            <li><code>openai-ui</code> — Pixel's ui-build pinned to GPT-5.4 (default) via direct OpenAI API. Best for dense visual layouts and Tailwind/Material idioms. Requires <code>OPENAI_API_KEY</code>. Override model via <code>KAGEOPS_OPENAI_UI_MODEL</code> (e.g. <code>openai/gpt-5.5</code>, <code>openai/gpt-5.3</code>, <code>openai/gpt-4o</code>).</li>
            <li><code>v0</code> — routed through Vercel v0 API (requires <code>V0_API_KEY</code>).</li>
        </ul>
        <p style="margin:0 0 10px"><strong>Model-string prefixes — what does <code>claude-cli/</code> vs <code>claude/</code> mean?</strong></p>
        <ul style="margin:0 0 14px 18px; padding:0">
            <li><code>claude-cli/&lt;model&gt;</code> — routes through the local <code>claude</code> CLI subprocess. Uses your Claude.ai subscription. <strong>$0 per call</strong>. Slower (subprocess + CLI overhead).</li>
            <li><code>claude/&lt;model&gt;</code> — direct Anthropic API. <strong>Paid per-token</strong>. Fast.</li>
            <li><code>openrouter/&lt;vendor&gt;/&lt;model&gt;</code> — OpenRouter API. Paid. Lets you use any vendor (Anthropic / OpenAI / Google / DeepSeek) with one key.</li>
            <li><code>ollama/&lt;model&gt;</code> — local Ollama daemon. $0, requires the model pulled locally.</li>
            <li><code>gemini/&lt;model&gt;</code>, <code>openai/&lt;model&gt;</code> — direct vendor APIs. Paid.</li>
        </ul>
        <p style="margin:0 0 10px"><strong>So <code>claude-cli/claude-sonnet-4-6</code> and <code>claude/claude-sonnet-4-6</code> are NOT the same:</strong> first is subscription (free, slow), second is API (paid, fast). The provider prefix is what determines the route.</p>
        <p style="margin:0 0 0; color: var(--text-muted); font-size: 11px">
            Want a deeper read? See <code>docs/architecture/architecture.md</code> §3 (model routing) and decision register #49 (ClaudeUiProvider).
        </p>
    `;
    wrap.appendChild(precedenceBox);

    return wrap;
}

// ── Main Entry ───────────────────────────────────────

export function renderConfigPanel(container: HTMLElement, callbacks: ConfigCallbacks): void {
    container.innerHTML = '<div class="config-tab-content active" style="text-align:center;padding:24px;color:var(--text-muted)">Loading…</div>';

    void callbacks.getConfigSnapshot().then((rawSnapshot) => {
        const snapshot = rawSnapshot as ConfigSnapshot;

        container.innerHTML = '';

        // ── Tab Bar ──────────────────────────
        const tabBar = el('div', 'config-tabs');
        const tabContents: HTMLElement[] = [];

        // Wave 6 tooltips — every tab gets a `title=` so users can
        // hover-reveal what each one does without opening it first.
        // Descriptions are intentionally short (one sentence) — the
        // tooltip is a hint, not a manual.
        const TABS: ReadonlyArray<{
            readonly id: string;
            readonly label: string;
            readonly iconName: Parameters<typeof icon>[0];
            readonly tooltip: string;
        }> = [
            {
                id: 'api-keys',
                label: 'API Keys',
                iconName: 'key',
                tooltip: 'Active API keys for each provider (Claude, OpenRouter, OpenAI, Gemini, Ollama, GitHub). Stored in OS Keychain. One key per provider — used as the default for any agent on that provider.',
            },
            {
                id: 'key-registry',
                label: 'Key Registry',
                iconName: 'folder',
                tooltip: 'Multi-key vault: register multiple keys per provider, label them, scope to specific projects, mark one as default. Use when you want different billing tiers per project (e.g. team key for prod, personal key for sandbox).',
            },
            {
                id: 'environment',
                label: 'Environment',
                iconName: 'terminal',
                tooltip: 'Runtime env vars — paths, cost caps, routing toggles, APO settings, behavior flags. Each row has a description on hover.',
            },
            {
                id: 'about',
                label: 'About',
                iconName: 'info',
                tooltip: 'Versions, system status, setting-precedence reference. Read this if you\'re unsure how preset / agent override / design provider interact.',
            },
        ];

        TABS.forEach(({ id, label, iconName, tooltip }, i) => {
            const btn = el('button', i === 0 ? 'config-tab active' : 'config-tab');
            btn.innerHTML = `${icon(iconName, { size: 14 })} ${label}`;
            btn.dataset['tab'] = id;
            btn.title = tooltip;
            tabBar.appendChild(btn);

            const content = el('div', i === 0 ? 'config-tab-content active' : 'config-tab-content');
            content.dataset['tab'] = id;
            tabContents.push(content);
        });

        tabBar.addEventListener('click', (e) => {
            const target = (e.target as HTMLElement).closest('.config-tab') as HTMLElement | null;
            if (target === null) return;
            const tabId = target.dataset['tab'];
            tabBar.querySelectorAll('.config-tab').forEach((b) => b.classList.remove('active'));
            target.classList.add('active');
            tabContents.forEach((c) => {
                c.classList.toggle('active', c.dataset['tab'] === tabId);
            });
        });

        container.appendChild(tabBar);

        // ── Populate Tab Contents ─────────────
        tabContents[0]?.appendChild(buildApiKeysTab(snapshot, callbacks));
        tabContents[1]?.appendChild(buildKeyRegistryTab(callbacks));
        tabContents[2]?.appendChild(buildEnvTab(snapshot, callbacks));
        tabContents[3]?.appendChild(buildAboutTab(snapshot));

        tabContents.forEach((c) => container.appendChild(c));
    }).catch(() => {
        container.innerHTML = '<div class="config-tab-content active" style="color:var(--error);padding:16px">Failed to load configuration.</div>';
    });
}
