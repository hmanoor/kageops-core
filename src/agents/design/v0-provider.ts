/**
 * V0Provider — Vercel v0 design/UI generation provider.
 *
 * v0 is the one external design service with PUBLISHED per-token pricing
 * (Mini $1/$5/M, Pro $3/$15/M, Max $5/$25/M, Max-Fast $30/$150/M), which
 * keeps it budget-kill compatible without the KAGEOPS_ALLOW_UNPRICED_DESIGN
 * override. Backed by the `v0-sdk` npm package (Vercel's official client).
 *
 * The SDK does NOT surface token usage or cost on the response, so we report
 * costUsd / tokensIn / tokensOut using `computeV0Cost` and the config
 * estimates. This is heuristic, but the global budget-kill poller re-checks
 * `SUM(agent_logs.cost_usd)` every 3s — if the real cost drifts high, the
 * run is cancelled. Safe by construction.
 */

import { createClient } from 'v0-sdk';
import {
    DesignProvider,
    DesignSpec,
    DesignArtifact,
    CostEstimate,
    DesignProviderError,
    DesignFile,
} from './design-provider';
import { parseDesignFiles } from './in-house-provider';

const PROVIDER_NAME = 'v0';

export type V0Tier = 'mini' | 'pro' | 'max' | 'max-fast';

interface V0TierRates {
    /** USD per million input tokens */
    readonly inputPerM: number;
    /** USD per million output tokens */
    readonly outputPerM: number;
}

const TIER_RATES: Readonly<Record<V0Tier, V0TierRates>> = {
    mini: { inputPerM: 1, outputPerM: 5 },
    pro: { inputPerM: 3, outputPerM: 15 },
    max: { inputPerM: 5, outputPerM: 25 },
    'max-fast': { inputPerM: 30, outputPerM: 150 },
};

/**
 * v0-sdk model IDs (from ChatsCreateRequest.modelConfiguration.modelId).
 * Marked @deprecated in the SDK types but still the only way to select a
 * tier — leaving in place until v0 publishes a replacement.
 */
type V0ModelId = 'v0-mini' | 'v0-pro' | 'v0-max' | 'v0-max-fast';

const TIER_TO_MODEL_ID: Readonly<Record<V0Tier, V0ModelId>> = {
    mini: 'v0-mini',
    pro: 'v0-pro',
    max: 'v0-max',
    'max-fast': 'v0-max-fast',
};

/**
 * Resolved return type of `chats.create(...)` — avoids depending on
 * non-exported SDK types while still giving us a real narrowing against
 * the streaming branch.
 */
type V0ChatsCreateResult = Awaited<
    ReturnType<ReturnType<typeof createClient>['chats']['create']>
>;

export interface V0ProviderConfig {
    readonly apiKey: string;
    readonly tier: V0Tier;
    /** Rough token projection for estimateCost / reported cost — tune per project. */
    readonly estimatedTokensIn?: number;
    readonly estimatedTokensOut?: number;
}

const DEFAULT_TOKENS_IN = 2_000;
const DEFAULT_TOKENS_OUT = 4_000;

const SYSTEM_PROMPT =
    'You are a senior UX engineer producing a single coherent UI. ' +
    'Use semantic HTML, meet WCAG AA contrast, and make layouts responsive from 360px up. ' +
    'If the brief lists required element IDs, every one MUST appear verbatim in the emitted HTML.';

function buildUserPrompt(spec: DesignSpec): string {
    const lines: string[] = [
        `Project: ${spec.title}`,
        `Description: ${spec.description}`,
        `Output kind: ${spec.outputKind}`,
    ];
    if (spec.brief !== undefined && spec.brief.length > 0) {
        lines.push('', 'Design brief:', spec.brief);
    }
    return lines.join('\n');
}

/**
 * Pure cost calc — exported for unit tests.
 */
export function computeV0Cost(
    tier: V0Tier,
    tokensIn: number,
    tokensOut: number
): number {
    const rates = TIER_RATES[tier];
    return (tokensIn * rates.inputPerM + tokensOut * rates.outputPerM) / 1_000_000;
}

interface V0ChatFile {
    readonly name: string;
    readonly content: string;
}

interface V0ChatResponseLike {
    readonly latestVersion?: { readonly files?: readonly V0ChatFile[] };
    readonly text?: string;
    readonly webUrl?: string;
}

/**
 * Extract DesignFile[] from a v0 chat response. Prefers the structured
 * `latestVersion.files` list; falls back to parsing `text` for FILE blocks;
 * finally falls back to a single markdown file with the raw text.
 */
export function extractV0Files(response: V0ChatResponseLike): readonly DesignFile[] {
    const versionFiles = response.latestVersion?.files ?? [];
    if (versionFiles.length > 0) {
        return versionFiles.map((f) => ({ path: f.name, content: f.content }));
    }
    const text = response.text ?? '';
    const parsed = parseDesignFiles(text);
    if (parsed.length > 0) return parsed;
    if (text.length > 0) return [{ path: 'designs/v0.md', content: text }];
    return [];
}

export class V0Provider implements DesignProvider {
    readonly name = PROVIDER_NAME;
    private readonly config: V0ProviderConfig;

    constructor(config: V0ProviderConfig) {
        this.config = config;
    }

    async isAvailable(): Promise<boolean> {
        return this.config.apiKey.length > 0;
    }

    async estimateCost(_spec: DesignSpec): Promise<CostEstimate> {
        const tokensIn = this.config.estimatedTokensIn ?? DEFAULT_TOKENS_IN;
        const tokensOut = this.config.estimatedTokensOut ?? DEFAULT_TOKENS_OUT;
        return {
            usd: computeV0Cost(this.config.tier, tokensIn, tokensOut),
            confidence: 'published',
        };
    }

    async generateUI(spec: DesignSpec): Promise<DesignArtifact> {
        if (!(await this.isAvailable())) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                'V0_API_KEY not configured',
                { recoverable: true }
            );
        }

        const start = Date.now();
        const client = createClient({ apiKey: this.config.apiKey });

        let raw: V0ChatsCreateResult;
        try {
            raw = await client.chats.create({
                message: buildUserPrompt(spec),
                system: SYSTEM_PROMPT,
                modelConfiguration: { modelId: TIER_TO_MODEL_ID[this.config.tier] },
                responseMode: 'sync',
            });
        } catch (err) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                err instanceof Error ? err.message : String(err),
                { recoverable: true, cause: err }
            );
        }

        if (raw instanceof ReadableStream) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                'Received streaming response but requested responseMode=sync',
                { recoverable: false }
            );
        }

        // raw is now narrowed to ChatDetail (the non-stream branch of the union).
        const files = extractV0Files(raw);
        if (files.length === 0) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                'v0 returned no files and no text — empty response',
                { recoverable: true }
            );
        }

        const tokensIn = this.config.estimatedTokensIn ?? DEFAULT_TOKENS_IN;
        const tokensOut = this.config.estimatedTokensOut ?? DEFAULT_TOKENS_OUT;
        const previewUrl = raw.latestVersion?.demoUrl ?? raw.webUrl;

        return {
            kind: spec.outputKind,
            files,
            previewUrl,
            costUsd: computeV0Cost(this.config.tier, tokensIn, tokensOut),
            tokensIn,
            tokensOut,
            provider: PROVIDER_NAME,
            durationMs: Date.now() - start,
        };
    }
}
