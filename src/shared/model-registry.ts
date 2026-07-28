/**
 * Single source of truth for all AI providers, models, and presets.
 * All other modules should import from here instead of defining their own constants.
 */

// ── Provider definitions ──────────────────────────────────────────────────────

export interface ProviderDef {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /** Whether this provider requires a local daemon (e.g. Ollama) */
    readonly isLocal: boolean;
    /** Whether this provider uses the Claude CLI binary (not API key) */
    readonly isCli: boolean;
}

export const PROVIDERS: readonly ProviderDef[] = [
    {
        id: 'claude-cli',
        label: 'Claude CLI',
        description: 'Runs Claude via the local claude CLI binary — no API key needed, uses your existing Claude subscription.',
        isLocal: true,
        isCli: true,
    },
    {
        id: 'claude',
        label: 'Anthropic (API)',
        description: 'Direct Anthropic API access — most capable Claude models, requires ANTHROPIC_API_KEY.',
        isLocal: false,
        isCli: false,
    },
    {
        id: 'openai',
        label: 'OpenAI',
        description: 'GPT-4o and o-series models — strong general-purpose and coding performance.',
        isLocal: false,
        isCli: false,
    },
    {
        id: 'gemini',
        label: 'Google (Gemini)',
        description: 'Gemini 2.5 Flash/Pro — fast, cost-effective, long context window.',
        isLocal: false,
        isCli: false,
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        description: 'Unified API gateway for 100+ models — mix providers in a single preset.',
        isLocal: false,
        isCli: false,
    },
    {
        id: 'ollama',
        label: 'Ollama (local)',
        description: 'Open-source models running fully on your machine — zero cost, full privacy.',
        isLocal: true,
        isCli: false,
    },
] as const;

/** Matches the AiProvider type in src/agents/ai-adapter/types.ts */
export type AiProvider = 'claude-cli' | 'codex-cli' | 'claude' | 'openai' | 'gemini' | 'openrouter' | 'ollama';

// ── Model tier ────────────────────────────────────────────────────────────────

export type ModelTier = 'frontier' | 'fast' | 'balanced' | 'local';

// ── Model definitions ─────────────────────────────────────────────────────────

export interface ModelDef {
    readonly id: string;
    readonly provider: AiProvider;
    readonly label: string;
    readonly tier: ModelTier;
    readonly contextK: number;     // context window in thousands of tokens
    readonly costPer1MIn: number;  // USD per 1M input tokens (0 for local/cli)
    readonly costPer1MOut: number; // USD per 1M output tokens (0 for local/cli)
    readonly description: string;
}

