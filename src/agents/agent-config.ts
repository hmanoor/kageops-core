/**
 * KageOps Agent Configuration
 *
 * Loads and validates per-agent configuration. Priority order:
 *   1. Project-level: <repoPath>/.autonauts/agent-config.json
 *   2. Global:        ~/.kageops/agent-config.json
 *   3. Built-in defaults (ollama/qwen3.5:9b)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentModelConfig } from './autonaut-agent';
import { createLogger } from '../shared/logger';
import { AgentConfigFileSchema } from '../shared/schemas';

const log = createLogger('AgentConfig');

// ── Types ────────────────────────────────────────────

export interface AgentConfigEntry {
    readonly model: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly systemPromptOverride?: string;
    readonly fallbackModels?: readonly string[];
}

export interface AgentConfigFile {
    readonly defaults: AgentConfigEntry;
    readonly agents: Record<string, Partial<AgentConfigEntry>>;
}

// ── Model Presets ────────────────────────────────────

/**
 * Provider-specific model presets.
 * Each preset is a complete agent→model mapping optimized for that provider.
 * Switch presets via Command Center > Configuration or ~/.kageops/agent-config.json.
 */

// ── Ollama Cloud Presets (Pro plan: 3 concurrent models) ─────────────────
// Free: 1 concurrent | Pro: 3 concurrent | Max: 10 concurrent
// Models run on Ollama's hosted infrastructure — no local GPU needed.
export const OLLAMA_CLOUD_PRESETS = {
    // Coding-optimized: Best SWE-Bench scores
    coding: {
        forge:     'ollama/glm-5.1:cloud',               // #1 SWE-Bench Pro, best code gen
        blueprint: 'ollama/qwen3-coder-next:cloud',      // 256K context, agentic coding
        vigil:     'ollama/devstral-small-2:24b-cloud',   // 24B — fast code review
        cipher:    'ollama/devstral-small-2:24b-cloud',   // 24B — fast schema work
    },
    // General tasks: Research, docs, marketing
    general: {
        scout:     'ollama/gpt-oss:120b-cloud',           // research & analysis
        herald:    'ollama/gpt-oss:120b-cloud',           // marketing copy
        pixel:     'ollama/gpt-oss:120b-cloud',           // design docs
        aegis:     'ollama/devstral-small-2:24b-cloud',   // infra tasks, fast
        sensei:    'ollama/gpt-oss:120b-cloud',           // orchestration
    },
    // Fallback: local model, zero-latency
    fallback: 'ollama/qwen3.5:9b',
} as const;

// ── OpenRouter Presets (recommended for speed + quality) ─────────────────
// Requires OPENROUTER_API_KEY. Access to all major models via one key.
export const OPENROUTER_PRESETS = {
    coding: {
        forge:     'openrouter/anthropic/claude-sonnet-4',    // best code quality, ~3-5s
        blueprint: 'openrouter/anthropic/claude-sonnet-4',    // architecture, large context
        vigil:     'openrouter/anthropic/claude-haiku-3-5',   // fast code review, ~1-2s
        cipher:    'openrouter/anthropic/claude-haiku-3-5',   // schema design
    },
    general: {
        scout:     'openrouter/google/gemini-2.5-flash',      // very fast, cheap
        herald:    'openrouter/google/gemini-2.5-flash',      // marketing copy
        pixel:     'openrouter/google/gemini-2.5-flash',      // design docs
        aegis:     'openrouter/google/gemini-2.5-flash',      // infra tasks
        sensei:    'openrouter/google/gemini-2.5-flash',      // orchestration
    },
    fallback: 'ollama/qwen3.5:9b',
} as const;

