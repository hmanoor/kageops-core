/**
 * KageOps Application Config Store
 *
 * Loads and saves application-level agent model configuration to
 * ~/.kageops/agent-config.json. Uses the home directory (not Electron's
 * userData) so the config is accessible in headless / CLI mode too.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../shared/logger';

const log = createLogger('AppConfigStore');

// ── Types ────────────────────────────────────────────

export interface AgentModelEntry {
    readonly model: string;
    readonly provider: string;
    readonly fallbackModels: readonly string[];
}

export interface AppAgentConfig {
    readonly agents: Record<string, AgentModelEntry>;
}

// ── Constants ────────────────────────────────────────

const AGENT_NAMES = [
    'sensei',
    'scout',
    'blueprint',
    'forge',
    'vigil',
    'aegis',
    'pixel',
    'cipher',
    'herald',
] as const;

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_FALLBACKS: readonly string[] = ['openai/gpt-4o', 'ollama/llama3.2'];

const DEFAULT_AGENT_ENTRY: AgentModelEntry = {
    model: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    fallbackModels: [...DEFAULT_FALLBACKS],
};

function buildDefaultConfig(): AppAgentConfig {
    const agents: Record<string, AgentModelEntry> = {};
    for (const name of AGENT_NAMES) {
        agents[name] = DEFAULT_AGENT_ENTRY;
    }
    return { agents };
}

const DEFAULT_CONFIG: AppAgentConfig = buildDefaultConfig();

// ── File Path ────────────────────────────────────────

/**
 * Data directory. Defaults to ~/.kageops; override with KAGEOPS_DATA_DIR
 * (e.g. to co-locate config with a playground .env).
 */
function getDataDir(): string {
    return process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');
}

function getConfigPath(): string {
    return path.join(getDataDir(), 'agent-config.json');
}

/**
 * Resolve the agent-config path the orchestrator actually loads.
 * Mirrors src/agents/agent-config.ts → getGlobalConfigPath():
 *   KAGEOPS_PRESET env → active-preset.txt → agent-config.json.
 *
 * Without this, the Command Center IPC reads the stale legacy file
 * while the running agents read the preset file — producing the
 * provider/model mismatches users see in the "Models in use" header.
 */
function resolveActiveConfigPath(): string {
    const dataDir = getDataDir();

    let preset: string | undefined = process.env['KAGEOPS_PRESET'];
    if (preset === undefined || preset === '') {
        const activePresetFile = path.join(dataDir, 'active-preset.txt');
        if (fs.existsSync(activePresetFile)) {
            try {
                preset = fs.readFileSync(activePresetFile, 'utf-8').trim();
            } catch { /* ignore */ }
        }
    }

    if (preset !== undefined && preset !== '') {
        const presetPath = path.join(dataDir, `agent-config.${preset}.json`);
        if (fs.existsSync(presetPath)) {
            return presetPath;
        }
    }

    return getConfigPath();
}

function getActivePresetPath(): string {
    return path.join(getDataDir(), 'active-preset.txt');
}

/** Built-in preset names. "standard" = current Sonnet-default config. */
export const PRESET_NAMES = ['claude-cli', 'claude-cli-premium', 'codex-cli', 'ollama', 'openrouter_budget', 'openrouter_standard'] as const;
export type PresetName = typeof PRESET_NAMES[number];

/**
 * Presets whose integration is paused. The template / config-file
 * machinery still works (so KAGEOPS_PRESET=codex-cli is honoured as a
 * power-user override), but `getActivePreset()` migrates persisted
 * `active-preset.txt` values away from these names so existing users
 * who selected a paused preset before the pause don't get stranded on
 * a broken provider. See the `disabled` flag on PresetDef in
 * src/shared/model-registry.ts for the operator-facing surface.
 */
export const DEPRECATED_PRESET_REPLACEMENTS: Readonly<Record<string, PresetName>> = {
    'codex-cli': 'claude-cli',
};

export interface PresetInfo {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly exists: boolean;
    /** True for the four built-in presets, false for user-created. */
    readonly isBuiltIn: boolean;
}