export const MODELS: readonly ModelDef[] = [
    // ── Claude CLI (uses CLI binary, prices are $0 — billed via subscription) ─
    {
        id: 'claude-opus-4-7',
        provider: 'claude-cli',
        label: 'Claude Opus 4.7',
        tier: 'frontier',
        contextK: 200,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'Most capable Claude model — best for complex reasoning and architecture.',
    },
    {
        id: 'claude-sonnet-4-6',
        provider: 'claude-cli',
        label: 'Claude Sonnet 4.6',
        tier: 'balanced',
        contextK: 200,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'Best balance of speed and capability for everyday coding tasks.',
    },
    {
        id: 'claude-haiku-4-5',
        provider: 'claude-cli',
        label: 'Claude Haiku 4.5',
        tier: 'fast',
        contextK: 200,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'Fastest Claude model — ideal for high-frequency, lightweight tasks.',
    },

    // ── OpenAI Codex CLI (subscription) ───────────────────────────────────────
    // Codex CLI picks its own default model server-side; we represent it as
    // a single registry entry so the Model Routing panel can render a clean
    // label per agent without hard-coding a specific model alias.
    {
        id: 'codex-cli',
        provider: 'codex-cli',
        label: 'Codex (default)',
        tier: 'balanced',
        contextK: 200,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'OpenAI Codex CLI — billed against ChatGPT Plus/Pro subscription. Strong on dev tooling and well-scoped engineering tasks.',
    },

    // ── Anthropic API ─────────────────────────────────────────────────────────
    {
        id: 'claude-opus-4-7-api',
        provider: 'claude',
        label: 'Claude Opus 4.7',
        tier: 'frontier',
        contextK: 200,
        costPer1MIn: 15,
        costPer1MOut: 75,
        description: 'Most capable Claude model — best for complex reasoning and architecture.',
    },
    {
        id: 'claude-sonnet-4-6-api',
        provider: 'claude',
        label: 'Claude Sonnet 4.6',
        tier: 'balanced',
        contextK: 200,
        costPer1MIn: 3,
        costPer1MOut: 15,
        description: 'Best balance of speed and capability for everyday coding tasks.',
    },
    {
        id: 'claude-haiku-4-5-api',
        provider: 'claude',
        label: 'Claude Haiku 4.5',
        tier: 'fast',
        contextK: 200,
        costPer1MIn: 0.8,
        costPer1MOut: 4,
        description: 'Fastest Claude model — ideal for high-frequency, lightweight tasks.',
    },

    // ── OpenAI ────────────────────────────────────────────────────────────────
    {
        id: 'gpt-4o',
        provider: 'openai',
        label: 'GPT-4o',
        tier: 'frontier',
        contextK: 128,
        costPer1MIn: 2.5,
        costPer1MOut: 10,
        description: 'OpenAI flagship — strong coding and reasoning, multimodal.',
    },
    {
        id: 'gpt-4o-mini',
        provider: 'openai',
        label: 'GPT-4o mini',
        tier: 'fast',
        contextK: 128,
        costPer1MIn: 0.15,
        costPer1MOut: 0.6,
        description: 'Lightweight GPT-4o — very cheap, great for classification and routing.',
    },
    {
        id: 'o3-mini',
        provider: 'openai',
        label: 'o3-mini',
        tier: 'balanced',
        contextK: 200,
        costPer1MIn: 1.1,
        costPer1MOut: 4.4,
        description: 'OpenAI reasoning model — excels at maths, science, and structured logic.',
    },

    // ── Google Gemini ─────────────────────────────────────────────────────────
    {
        id: 'gemini-2.5-pro',
        provider: 'gemini',
        label: 'Gemini 2.5 Pro',
        tier: 'frontier',
        contextK: 1000,
        costPer1MIn: 1.25,
        costPer1MOut: 10,
        description: 'Google flagship — largest context window, excellent for long-document work.',
    },
    {
        id: 'gemini-2.5-flash',
        provider: 'gemini',
        label: 'Gemini 2.5 Flash',
        tier: 'fast',
        contextK: 1000,
        costPer1MIn: 0.075,
        costPer1MOut: 0.3,
        description: 'Best price-per-token for everyday tasks — very fast, huge context.',
    },
    {
        id: 'gemini-2.0-flash',
        provider: 'gemini',
        label: 'Gemini 2.0 Flash',
        tier: 'fast',
        contextK: 128,
        costPer1MIn: 0.1,
        costPer1MOut: 0.4,
        description: 'Previous-gen Flash — slightly cheaper, still solid for routine work.',
    },

    // ── OpenRouter (meta-provider — these are routed internally) ──────────────
    {
        id: 'openrouter/anthropic/claude-sonnet-4',
        provider: 'openrouter',
        label: 'Claude Sonnet 4 (OR)',
        tier: 'balanced',
        contextK: 200,
        costPer1MIn: 3,
        costPer1MOut: 15,
        description: 'Claude Sonnet 4 via OpenRouter — good for mixing with non-Anthropic models.',
    },
    {
        id: 'openrouter/google/gemini-2.5-flash',
        provider: 'openrouter',
        label: 'Gemini 2.5 Flash (OR)',
        tier: 'fast',
        contextK: 1000,
        costPer1MIn: 0.075,
        costPer1MOut: 0.3,
        description: 'Gemini Flash via OpenRouter — cheapest high-quality option for large fleets.',
    },
    {
        id: 'openrouter/anthropic/claude-haiku-4.5',
        provider: 'openrouter',
        label: 'Claude Haiku 3.5 (OR)',
        tier: 'fast',
        contextK: 200,
        costPer1MIn: 0.8,
        costPer1MOut: 4,
        description: 'Fast Claude via OpenRouter — classification, routing, small tasks.',
    },
    {
        id: 'openrouter/deepseek/deepseek-v4-flash',
        provider: 'openrouter',
        label: 'DeepSeek Chat V3 (OR)',
        tier: 'balanced',
        contextK: 64,
        costPer1MIn: 0.27,
        costPer1MOut: 1.1,
        description: 'DeepSeek V3 — strong coding model, very cost-effective for Forge/build tasks.',
    },

    // ── Ollama (local, zero cost) ─────────────────────────────────────────────
    // Live Ollama Cloud tags as of 2026-06. The earlier picks (kimi-k2:1t-cloud,
    // qwen3-vl:235b-cloud, glm-4.6) were retired upstream and now return HTTP 410,
    // so they are intentionally not in the catalog — the card must match what runs.
    {
        id: 'gpt-oss:120b-cloud',
        provider: 'ollama',
        label: 'GPT-OSS 120B',
        tier: 'local',
        contextK: 128,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'Large open-source GPT-class model via Ollama Cloud — strongest at reasoning and strategy; the decision/orchestration model (Sensei, Scout, Blueprint).',
    },
    {
        id: 'qwen3-coder-next:cloud',
        provider: 'ollama',
        label: 'Qwen3 Coder Next',
        tier: 'local',
        contextK: 256,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'Qwen3 tuned for coding via Ollama Cloud — the default workhorse for code, review, infra, design and content (Forge, Cipher, Aegis, Vigil, Pixel, Herald).',
    },
    {
        id: 'glm-5.1',
        provider: 'ollama',
        label: 'GLM 5.1',
        tier: 'local',
        contextK: 32,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'GLM general model — solid for Forge/build tasks running entirely offline.',
    },
    {
        id: 'devstral-small-2:24b',
        provider: 'ollama',
        label: 'Devstral Small 2 (24B)',
        tier: 'local',
        contextK: 32,
        costPer1MIn: 0,
        costPer1MOut: 0,
        description: 'Mistral devstral — compact coding model for Vigil/Aegis/Cipher quality work.',
    },
] as const;