// ── Claude CLI Presets (zero-cost, subscription-backed) ─────────────────
// Routes every call through the local `claude` CLI. Requires Claude Code to be
// installed and authenticated. Reports cost as $0 — budget-kill stays inert
// unless you layer a token cap on top via KAGEOPS_MAX_TOKENS_<AGENT>.
export const CLAUDE_CLI_PRESETS = {
    coding: {
        forge:     'claude-cli/sonnet',
        blueprint: 'claude-cli/sonnet',
        vigil:     'claude-cli/haiku',
        cipher:    'claude-cli/haiku',
    },
    general: {
        scout:     'claude-cli/haiku',
        herald:    'claude-cli/haiku',
        pixel:     'claude-cli/haiku',
        aegis:     'claude-cli/haiku',
        sensei:    'claude-cli/sonnet',
    },
    fallback: 'claude-cli/haiku',
} as const;

// ── Preset type ─────────────────────────────────────
export type ProviderPreset = 'ollama-cloud' | 'openrouter' | 'claude-cli' | 'custom';

// ── Defaults ─────────────────────────────────────────

// Default models — Ollama cloud for zero-config, OpenRouter when key is available.
// Override via ~/.kageops/agent-config.json or Command Center > Configuration.
const DEFAULT_MODEL  = 'ollama/gpt-oss:120b-cloud';      // general tasks
const CODER_MODEL    = 'ollama/glm-5.1:cloud';            // coding tasks (SWE-Bench #1)
const FAST_CODER     = 'ollama/devstral-small-2:24b-cloud'; // fast code review
const FALLBACK_MODEL = 'ollama/qwen3.5:9b';               // fallback (local)

const DEFAULT_CONFIG: AgentConfigFile = {
    defaults: {
        model: DEFAULT_MODEL,
        temperature: 0.7,
        maxTokens: 8192,
        fallbackModels: [CODER_MODEL, FALLBACK_MODEL],
    },
    agents: {
        sensei:    { model: DEFAULT_MODEL,  maxTokens: 8192 },
        scout:     { model: DEFAULT_MODEL,  maxTokens: 8192 },
        blueprint: { model: 'ollama/qwen3-coder-next:cloud', maxTokens: 8192 },
        pixel:     { model: DEFAULT_MODEL,  maxTokens: 8192 },
        forge:     { model: 'openrouter/anthropic/claude-sonnet-4', maxTokens: 8192 },
        cipher:    { model: FAST_CODER,     maxTokens: 8192 },
        aegis:     { model: FAST_CODER,     maxTokens: 8192 },
        vigil:     { model: FAST_CODER,     maxTokens: 8192 },
        herald:    { model: DEFAULT_MODEL,  maxTokens: 8192 },
    },
};

// ── Global config path ────────────────────────────────

/**
 * Read the currently active preset name from KAGEOPS_PRESET env or
 * active-preset.txt. Returns null when no preset is selected (default config).
 *
 * This is a read-only sibling of the main-process setActivePreset(), exposed
 * here so agents can read the preset without importing main-process code.
 */
export function getActivePresetName(): string | null {
    const envPreset = process.env['KAGEOPS_PRESET'];
    if (envPreset !== undefined && envPreset !== '') return envPreset;

    const dataDir = process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');
    const activePresetFile = path.join(dataDir, 'active-preset.txt');
    if (!fs.existsSync(activePresetFile)) return null;
    try {
        const raw = fs.readFileSync(activePresetFile, 'utf-8').trim();
        return raw === '' ? null : raw;
    } catch {
        return null;
    }
}