/**
 * F-364: per-preset recommended budget caps for `KAGEOPS_MAX_RUN_USD`.
 *
 * The previous single $2 default was fine for subscription presets
 * (claude-cli / codex-cli — they don't bill per call) and catastrophic
 * for paid presets (openrouter_standard could legitimately spend $2+
 * on a single dense brief; openrouter_budget rarely needs more than
 * $0.50). Surface this to the operator via the setup wizard budget
 * step and as the default cap when no explicit env is set.
 *
 * Numbers are USD per project run, calibrated to a "medium" brief
 * (≈8 tasks, ≈4k-8k token outputs each). Operators can override per-
 * run via `KAGEOPS_MAX_RUN_USD`.
 */
export const DEFAULT_MAX_RUN_USD_BY_PRESET: Readonly<Record<PresetName, number>> = {
    'claude-cli':          0.50, // synthetic — subscription doesn't bill, but the cap is a runaway guard
    'claude-cli-premium':  2.00, // synthetic Opus/Sonnet mix is the most expensive equivalent rate
    'codex-cli':           0.50, // synthetic — same rationale as claude-cli
    'ollama':              0.50, // Ollama Cloud Pro plan is metered above free tier; cap protects from runaway
    'openrouter_budget':   0.50, // Gemini Flash + DeepSeek — typical run is $0.10-$0.30
    'openrouter_standard': 2.00, // Sonnet on Forge — typical run is $0.40-$1.20
};

const PRESET_META: Readonly<Record<PresetName, { label: string; description: string }>> = {
    'claude-cli': {
        label: 'Claude CLI (local)',
        description: 'Routes all agents through your local claude CLI. Zero API cost — uses your Claude subscription.',
    },
    'claude-cli-premium': {
        label: 'Claude CLI Premium (Opus + Sonnet)',
        description: 'Opus 4.7 on Sensei/Forge/Blueprint/Pixel (design quality), Sonnet 4.6 elsewhere. Best quality on subscription — no per-call cost.',
    },
    'codex-cli': {
        label: 'OpenAI Codex CLI (subscription)',
        description: 'Routes all agents through OpenAI Codex CLI. Zero $/call against your ChatGPT Plus / Pro subscription. Requires `npm i -g @openai/codex` + `codex` login.',
    },
    ollama: {
        label: 'Ollama Cloud (exploration tier — F-353)',
        description: 'Open-weights models (gpt-oss, qwen3-coder, glm-4.7, devstral). Zero $/call with a Pro plan. BEST FOR quick exploration / sketches — expect lower fidelity than the Claude paid path for brief-driven UI work. OS models tend to compress dense briefs into generic shells (F-353); use claude-cli-premium for production work.',
    },
    openrouter_budget: {
        label: 'OpenRouter Budget (advanced — F-358)',
        description: 'Gemini 2.5 Flash + DeepSeek V3.1 for Forge. ~30x cheaper than standard. Slower than other presets; cost-meter sometimes lags (F-358). Choose this only after the subscription presets are unavailable.',
    },
    openrouter_standard: {
        label: 'OpenRouter Standard (advanced — F-358)',
        description: 'Claude Sonnet 4 on Forge, Gemini 2.5 Flash elsewhere. Publication quality. Slower than claude-cli-premium and metered per-token; cost-meter sometimes lags (F-358).',
    },
};

/**
 * Built-in preset templates — seeded to disk on app boot so the
 * Command Center preset dropdown always lists every preset rather
 * than ghosting the unseeded ones as "(file missing)". Users can
 * still hand-edit the resulting JSON files later.                */
