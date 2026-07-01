/**
 * Provider registry + selection policy.
 *
 * Single entry point callers use to obtain a DesignProvider. Enforces the
 * "unpriced providers refuse to run unless explicitly opted in" rule:
 * providers reporting confidence='unknown' from estimateCost() throw
 * unless KAGEOPS_ALLOW_UNPRICED_DESIGN=1.
 */

import {
    DesignProvider,
    DesignProviderId,
    DesignProviderError,
    DEFAULT_DESIGN_PROVIDER,
    isDesignProviderId,
} from './design-provider';
import { InHouseProvider, InHouseProviderConfig } from './in-house-provider';
import { V0Provider, V0ProviderConfig } from './v0-provider';
import { ClaudeUiProvider, ClaudeUiProviderConfig } from './claude-ui-provider';
import { OpenAiUiProvider, OpenAiUiProviderConfig } from './openai-ui-provider';

export interface ProviderRegistryConfig {
    readonly inHouse: InHouseProviderConfig;
    readonly claudeUi?: ClaudeUiProviderConfig;
    readonly openaiUi?: OpenAiUiProviderConfig;
    readonly v0?: V0ProviderConfig;
}

export class ProviderRegistry {
    private readonly providers: Map<DesignProviderId, DesignProvider>;

    constructor(config: ProviderRegistryConfig) {
        this.providers = new Map();
        this.providers.set('in-house', new InHouseProvider(config.inHouse));
        if (config.claudeUi !== undefined) {
            this.providers.set(
                'claude-ui',
                new ClaudeUiProvider(config.claudeUi)
            );
        }
        if (config.openaiUi !== undefined) {
            this.providers.set(
                'openai-ui',
                new OpenAiUiProvider(config.openaiUi)
            );
        }
        if (config.v0 !== undefined) {
            this.providers.set('v0', new V0Provider(config.v0));
        }
    }

    list(): readonly DesignProviderId[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Resolve the provider for a project. Falls back to in-house if the
     * requested provider is not configured (e.g. v0 requested but no API
     * key present) — never silently blocks the pipeline.
     */
    resolve(requested: string | null | undefined): DesignProvider {
        const id: DesignProviderId =
            requested !== null && requested !== undefined && isDesignProviderId(requested)
                ? requested
                : DEFAULT_DESIGN_PROVIDER;
        const provider = this.providers.get(id);
        if (provider !== undefined) return provider;

        const fallback = this.providers.get(DEFAULT_DESIGN_PROVIDER);
        if (fallback === undefined) {
            throw new DesignProviderError(
                'registry',
                `No provider configured for '${id}' and no in-house fallback available`,
                { recoverable: false }
            );
        }
        return fallback;
    }

    /**
     * Enforce the unpriced-opt-in rule before a provider runs.
     * Throws DesignProviderError if the provider's estimate has
     * confidence='unknown' and the allow-unpriced env is not set.
     */
    async assertCostOk(
        provider: DesignProvider,
        estimate: { confidence: 'published' | 'heuristic' | 'unknown' }
    ): Promise<void> {
        if (estimate.confidence !== 'unknown') return;
        if (process.env['KAGEOPS_ALLOW_UNPRICED_DESIGN'] === '1') return;
        throw new DesignProviderError(
            provider.name,
            'Provider has no published per-call pricing; refusing to run. Set KAGEOPS_ALLOW_UNPRICED_DESIGN=1 to override.',
            { recoverable: false }
        );
    }
}
