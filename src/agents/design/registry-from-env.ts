/**
 * Build a ProviderRegistry from the environment.
 *
 * Single binding point between env vars and the design provider stack.
 * Call this once during orchestrator bootstrap; pass the resulting
 * registry to specialists that want to delegate UI generation.
 *
 * Env vars honored:
 *   KAGEOPS_DESIGN_PROVIDER       — default provider id (in-house|claude-ui|openai-ui|v0|figma|locofy)
 *   KAGEOPS_CLAUDE_UI_MODEL       — model string for ClaudeUiProvider
 *   KAGEOPS_CLAUDE_UI_MAX_TOKENS  — max output tokens for ClaudeUiProvider
 *   KAGEOPS_OPENAI_UI_MODEL       — model string for OpenAiUiProvider (e.g. openai/gpt-5.4)
 *   KAGEOPS_OPENAI_UI_MAX_TOKENS  — max output tokens for OpenAiUiProvider
 *   V0_API_KEY + KAGEOPS_V0_TIER  — existing V0 provider wiring
 */

import {
    DesignProviderId,
    DEFAULT_DESIGN_PROVIDER,
    isDesignProviderId,
} from './design-provider';
import { ProviderRegistry, ProviderRegistryConfig } from './provider-registry';
import {
    ClaudeUiProviderConfig,
    DEFAULT_CLAUDE_UI_MODEL,
} from './claude-ui-provider';
import {
    OpenAiUiProviderConfig,
    DEFAULT_OPENAI_UI_MODEL,
} from './openai-ui-provider';
import { V0Tier } from './v0-provider';
import { InHouseProviderConfig } from './in-house-provider';

export interface BuildRegistryOptions {
    /** Required — model string used by the always-present in-house provider. */
    readonly inHouseModel: string;
    /**
     * If true, register ClaudeUiProvider even when no KAGEOPS_CLAUDE_UI_*
     * envs are set (uses built-in defaults). When false, the provider is
     * only registered when at least one env var is present. Defaults to
     * true — the provider is self-contained and adds no cost unless it is
     * actually resolved.
     */
    readonly alwaysRegisterClaudeUi?: boolean;
    /**
     * If true, register OpenAiUiProvider even when no KAGEOPS_OPENAI_UI_*
     * envs are set. The provider only activates at request time when an
     * OPENAI_API_KEY is present (isAvailable() short-circuits otherwise),
     * so registration is cheap. Defaults to true.
     */
    readonly alwaysRegisterOpenAiUi?: boolean;
    /** Test hook — inject an env bag instead of reading process.env. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve the preferred design provider id from env. Falls back to
 * DEFAULT_DESIGN_PROVIDER when the env var is missing or invalid.
 * Exported for unit tests and for callers that only need the id.
 */
export function resolveDesignProviderId(
    env: Readonly<Record<string, string | undefined>> = process.env
): DesignProviderId {
    const raw = env['KAGEOPS_DESIGN_PROVIDER'];
    if (raw === undefined || raw.length === 0) return DEFAULT_DESIGN_PROVIDER;
    return isDesignProviderId(raw) ? raw : DEFAULT_DESIGN_PROVIDER;
}

function parsePositiveInt(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildClaudeUiConfig(
    env: Readonly<Record<string, string | undefined>>
): ClaudeUiProviderConfig {
    return {
        model: env['KAGEOPS_CLAUDE_UI_MODEL'] ?? DEFAULT_CLAUDE_UI_MODEL,
        maxTokens: parsePositiveInt(env['KAGEOPS_CLAUDE_UI_MAX_TOKENS']),
    };
}

function buildOpenAiUiConfig(
    env: Readonly<Record<string, string | undefined>>
): OpenAiUiProviderConfig {
    return {
        model: env['KAGEOPS_OPENAI_UI_MODEL'] ?? DEFAULT_OPENAI_UI_MODEL,
        maxTokens: parsePositiveInt(env['KAGEOPS_OPENAI_UI_MAX_TOKENS']),
    };
}

const KNOWN_V0_TIERS: readonly V0Tier[] = ['mini', 'pro', 'max', 'max-fast'];
function parseV0Tier(value: string | undefined): V0Tier {
    return (KNOWN_V0_TIERS as readonly string[]).includes(value ?? '')
        ? (value as V0Tier)
        : 'mini';
}

export function buildProviderRegistryFromEnv(
    options: BuildRegistryOptions
): ProviderRegistry {
    const env = options.env ?? process.env;
    const inHouse: InHouseProviderConfig = { model: options.inHouseModel };

    const alwaysRegisterClaude = options.alwaysRegisterClaudeUi !== false;
    const claudeEnvPresent =
        env['KAGEOPS_CLAUDE_UI_MODEL'] !== undefined ||
        env['KAGEOPS_CLAUDE_UI_MAX_TOKENS'] !== undefined;
    const claudeUi =
        alwaysRegisterClaude || claudeEnvPresent
            ? buildClaudeUiConfig(env)
            : undefined;

    // OpenAI UI provider (GPT-5 family + GPT-4o). Registers cheaply —
    // isAvailable() short-circuits at request time when no OPENAI_API_KEY
    // is configured, so always-register is safe.
    const alwaysRegisterOpenAi = options.alwaysRegisterOpenAiUi !== false;
    const openAiEnvPresent =
        env['KAGEOPS_OPENAI_UI_MODEL'] !== undefined ||
        env['KAGEOPS_OPENAI_UI_MAX_TOKENS'] !== undefined;
    const openaiUi =
        alwaysRegisterOpenAi || openAiEnvPresent
            ? buildOpenAiUiConfig(env)
            : undefined;

    const v0ApiKey = env['V0_API_KEY'];
    const v0 =
        v0ApiKey !== undefined && v0ApiKey.length > 0
            ? { apiKey: v0ApiKey, tier: parseV0Tier(env['KAGEOPS_V0_TIER']) }
            : undefined;

    const config: ProviderRegistryConfig = { inHouse, claudeUi, openaiUi, v0 };
    return new ProviderRegistry(config);
}