// ── Agent roster ──────────────────────────────────────────────────────────────

export const AGENT_IDS = [
    'sensei',
    'scout',
    'blueprint',
    'pixel',
    'forge',
    'cipher',
    'aegis',
    'vigil',
    'herald',
] as const;

export type AgentId = typeof AGENT_IDS[number];

export type AgentModelMap = Record<AgentId, string>;

// ── Cost tier labels ──────────────────────────────────────────────────────────

export type CostTier = 'free' | '$' | '$$' | '$$$';

// ── Preset definitions ────────────────────────────────────────────────────────

export interface PresetDef {
    readonly id: string;
    readonly label: string;
    readonly costTier: CostTier;
    readonly description: string;
    /** One sentence on the trade-off vs other presets. */
    readonly tradeoff: string;
    readonly agentModels: AgentModelMap;
    /**
     * Hide the preset from operator-facing selection surfaces (setup
     * wizard cards, command-palette quick-switch). The adapter wiring
     * stays intact so users with KAGEOPS_PRESET=<id> in their env can
     * still opt in. Used when a provider integration is known-broken
     * (e.g. codex-cli's grandchild-spawn popup at the time of v0.1.9).
     */
    readonly disabled?: boolean;
    /** Reason rendered to the operator when the preset is disabled. */
    readonly disabledReason?: string;
}

