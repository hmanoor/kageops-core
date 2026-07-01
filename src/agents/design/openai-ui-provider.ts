/**
 * OpenAiUiProvider — dedicated UI-generation provider backed by OpenAI
 * GPT-5 family (or GPT-4o as a fallback).
 *
 * Mirror of ClaudeUiProvider but routed through the OpenAI API directly
 * (provider prefix `openai/`). Use this when:
 *   - You want GPT's design strengths (very strong on Tailwind/Material
 *     idioms, dense visual layouts) without the OpenRouter mark-up
 *   - OpenRouter doesn't yet carry the latest GPT-5.x revision
 *   - You have a project-scoped OPENAI_API_KEY you want to bill directly
 *
 * Default model: gpt-5.4 (best general design quality at the time of
 * writing). Override via KAGEOPS_OPENAI_UI_MODEL when GPT-5.5 / 5.3 / 4o
 * gives a better fit for the task. Set KAGEOPS_OPENAI_UI_MAX_TOKENS to
 * tune the output cap.
 *
 * Activation requires OPENAI_API_KEY in keychain or env. Without it,
 * isAvailable() returns false and the registry falls back to in-house.
 *
 * Reuses parseDesignFiles from in-house-provider — same FILE-block format.
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
import { resolveProviderApiKey } from '../ai-adapter/api-keys';

const PROVIDER_NAME = 'openai-ui';

/**
 * Default — GPT-5.4 routed through the OpenAI API directly. Override
 * via KAGEOPS_OPENAI_UI_MODEL when:
 *   - GPT-5.5 lands and wants to be the new default (`openai/gpt-5.5`)
 *   - You want GPT-4o as a cheaper fallback (`openai/gpt-4o`)
 *   - You want o1/o1-pro for extra-careful UI work (`openai/o1`)
 *
 * Model strings ALWAYS include the `openai/` prefix so the dispatcher
 * routes through the openai adapter (api.openai.com), NOT through
 * openrouter.
 */
export const DEFAULT_OPENAI_UI_MODEL = 'openai/gpt-5.4';

export interface OpenAiUiProviderConfig {
    /** Full `provider/model` string, e.g. `openai/gpt-5.4`. */
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
    '(8) do not wrap file contents in markdown code fences — emit raw file content between the FILE markers; ' +
    '(9) HTML class names in your emitted markup MUST have matching rules in the styles.css you emit in the same response. Do not introduce orphan class names — every class on the HTML side either has a corresponding `.classname` rule in CSS, or is removed.';

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
        '--- END FILE ---',
    );
    return lines.join('\n');
}

/**
 * Extract the bare model id (after the `provider/` prefix) for cost lookup.
 */
function modelIdOnly(modelString: string): string {
    const slash = modelString.indexOf('/');
    return slash === -1 ? modelString : modelString.slice(slash + 1);
}

/**
 * GPT-5 family + GPT-4o pricing per 1M tokens (input / output).
 * Kept in sync with the table in ai-adapter/cost.ts. Used for
 * pre-flight estimates only — the real cost is reported on AiResponse.
 *
 * Numbers are placeholders for the GPT-5 line until OpenAI publishes
 * actual rates. They follow GPT-4-turbo's tier structure as a
 * conservative estimate.
 */
const OPENAI_RATES: Record<string, { readonly input: number; readonly output: number }> = {
    'gpt-5.5':     { input: 12.0, output: 36.0 },
    'gpt-5.4':     { input: 10.0, output: 30.0 },
    'gpt-5.3':     { input: 8.0,  output: 24.0 },
    'gpt-4-turbo': { input: 10.0, output: 30.0 },
    'gpt-4o':      { input: 2.5,  output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'o1':          { input: 15.0, output: 60.0 },
    'o1-mini':     { input: 3.0,  output: 12.0 },
};

const FALLBACK_RATES = { input: 5.0, output: 15.0 };

export class OpenAiUiProvider implements DesignProvider {
    readonly name = PROVIDER_NAME;
    private readonly config: Required<OpenAiUiProviderConfig>;

    constructor(config: OpenAiUiProviderConfig = {}) {
        this.config = {
            model: config.model ?? DEFAULT_OPENAI_UI_MODEL,
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 8192,
        };
    }

    async isAvailable(): Promise<boolean> {
        // Reachable iff an OpenAI API key is configured (keychain or env).
        // The model string itself is also required.
        if (this.config.model.length === 0) return false;
        const key = await resolveProviderApiKey('openai').catch(() => null);
        return key !== null && key !== '';
    }

    async estimateCost(spec: DesignSpec): Promise<CostEstimate> {
        const id = modelIdOnly(this.config.model);
        const rates = OPENAI_RATES[id] ?? FALLBACK_RATES;
        const tokensIn = Math.max(
            200,
            Math.ceil(
                (spec.title.length + spec.description.length + (spec.brief?.length ?? 0)) / 4,
            ) + 400,
        );
        const tokensOut = this.config.maxTokens;
        const usd = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;
        return {
            usd,
            confidence: OPENAI_RATES[id] !== undefined ? 'published' : 'heuristic',
        };
    }

    async generateUI(spec: DesignSpec): Promise<DesignArtifact> {
        const start = Date.now();
        let response: AiResponse;
        try {
            // GPT-5 family + o1 reject custom temperature — only the
            // default (1) is supported. Omit the param for those models
            // so the request doesn't 400 with `unsupported_value`.
            const id = modelIdOnly(this.config.model);
            const supportsTemperature = !id.startsWith('gpt-5') && !id.startsWith('o1') && !id.startsWith('o3');
            response = await sendPrompt(
                this.config.model,
                SYSTEM_PROMPT,
                buildUserPrompt(spec),
                {
                    ...(supportsTemperature ? { temperature: this.config.temperature } : {}),
                    maxTokens: this.config.maxTokens,
                },
            );
        } catch (err) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                err instanceof Error ? err.message : String(err),
                { recoverable: true, cause: err },
            );
        }

        const parsed = parseDesignFiles(response.text);
        const files =
            parsed.length > 0
                ? parsed
                : [{ path: 'designs/openai-ui.md', content: response.text }];

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