const PRESET_TEMPLATES: Readonly<Record<PresetName, AppAgentConfig>> = {
    'claude-cli': {
        agents: {
            sensei:    { model: 'claude-cli/sonnet', provider: 'claude-cli', fallbackModels: [] },
            scout:     { model: 'claude-cli/haiku',  provider: 'claude-cli', fallbackModels: [] },
            blueprint: { model: 'claude-cli/sonnet', provider: 'claude-cli', fallbackModels: [] },
            forge:     { model: 'claude-cli/sonnet', provider: 'claude-cli', fallbackModels: [] },
            vigil:     { model: 'claude-cli/haiku',  provider: 'claude-cli', fallbackModels: [] },
            aegis:     { model: 'claude-cli/haiku',  provider: 'claude-cli', fallbackModels: [] },
            pixel:     { model: 'claude-cli/haiku',  provider: 'claude-cli', fallbackModels: [] },
            cipher:    { model: 'claude-cli/haiku',  provider: 'claude-cli', fallbackModels: [] },
            herald:    { model: 'claude-cli/haiku',  provider: 'claude-cli', fallbackModels: [] },
        },
    },
    'claude-cli-premium': {
        agents: {
            sensei:    { model: 'claude-cli/claude-opus-4-7',   provider: 'claude-cli', fallbackModels: ['claude-cli/claude-sonnet-4-6'] },
            scout:     { model: 'claude-cli/claude-sonnet-4-6', provider: 'claude-cli', fallbackModels: ['claude-cli/claude-haiku-4-5-20251001'] },
            blueprint: { model: 'claude-cli/claude-opus-4-7',   provider: 'claude-cli', fallbackModels: ['claude-cli/claude-sonnet-4-6'] },
            forge:     { model: 'claude-cli/claude-opus-4-7',   provider: 'claude-cli', fallbackModels: ['claude-cli/claude-sonnet-4-6'] },
            vigil:     { model: 'claude-cli/claude-sonnet-4-6', provider: 'claude-cli', fallbackModels: ['claude-cli/claude-haiku-4-5-20251001'] },
            aegis:     { model: 'claude-cli/claude-sonnet-4-6', provider: 'claude-cli', fallbackModels: ['claude-cli/claude-haiku-4-5-20251001'] },
            pixel:     { model: 'claude-cli/claude-opus-4-7',   provider: 'claude-cli', fallbackModels: ['claude-cli/claude-sonnet-4-6'] },
            cipher:    { model: 'claude-cli/claude-sonnet-4-6', provider: 'claude-cli', fallbackModels: ['claude-cli/claude-haiku-4-5-20251001'] },
            herald:    { model: 'claude-cli/claude-sonnet-4-6', provider: 'claude-cli', fallbackModels: ['claude-cli/claude-haiku-4-5-20251001'] },
        },
    },
    'codex-cli': {
        // OpenAI Codex CLI subscription preset — every agent routes through
        // the local `codex` binary against the user's ChatGPT Plus / Pro
        // subscription. Model strings use canonical `provider/model` form
        // so parseModelString routes correctly to sendCodexCliPrompt; the
        // duplicated "codex-cli" model name signals "use Codex's default
        // model" to codex-cli.ts (it strips --model when name == provider).
        // Users can pin a specific model (e.g. "codex-cli/gpt-5-codex") by
        // editing the seeded JSON.
        agents: {
            sensei:    { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            scout:     { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            blueprint: { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            forge:     { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            vigil:     { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            aegis:     { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            pixel:     { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            cipher:    { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
            herald:    { model: 'codex-cli/codex-cli', provider: 'codex-cli', fallbackModels: [] },
        },
    },
    // F-347: model names verified against Ollama Cloud /api/tags on 2026-05-14.
    // Ollama Cloud no longer serves the `:cloud`-suffixed names that the
    // earlier template used (they returned HTTP 401 silently). The names
    // below map per-agent based on speciality. Refresh this when Ollama
    // Cloud rotates availability — the longer-term fix is auto-refresh
    // against /api/tags on first launch.
    ollama: {
        agents: {
            sensei:    { model: 'ollama/gpt-oss:20b',          provider: 'ollama', fallbackModels: ['ollama/qwen3-next:80b'] },
            scout:     { model: 'ollama/gpt-oss:20b',          provider: 'ollama', fallbackModels: ['ollama/qwen3-next:80b'] },
            blueprint: { model: 'ollama/qwen3-coder-next',     provider: 'ollama', fallbackModels: ['ollama/gpt-oss:20b'] },
            forge:     { model: 'ollama/qwen3-coder-next',     provider: 'ollama', fallbackModels: ['ollama/glm-4.7'] },
            vigil:     { model: 'ollama/devstral-small-2:24b', provider: 'ollama', fallbackModels: ['ollama/gpt-oss:20b'] },
            aegis:     { model: 'ollama/devstral-small-2:24b', provider: 'ollama', fallbackModels: ['ollama/gpt-oss:20b'] },
            pixel:     { model: 'ollama/glm-4.7',              provider: 'ollama', fallbackModels: ['ollama/qwen3-coder-next'] },
            cipher:    { model: 'ollama/qwen3-next:80b',       provider: 'ollama', fallbackModels: ['ollama/gpt-oss:20b'] },
            herald:    { model: 'ollama/gpt-oss:20b',          provider: 'ollama', fallbackModels: ['ollama/qwen3-next:80b'] },
        },
    },
    openrouter_budget: {
        agents: {
            sensei:    { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            scout:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            blueprint: { model: 'openrouter/anthropic/claude-haiku-3-5',  provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            forge:     { model: 'openrouter/deepseek/deepseek-chat-v3',   provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            vigil:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            aegis:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            pixel:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            cipher:    { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            herald:    { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
        },
    },
    openrouter_standard: {
        agents: {
            sensei:    { model: 'openrouter/anthropic/claude-sonnet-4',   provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            scout:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            blueprint: { model: 'openrouter/anthropic/claude-sonnet-4',   provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            forge:     { model: 'openrouter/anthropic/claude-sonnet-4',   provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            vigil:     { model: 'openrouter/anthropic/claude-haiku-3-5',  provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            aegis:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            pixel:     { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            cipher:    { model: 'openrouter/anthropic/claude-haiku-3-5',  provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
            herald:    { model: 'openrouter/google/gemini-2.5-flash',     provider: 'openrouter', fallbackModels: ['ollama/qwen3.5:9b'] },
        },
    },
};

/**
 * Seed any built-in preset files that don't exist on disk yet. Idempotent —
 * existing files are left alone so user edits survive subsequent boots.
 * Called from main bootstrap so the Command Center preset dropdown is
 * always usable, not littered with "(file missing)" placeholders.
 */
export function ensurePresetFiles(): void {
    ensureConfigDir();
    const dir = getDataDir();
    for (const name of PRESET_NAMES) {
        const file = path.join(dir, `agent-config.${name}.json`);
        if (fs.existsSync(file)) continue;
        try {
            const tpl = PRESET_TEMPLATES[name];
            const serialisable = {
                agents: Object.fromEntries(
                    Object.entries(tpl.agents).map(([n, e]) => [
                        n,
                        { model: e.model, provider: e.provider, fallbackModels: [...e.fallbackModels] },
                    ])
                ),
            };
            fs.writeFileSync(file, JSON.stringify(serialisable, null, 2), 'utf-8');
            log.info({ preset: name, path: file }, 'Seeded preset config');
        } catch (err) {
            log.warn({ err, preset: name, file }, 'Failed to seed preset config');
        }
    }
}

/**
 * List all presets — the four built-ins plus any user-created
 * `agent-config.<name>.json` files found in the data directory.
 * Custom presets are sorted alphabetically and tagged isBuiltIn=false
 * so the UI can offer a delete button only for those.
 */
export function listPresets(): readonly PresetInfo[] {
    const dir = getDataDir();
    const builtIn: PresetInfo[] = PRESET_NAMES.map((name) => ({
        name,
        label: PRESET_META[name].label,
        description: PRESET_META[name].description,
        exists: fs.existsSync(path.join(dir, `agent-config.${name}.json`)),
        isBuiltIn: true,
    }));

    const builtInSet = new Set<string>(PRESET_NAMES);
    const custom: PresetInfo[] = [];
    try {
        if (fs.existsSync(dir)) {
            const PRESET_RE = /^agent-config\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/;
            for (const entry of fs.readdirSync(dir)) {
                const m = PRESET_RE.exec(entry);
                if (m === null) continue;
                const name = m[1]!;
                if (builtInSet.has(name)) continue;
                if (name === 'openrouter.backup') continue; // legacy noise
                custom.push({
                    name,
                    label: name,
                    description: 'User-created preset',
                    exists: true,
                    isBuiltIn: false,
                });
            }
        }
    } catch (err) {
        log.warn({ err }, 'Failed to scan custom presets');
    }
    custom.sort((a, b) => a.name.localeCompare(b.name));

    return [...builtIn, ...custom];
}

// ── Custom preset CRUD ───────────────────────────────

/** Validate a user-supplied preset name. Lowercase letters, digits,
 *  underscore, dash, 1-32 chars. Conservative because the name lands
 *  on disk as a filename component.                                */
const PRESET_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidPresetName(name: string): boolean {
    return PRESET_NAME_RE.test(name);
}

/**
 * Create a new custom preset on disk. The preset becomes immediately
 * available in `listPresets()` and selectable via `setActivePreset`.
 *
 * - Refuses to overwrite a built-in name.
 * - Refuses to overwrite an existing file unless `overwrite: true`.
 * - Each agent entry is normalised to `{ model, provider, fallbackModels }`.
 */
export function createPreset(
    name: string,
    config: AppAgentConfig,
    opts: { overwrite?: boolean } = {},
): { ok: true; path: string } | { ok: false; error: string } {
    if (!isValidPresetName(name)) {
        return { ok: false, error: 'Name must be 1–32 chars, lowercase letters/digits/_/-, starting with a letter.' };
    }
    if ((PRESET_NAMES as readonly string[]).includes(name)) {
        return { ok: false, error: `"${name}" is a built-in preset name. Pick a different name.` };
    }

    ensureConfigDir();
    const file = path.join(getDataDir(), `agent-config.${name}.json`);
    if (fs.existsSync(file) && opts.overwrite !== true) {
        return { ok: false, error: `Preset "${name}" already exists.` };
    }

    try {
        const serialisable = {
            agents: Object.fromEntries(
                Object.entries(config.agents).map(([n, e]) => [
                    n,
                    {
                        model: e.model,
                        provider: e.provider,
                        fallbackModels: [...e.fallbackModels],
                    },
                ])
            ),
        };
        fs.writeFileSync(file, JSON.stringify(serialisable, null, 2), 'utf-8');
        log.info({ name, file }, 'Created custom preset');
        return { ok: true, path: file };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}

/** Delete a custom preset. Refuses built-ins. Clears active-preset
 *  if the deleted preset was selected.                              */
export function deletePreset(name: string): { ok: true } | { ok: false; error: string } {
    if (!isValidPresetName(name)) {
        return { ok: false, error: 'Invalid preset name.' };
    }
    if ((PRESET_NAMES as readonly string[]).includes(name)) {
        return { ok: false, error: `Cannot delete built-in preset "${name}".` };
    }
    const file = path.join(getDataDir(), `agent-config.${name}.json`);
    if (!fs.existsSync(file)) {
        return { ok: false, error: `Preset "${name}" does not exist.` };
    }
    try {
        fs.unlinkSync(file);
        log.info({ name }, 'Deleted custom preset');

        // Clear active selection if it pointed at this preset.
        const activeFile = getActivePresetPath();
        if (fs.existsSync(activeFile)) {
            try {
                const raw = fs.readFileSync(activeFile, 'utf-8').trim();
                if (raw === name) {
                    fs.unlinkSync(activeFile);
                    log.info({ name }, 'Cleared active-preset because the deleted preset was active');
                }
            } catch { /* ignore */ }
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Read the active preset name. Returns built-in or custom preset
 * names — anything that has a matching `agent-config.<name>.json`
 * file on disk is valid.
 *
 * Priority: KAGEOPS_PRESET env > active-preset.txt > null.
 */
export function getActivePreset(): string | null {
    const envPreset = process.env['KAGEOPS_PRESET'];
    if (envPreset !== undefined && envPreset !== '' && presetFileExists(envPreset)) {
        // env override is a deliberate power-user opt-in — we honour it
        // even when the preset is deprecated, so KAGEOPS_PRESET=codex-cli
        // remains a valid escape hatch.
        return envPreset;
    }
    const p = getActivePresetPath();
    if (!fs.existsSync(p)) return null;
    try {
        const raw = fs.readFileSync(p, 'utf-8').trim();
        if (raw === '') return null;
        // Migrate deprecated presets to their replacement on first read.
        // Subsequent reads pick up the new value naturally because we
        // also rewrite the file. Keeps users on a working provider when
        // they upgrade from a version that exposed a now-paused preset.
        const replacement = DEPRECATED_PRESET_REPLACEMENTS[raw];
        if (replacement !== undefined) {
            log.warn({ from: raw, to: replacement }, 'Migrating deprecated active preset to replacement');
            setActivePreset(replacement);
            return replacement;
        }
        // Built-ins resolve even if file missing (template-seeded later).
        if (isPresetName(raw)) return raw;
        return presetFileExists(raw) ? raw : null;
    } catch {
        return null;
    }
}

/** True when an `agent-config.<name>.json` file exists on disk. */
function presetFileExists(name: string): boolean {
    if (!isValidPresetName(name) && !isPresetName(name)) return false;
    return fs.existsSync(path.join(getDataDir(), `agent-config.${name}.json`));
}

/** Persist the active preset. Accepts any preset string (built-in or
 *  custom). Passing null clears it.                                  */
export function setActivePreset(preset: string | null): void {
    ensureConfigDir();
    const p = getActivePresetPath();
    try {
        if (preset === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
            log.info('Cleared active preset');
            return;
        }
        fs.writeFileSync(p, preset, 'utf-8');
        log.info({ preset }, 'Active preset updated');
    } catch (err) {
        log.error({ err, preset }, 'Failed to persist active preset');
    }
}

function isPresetName(value: string): value is PresetName {
    return (PRESET_NAMES as readonly string[]).includes(value);
}

// ── Design Provider ──────────────────────────────────

/**
 * Known design provider ids — must stay in sync with
 * `src/agents/design/design-provider.ts` (DesignProviderId).
 * Kept as a plain string array here to avoid a main-process
 * import of the renderer-adjacent design module.
 */
export const DESIGN_PROVIDER_IDS = ['in-house', 'claude-ui', 'openai-ui', 'v0', 'figma', 'locofy'] as const;
export type DesignProviderId = typeof DESIGN_PROVIDER_IDS[number];

export interface DesignProviderInfo {
    readonly id: DesignProviderId;
    readonly label: string;
    readonly description: string;
    /** False when the provider is registered but not yet implemented. */
    readonly available: boolean;
}

const DESIGN_PROVIDER_META: Readonly<Record<DesignProviderId, { label: string; description: string; available: boolean }>> = {
    'in-house': {
        label: 'In-House (preset model)',
        description: 'Uses whatever model the active preset has configured. Cheapest option on budget presets.',
        available: true,
    },
    'claude-ui': {
        label: 'Claude UI (Sonnet)',
        description: 'Pins Claude Sonnet with a design-focused system prompt. Higher visual quality at published Sonnet pricing ($3/M in, $15/M out).',
        available: true,
    },
    'openai-ui': {
        label: 'OpenAI UI (GPT-5)',
        description: 'Routes Pixel through OpenAI directly. Default model openai/gpt-5.4. Requires OPENAI_API_KEY in keychain or env.',
        available: true,
    },
    v0: {
        label: 'v0 (Vercel)',
        description: 'Vercel v0 design-to-code. Requires V0_API_KEY. Scaffold present; generateUI() not yet implemented.',
        available: false,
    },
    figma: {
        label: 'Figma (importer)',
        description: 'Read-only — imports existing Figma frames. Not implemented yet.',
        available: false,
    },
    locofy: {
        label: 'Locofy',
        description: 'Design-to-code via Locofy API. Not implemented yet.',
        available: false,
    },
};

function getActiveDesignProviderPath(): string {
    return path.join(getDataDir(), 'active-design-provider.txt');
}

function isDesignProviderId(value: string): value is DesignProviderId {
    return (DESIGN_PROVIDER_IDS as readonly string[]).includes(value);
}

/** List all design providers with availability info. */
export function listDesignProviders(): readonly DesignProviderInfo[] {
    return DESIGN_PROVIDER_IDS.map((id) => ({
        id,
        label: DESIGN_PROVIDER_META[id].label,
        description: DESIGN_PROVIDER_META[id].description,
        available: DESIGN_PROVIDER_META[id].available,
    }));
}

/**
 * Read the active design provider.
 * Priority: KAGEOPS_DESIGN_PROVIDER env > active-design-provider.txt > 'in-house'.
 */
export function getActiveDesignProvider(): DesignProviderId {
    const envId = process.env['KAGEOPS_DESIGN_PROVIDER'];
    if (envId !== undefined && envId !== '' && isDesignProviderId(envId)) {
        return envId;
    }
    const p = getActiveDesignProviderPath();
    if (!fs.existsSync(p)) return 'in-house';
    try {
        const raw = fs.readFileSync(p, 'utf-8').trim();
        return isDesignProviderId(raw) ? raw : 'in-house';
    } catch {
        return 'in-house';
    }
}

/** Persist the active design provider. */
export function setActiveDesignProvider(id: DesignProviderId): void {
    ensureConfigDir();
    const p = getActiveDesignProviderPath();
    try {
        fs.writeFileSync(p, id, 'utf-8');
        log.info({ id }, 'Active design provider updated');
    } catch (err) {
        log.error({ err, id }, 'Failed to persist active design provider');
    }
}

function ensureConfigDir(): void {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// ── Public API ───────────────────────────────────────

/**
 * Load application-level agent model config from ~/.kageops/agent-config.json.
 * Returns the built-in defaults if the file is missing or unparseable.
 */
export function loadAppAgentConfig(): AppAgentConfig {
    const configPath = resolveActiveConfigPath();

    if (!fs.existsSync(configPath)) {
        log.debug({ configPath }, 'Config file not found, returning defaults');
        return DEFAULT_CONFIG;
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const json: unknown = JSON.parse(raw);

        if (
            typeof json !== 'object' ||
            json === null ||
            !('agents' in json) ||
            typeof (json as Record<string, unknown>).agents !== 'object'
        ) {
            log.warn({ configPath }, 'Config file has unexpected shape — returning defaults');
            return DEFAULT_CONFIG;
        }

        const parsed = json as { agents: Record<string, unknown> };
        const agents: Record<string, AgentModelEntry> = { ...DEFAULT_CONFIG.agents };

        for (const [name, value] of Object.entries(parsed.agents)) {
            if (
                typeof value === 'object' &&
                value !== null &&
                'model' in value &&
                typeof (value as Record<string, unknown>).model === 'string' &&
                'provider' in value &&
                typeof (value as Record<string, unknown>).provider === 'string'
            ) {
                const entry = value as Record<string, unknown>;
                const fallbackModels = Array.isArray(entry.fallbackModels)
                    ? (entry.fallbackModels as unknown[])
                          .filter((f): f is string => typeof f === 'string')
                    : [...DEFAULT_FALLBACKS];

                agents[name] = {
                    model: entry.model as string,
                    provider: entry.provider as string,
                    fallbackModels,
                };
            }
        }

        return { agents };
    } catch (err) {
        log.warn({ err, configPath }, 'Failed to parse agent config — returning defaults');
        return DEFAULT_CONFIG;
    }
}

/**
 * Save the full application-level agent config to disk synchronously.
 */
export function saveAppAgentConfig(config: AppAgentConfig): void {
    const configPath = getConfigPath();
    try {
        ensureConfigDir();
        const serialisable = {
            agents: Object.fromEntries(
                Object.entries(config.agents).map(([name, entry]) => [
                    name,
                    {
                        model: entry.model,
                        provider: entry.provider,
                        fallbackModels: [...entry.fallbackModels],
                    },
                ])
            ),
        };
        fs.writeFileSync(configPath, JSON.stringify(serialisable, null, 2), 'utf-8');
        log.debug({ configPath }, 'Saved agent config');
    } catch (err) {
        log.error({ err, configPath }, 'Failed to save agent config');
    }
}

/**
 * Return the model config for a single agent.
 * Falls back to the default entry if the agent is not found in the config.
 */
export function getAgentModelConfig(agentName: string): AgentModelEntry {
    const config = loadAppAgentConfig();
    return config.agents[agentName] ?? DEFAULT_AGENT_ENTRY;
}

/**
 * Update a single agent's model config and persist immediately.
 */
export function setAgentModelConfig(
    agentName: string,
    model: string,
    provider: string,
    fallbackModels: readonly string[]
): void {
    const existing = loadAppAgentConfig();
    const updated: AppAgentConfig = {
        agents: {
            ...existing.agents,
            [agentName]: { model, provider, fallbackModels: [...fallbackModels] },
        },
    };
    saveAppAgentConfig(updated);
    log.info({ agentName, model, provider }, 'Updated agent model config');
}
