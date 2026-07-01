/**
 * ClaudeUiProvider — dedicated UI-generation provider backed by Claude Sonnet.
 *
 * Not affiliated with Anthropic's "Claude Design" product at claude.ai/design
 * (launched 2026-04-17, web-UI only, no public API at time of this file).
 * If/when Anthropic ships a programmatic surface for Claude Design, we can
 * add a separate provider that wraps it — this one stays as a direct-prompt
 * Sonnet wrapper.
 *
 * Different from InHouseProvider, which honors whatever model the active
 * preset has configured (often the cheapest working model). This provider
 * pins Claude Sonnet regardless of preset, so UI quality stays high even
 * when the rest of the pipeline runs on a budget tier. Pricing is published
 * ($3/M in, $15/M out) so it is budget-kill compatible without the
 * KAGEOPS_ALLOW_UNPRICED_DESIGN override.
 *
 * Reuses parseDesignFiles from in-house-provider — both speak the same
 * `--- FILE: ... ---` block format.
 */

import {
    DesignProvider,
    DesignSpec,
    DesignArtifact,
    CostEstimate,
    DesignProviderError,
} from './design-provider';
import { parseDesignFiles } from './in-house-provider';
import { sendPrompt, AiResponse } from '../ai-adapter';

const PROVIDER_NAME = 'claude-ui';

/**
 * Default — Opus 4.7 routed through the Claude.ai subscription via the
 * claude-cli adapter. Zero per-call cost, top design quality. Override
 * via KAGEOPS_CLAUDE_UI_MODEL when:
 *   - Sonnet 4.6 is enough and you want speed (`claude-cli/claude-sonnet-4-6`)
 *   - You want to use the Anthropic API directly (`claude/claude-opus-4-...`)
 *   - Anthropic ships a newer Opus
 */
export const DEFAULT_CLAUDE_UI_MODEL = 'claude-cli/claude-opus-4-7';

export interface ClaudeUiProviderConfig {
    /** Full `provider/model` string, e.g. `claude/claude-sonnet-4-6`. */
    readonly model?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
}

const SYSTEM_PROMPT =
    'You are a senior UX engineer specialising in production-ready UI artifacts. ' +
    'Produce a single coherent UI for the requested output kind (no mixed scaffolds). ' +
    'Constraints that are non-negotiable: ' +
    '(1) semantic HTML — use header/main/nav/section/article/footer where appropriate; ' +
    '(2) accessibility — every interactive element has a visible label, every form field has an associated <label>, colour contrast meets WCAG AA; ' +
    '(3) responsive by default — layouts must work from 360px up without horizontal scroll; ' +
    '(4) if the brief lists required element IDs, every one of them MUST appear verbatim in the emitted HTML; ' +
    '(5) JavaScript is OPTIONAL — only include it if the brief genuinely requires client-side interactivity. A landing page or marketing site usually does NOT. When in doubt, omit JS entirely; ' +
    '(6) if you DO emit JS, it must not throw on page load. Every DOM lookup MUST be null-guarded: use `document.getElementById(...)?.addEventListener(...)` or `const el = document.getElementById("x"); if (el) { ... }`. NEVER call a method directly on the result of getElementById/querySelector without a null check. Every selector must target an ID that exists verbatim in the same HTML file; ' +
    '(7) wrap DOM initialisation in `DOMContentLoaded` or place `<script>` at the end of `<body>` so elements are in the DOM before the code runs; ' +
    '(8) do not wrap file contents in markdown code fences — emit raw file content between the FILE markers.';

function buildUserPrompt(spec: DesignSpec): string {
    const lines: string[] = [
        `Project: ${spec.title}`,
        `Description: ${spec.description}`,
        `Output kind: ${spec.outputKind}`,
    ];
    if (spec.brief !== undefined && spec.brief.length > 0) {
        lines.push('', 'Design brief:', spec.brief);
    }
    lines.push(
        '',
        'Emit each file using this exact format (no markdown fences, no prose inside the block):',
        '--- FILE: path/to/file.ext ---',
        '[raw file content]',
        '--- END FILE ---'
    );
    return lines.join('\n');
}

/**
 * Extract the bare model id (after the `provider/` prefix) for cost lookup.
 * Returns the input unchanged when no `/` is present.
 */
function modelIdOnly(modelString: string): string {
    const slash = modelString.indexOf('/');
    return slash === -1 ? modelString : modelString.slice(slash + 1);
}

/**
 * Published Sonnet pricing: $3/M input, $15/M output. Kept in sync with
 * the table in ai-adapter/cost.ts. Used for pre-flight estimates only —
 * the real cost comes back on AiResponse.
 */
const SONNET_INPUT_PER_M = 3.0;
const SONNET_OUTPUT_PER_M = 15.0;

export class ClaudeUiProvider implements DesignProvider {
    readonly name = PROVIDER_NAME;
    private readonly config: Required<ClaudeUiProviderConfig>;

    constructor(config: ClaudeUiProviderConfig = {}) {
        this.config = {
            model: config.model ?? DEFAULT_CLAUDE_UI_MODEL,
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 8192,
        };
    }

    async isAvailable(): Promise<boolean> {
        // Sonnet is reachable via either the direct Anthropic key or the
        // OpenRouter passthrough. Both are configured via env elsewhere;
        // here we only need the model string to be non-empty.
        return this.config.model.length > 0;
    }

    async estimateCost(spec: DesignSpec): Promise<CostEstimate> {
        // Only apply Sonnet pricing when we know the configured model is a
        // Sonnet variant. If the operator swapped in a non-Sonnet model we
        // fall back to heuristic — a cheap way to avoid misreporting.
        const id = modelIdOnly(this.config.model);
        const isSonnet = id.toLowerCase().includes('sonnet');

        if (!isSonnet) {
            return { usd: 0.04, confidence: 'heuristic' };
        }

        const tokensIn = Math.max(200, Math.ceil((spec.title.length + spec.description.length + (spec.brief?.length ?? 0)) / 4) + 400);
        const tokensOut = this.config.maxTokens;
        const usd =
            (tokensIn * SONNET_INPUT_PER_M + tokensOut * SONNET_OUTPUT_PER_M) /
            1_000_000;
        return { usd, confidence: 'published' };
    }

    async generateUI(spec: DesignSpec): Promise<DesignArtifact> {
        const start = Date.now();
        let response: AiResponse;
        try {
            response = await sendPrompt(
                this.config.model,
                SYSTEM_PROMPT,
                buildUserPrompt(spec),
                {
                    temperature: this.config.temperature,
                    maxTokens: this.config.maxTokens,
                }
            );
        } catch (err) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                err instanceof Error ? err.message : String(err),
                { recoverable: true, cause: err }
            );
        }

        const parsed = parseDesignFiles(response.text);
        const files =
            parsed.length > 0
                ? parsed
                : [{ path: 'designs/claude-ui.md', content: response.text }];

        return {
            kind: spec.outputKind,
            files,
            costUsd: response.costUsd,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            provider: PROVIDER_NAME,
            durationMs: Date.now() - start,
        };
    }
}