export const PRESETS: readonly PresetDef[] = [
    {
        id: 'claude-cli',
        label: 'Claude CLI (Standard)',
        costTier: 'free',
        description: 'All agents run through your local Claude CLI subscription — no API keys, no per-token billing.',
        tradeoff: 'Zero extra cost but limited to your subscription quota; Haiku for lightweight roles.',
        agentModels: {
            sensei:    'claude-sonnet-4-6',
            scout:     'claude-haiku-4-5',
            blueprint: 'claude-sonnet-4-6',
            pixel:     'claude-haiku-4-5',
            forge:     'claude-sonnet-4-6',
            cipher:    'claude-haiku-4-5',
            aegis:     'claude-haiku-4-5',
            vigil:     'claude-haiku-4-5',
            herald:    'claude-haiku-4-5',
        },
    },
    {
        id: 'claude-cli-premium',
        label: 'Claude CLI (Premium)',
        costTier: 'free',
        description: 'Upgrades strategic agents (Sensei, Blueprint, Forge, Pixel) to Opus 4.7 — still subscription-billed.',
        tradeoff: 'Best quality with no extra cost, but burns subscription quota fast on large projects.',
        agentModels: {
            sensei:    'claude-opus-4-7',
            scout:     'claude-sonnet-4-6',
            blueprint: 'claude-opus-4-7',
            pixel:     'claude-opus-4-7',
            forge:     'claude-opus-4-7',
            cipher:    'claude-haiku-4-5',
            aegis:     'claude-sonnet-4-6',
            vigil:     'claude-sonnet-4-6',
            herald:    'claude-sonnet-4-6',
        },
    },
    {
        id: 'codex-cli',
        label: 'Codex CLI (coming soon)',
        costTier: 'free',
        description: 'All agents run through your local OpenAI Codex CLI — billed against your ChatGPT Plus/Pro subscription, no API keys.',
        tradeoff: 'Zero per-call cost (subscription quota); strong on dev tooling and well-defined engineering tasks.',
        disabled: true,
        disabledReason: 'Codex CLI integration is paused while we resolve a grandchild-spawn console popup on Windows. Re-opens in a future release.',
        // Canonical `provider/model` form so parseModelString routes to
        // sendCodexCliPrompt. The duplicated "codex-cli" model name tells
        // codex-cli.ts to strip --model and let Codex pick its default.
        agentModels: {
            sensei:    'codex-cli/codex-cli',
            scout:     'codex-cli/codex-cli',
            blueprint: 'codex-cli/codex-cli',
            pixel:     'codex-cli/codex-cli',
            forge:     'codex-cli/codex-cli',
            cipher:    'codex-cli/codex-cli',
            aegis:     'codex-cli/codex-cli',
            vigil:     'codex-cli/codex-cli',
            herald:    'codex-cli/codex-cli',
        },
    },
    {
        id: 'openrouter_budget',
        label: 'OpenRouter (Budget)',
        costTier: '$',
        description: 'Mix of Gemini Flash + DeepSeek for engineering — lowest cost API preset.',
        tradeoff: 'Cheapest billed option; trade-off is Gemini Flash quality for most agents.',
        agentModels: {
            sensei:    'openrouter/google/gemini-2.5-flash',
            scout:     'openrouter/google/gemini-2.5-flash',
            blueprint: 'openrouter/anthropic/claude-haiku-4.5',
            pixel:     'openrouter/google/gemini-2.5-flash',
            forge:     'openrouter/deepseek/deepseek-v4-flash',
            cipher:    'openrouter/anthropic/claude-haiku-4.5',
            aegis:     'openrouter/google/gemini-2.5-flash',
            vigil:     'openrouter/google/gemini-2.5-flash',
            herald:    'openrouter/google/gemini-2.5-flash',
        },
    },
    {
        id: 'openrouter_standard',
        label: 'OpenRouter (Standard)',
        costTier: '$$',
        description: 'Claude Sonnet 4 for critical roles, Gemini Flash for speed-oriented agents.',
        tradeoff: 'Good quality/cost balance — Sonnet on planning and build, Flash on everything else.',
        agentModels: {
            sensei:    'openrouter/anthropic/claude-sonnet-4',
            scout:     'openrouter/google/gemini-2.5-flash',
            blueprint: 'openrouter/anthropic/claude-sonnet-4',
            pixel:     'openrouter/google/gemini-2.5-flash',
            forge:     'openrouter/anthropic/claude-sonnet-4',
            cipher:    'openrouter/anthropic/claude-haiku-4.5',
            aegis:     'openrouter/google/gemini-2.5-flash',
            vigil:     'openrouter/google/gemini-2.5-flash',
            herald:    'openrouter/google/gemini-2.5-flash',
        },
    },
    {
        id: 'ollama',
        label: 'Ollama (Fully Local)',
        costTier: 'free',
        description: 'Open-source via Ollama Cloud: GPT-OSS 120B drives the decisions (Sensei, Scout, Blueprint); Qwen3 Coder Next does the building (Forge, Cipher, Aegis, Vigil, Pixel, Herald). They cross-cover as each other\'s fallback.',
        tradeoff: 'Zero cost and maximum privacy. GPT-OSS 120B leads on reasoning/strategy; Qwen3 Coder Next is the faster coding workhorse — slower per call than premium APIs, but the harness is hardened to make this output build.',
        agentModels: {
            sensei:    'gpt-oss:120b-cloud',
            scout:     'gpt-oss:120b-cloud',
            blueprint: 'gpt-oss:120b-cloud',
            pixel:     'qwen3-coder-next:cloud',
            forge:     'qwen3-coder-next:cloud',
            cipher:    'qwen3-coder-next:cloud',
            aegis:     'qwen3-coder-next:cloud',
            vigil:     'qwen3-coder-next:cloud',
            herald:    'qwen3-coder-next:cloud',
        },
    },
] as const;

// ── Utility functions ─────────────────────────────────────────────────────────

export function getModelsForProvider(providerId: AiProvider): readonly ModelDef[] {
    return MODELS.filter((m) => m.provider === providerId);
}

export function getModelById(modelId: string): ModelDef | undefined {
    return MODELS.find((m) => m.id === modelId);
}

export function getPresetById(presetId: string): PresetDef | undefined {
    return PRESETS.find((p) => p.id === presetId);
}

export function getProviderById(providerId: string): ProviderDef | undefined {
    return PROVIDERS.find((p) => p.id === providerId);
}

/** Returns a human-readable label for a model ID, falling back to the raw ID. */
export function modelLabel(modelId: string): string {
    return getModelById(modelId)?.label ?? modelId;
}

/** All model IDs that belong to a given preset. */
export function presetModelIds(preset: PresetDef): readonly string[] {
    return [...new Set(Object.values(preset.agentModels))];
}

/** Cost tier display string. */
export function costTierLabel(tier: CostTier): string {
    switch (tier) {
        case 'free': return 'Free';
        case '$':    return 'Low cost';
        case '$$':   return 'Moderate';
        case '$$$':  return 'Premium';
    }
}