/** Resolve config path: KAGEOPS_PRESET env → active-preset.txt → agent-config.json. */
function getGlobalConfigPath(): string {
    const dataDir = process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');

    // Preset resolution: env var wins, else persisted active-preset.txt
    let preset = process.env['KAGEOPS_PRESET'];
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
        if (!fs.existsSync(presetPath)) {
            // Try to seed built-in presets on demand. ensurePresetFiles() lives
            // in main/app-config-store.ts and writes templates idempotently.
            // Use require so this works in CJS-emitted main bundle too.
            try {
                /* eslint-disable @typescript-eslint/no-var-requires */
                const { ensurePresetFiles } = require('../main/app-config-store') as { ensurePresetFiles: () => void };
                /* eslint-enable @typescript-eslint/no-var-requires */
                ensurePresetFiles();
            } catch (err) {
                log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ensurePresetFiles() unavailable');
            }
        }
        if (fs.existsSync(presetPath)) {
            log.info({ preset, path: presetPath }, 'Using preset agent config');
            return presetPath;
        }
        // Loud failure — explicit preset, file still missing after seed attempt.
        log.error(
            { preset, path: presetPath, dataDir },
            `KAGEOPS_PRESET=${preset} requested but ${presetPath} does not exist after seed attempt. ` +
            `Either the preset name is unknown to ensurePresetFiles(), or the data dir is read-only. ` +
            `Falling back to defaults — agent quality WILL differ from what the preset implies.`
        );
        // Surface in stderr too — log levels often hidden in CI / headless.
        console.error(
            `[AgentConfig] WARNING: KAGEOPS_PRESET=${preset} could not be loaded. ` +
            `Expected: ${presetPath}. Falling back to built-in defaults — Pixel/Forge/Sensei may use different models than you expect.`
        );
    }

    // Primary: alongside .env in the data directory
    const primaryPath = path.join(dataDir, 'agent-config.json');
    if (fs.existsSync(primaryPath)) {
        return primaryPath;
    }

    // Legacy fallback: ~/.kageops/agent-config.json
    const legacyPath = path.join(os.homedir(), '.kageops', 'agent-config.json');
    if (fs.existsSync(legacyPath)) {
        return legacyPath;
    }

    return primaryPath;
}

// ── Config Loader ────────────────────────────────────

/**
 * Load agent configuration from a project's .autonauts/agent-config.json.
 * Falls back to global config (KAGEOPS_DATA_DIR or ~/.kageops/), then built-in defaults.
 */
export function loadAgentConfig(projectRepoPath?: string): AgentConfigFile {
    // No project path → try global config, fall back to built-in defaults
    if (projectRepoPath === undefined) {
        const globalPath = getGlobalConfigPath();
        if (fs.existsSync(globalPath)) {
            return loadFromFile(globalPath) ?? DEFAULT_CONFIG;
        }
        return DEFAULT_CONFIG;
    }

    const configPath = path.join(projectRepoPath, '.autonauts', 'agent-config.json');

    if (!fs.existsSync(configPath)) {
        return DEFAULT_CONFIG;
    }

    return loadFromFile(configPath) ?? DEFAULT_CONFIG;
}

function loadFromFile(configPath: string): AgentConfigFile | null {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const json: unknown = JSON.parse(raw);

        // ~/.kageops/agent-config.json uses a flat { agents: { name: { model, provider } } } format
        // from app-config-store. Convert it to AgentConfigFile shape if needed.
        if (isGlobalConfigFormat(json)) {
            return convertGlobalConfig(json);
        }

        // Validate against the Zod schema before merging with defaults
        const schemaResult = AgentConfigFileSchema.safeParse(json);
        if (!schemaResult.success) {
            log.warn(
                { errors: schemaResult.error.flatten() },
                'Agent config file has invalid structure — merging partial config with defaults'
            );
            return mergeWithDefaults(json as Partial<AgentConfigFile>);
        }

        return mergeWithDefaults(schemaResult.data);
    } catch (err) {
        log.warn({ err, configPath }, 'Failed to parse config file, using defaults');
        return null;
    }
}

/** Detects the app-config-store format: { agents: { name: { model, provider, fallbackModels } } } */
function isGlobalConfigFormat(json: unknown): json is { agents: Record<string, { model: string; provider: string }> } {
    if (typeof json !== 'object' || json === null) return false;
    const obj = json as Record<string, unknown>;
    if (typeof obj['agents'] !== 'object' || obj['agents'] === null) return false;
    // Check if any agent entry has a 'provider' field (app-config-store format)
    const first = Object.values(obj['agents'] as Record<string, unknown>)[0];
    return typeof first === 'object' && first !== null && 'provider' in first;
}

/** Convert app-config-store format to AgentConfigFile format */
function convertGlobalConfig(json: { agents: Record<string, { model: string; provider: string }> }): AgentConfigFile {
    const agents: Record<string, Partial<AgentConfigEntry>> = {};
    for (const [name, entry] of Object.entries(json.agents)) {
        // model is "ollama/qwen3.5:9b" → use directly (provider prefix included)
        agents[name] = { model: entry.model };
    }
    return mergeWithDefaults({ agents });
}

/**
 * Per-agent hard maxTokens caps. Prevents cost bleed from runaway
 * output when agents or the default config request 8192. Override via
 * KAGEOPS_MAX_TOKENS_<AGENT> env var (e.g. KAGEOPS_MAX_TOKENS_FORGE=6000).
 */
const AGENT_MAX_TOKENS_CAP: Readonly<Record<string, number>> = {
    sensei:    2048,
    scout:     2048,
    blueprint: 3072,
    forge:     4096,
    vigil:     2048,
    aegis:     2048,
    pixel:     2048,
    cipher:    2048,
    herald:    2048,
};

function envCapFor(agent: string): number | null {
    const raw = process.env[`KAGEOPS_MAX_TOKENS_${agent.toUpperCase()}`];
    if (raw === undefined || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Get the model config for a specific agent.
 * Merges agent-specific overrides with defaults and applies a hard per-agent cap.
 */
export function getAgentModelConfig(
    config: AgentConfigFile,
    agentName: string
): AgentModelConfig {
    const agentOverrides = config.agents[agentName] ?? {};
    const defaults = config.defaults;

    const requested = agentOverrides.maxTokens ?? defaults.maxTokens;
    const cap = envCapFor(agentName) ?? AGENT_MAX_TOKENS_CAP[agentName] ?? 4096;
    const clamped = Math.min(requested, cap);

    return {
        model: agentOverrides.model ?? defaults.model,
        temperature: agentOverrides.temperature ?? defaults.temperature,
        maxTokens: clamped,
    };
}

/**
 * Get the default configuration (no project-specific overrides).
 */
export function getDefaultConfig(): AgentConfigFile {
    return DEFAULT_CONFIG;
}

/**
 * Validate a config entry's values are within acceptable ranges.
 */
export function validateConfigEntry(entry: Partial<AgentConfigEntry>): readonly string[] {
    const errors: string[] = [];

    if (entry.temperature !== undefined) {
        if (entry.temperature < 0 || entry.temperature > 2) {
            errors.push(`Temperature must be 0-2, got ${entry.temperature}`);
        }
    }

    if (entry.maxTokens !== undefined) {
        if (entry.maxTokens < 1 || entry.maxTokens > 200000) {
            errors.push(`maxTokens must be 1-200000, got ${entry.maxTokens}`);
        }
    }

    if (entry.model !== undefined) {
        if (typeof entry.model !== 'string' || entry.model.length === 0) {
            errors.push('model must be a non-empty string');
        }
    }

    return errors;
}

// ── Private ──────────────────────────────────────────

function mergeWithDefaults(partial: Partial<AgentConfigFile>): AgentConfigFile {
    const defaults = partial.defaults !== undefined
        ? { ...DEFAULT_CONFIG.defaults, ...partial.defaults }
        : DEFAULT_CONFIG.defaults;

    const agents: Record<string, Partial<AgentConfigEntry>> = { ...DEFAULT_CONFIG.agents };
    if (partial.agents !== undefined) {
        for (const [name, overrides] of Object.entries(partial.agents)) {
            agents[name] = { ...(agents[name] ?? {}), ...overrides };
        }
    }

    return { defaults, agents };
}
