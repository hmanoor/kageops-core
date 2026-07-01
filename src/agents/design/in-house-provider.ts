/**
 * InHouseProvider — default design provider using the local AIAdapter.
 *
 * Wraps the same LLM call Pixel has always made, but behind the
 * DesignProvider interface. Cost reporting is real (pulled from the
 * AiResponse) so budget-kill works identically whether we go in-house
 * or external.
 */

import {
    DesignProvider,
    DesignSpec,
    DesignArtifact,
    CostEstimate,
    DesignProviderError,
} from './design-provider';
import { sendPrompt, AiResponse } from '../ai-adapter';

const PROVIDER_NAME = 'in-house';

export interface InHouseProviderConfig {
    readonly model: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
}

const SYSTEM_PROMPT =
    'You are Pixel, a UX designer. Produce a single coherent UI artifact that matches the ' +
    'requested output kind. Do NOT mix scaffolds (no React + static HTML in one output). ' +
    'JavaScript is OPTIONAL — omit it unless the brief genuinely requires client-side interactivity ' +
    '(landing pages and marketing sites usually do not). If you DO emit JS: every DOM lookup MUST be ' +
    'null-guarded (use `getElementById("x")?.method(...)` or an `if (el)` check) — never call a method ' +
    'directly on the result of getElementById/querySelector. Every selector must target an ID that ' +
    'exists verbatim in the same HTML file. Wrap DOM init in `DOMContentLoaded` or place `<script>` ' +
    'at the end of `<body>`.';

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
        'Emit each file using this exact format:',
        '--- FILE: path/to/file.ext ---',
        '[file content]',
        '--- END FILE ---'
    );
    return lines.join('\n');
}

/**
 * Parse the FILE-block format back into DesignFile[]. Tolerant of
 * surrounding prose from the model.
 */
export function parseDesignFiles(output: string): readonly { path: string; content: string }[] {
    const files: { path: string; content: string }[] = [];
    const regex = /--- FILE:\s*(.+?)\s*---\n([\s\S]*?)\n--- END FILE ---/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(output)) !== null) {
        files.push({ path: m[1].trim(), content: m[2] });
    }
    return files;
}

export class InHouseProvider implements DesignProvider {
    readonly name = PROVIDER_NAME;
    private readonly config: InHouseProviderConfig;

    constructor(config: InHouseProviderConfig) {
        this.config = config;
    }

    async isAvailable(): Promise<boolean> {
        // The local AIAdapter is always available as long as a model is configured.
        return this.config.model.length > 0;
    }

    async estimateCost(_spec: DesignSpec): Promise<CostEstimate> {
        // Heuristic: typical design task ~8k tokens in + ~4k out on DeepSeek → ~$0.004
        // Real cost comes from the AiResponse on generate().
        return { usd: 0.01, confidence: 'heuristic' };
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
                    temperature: this.config.temperature ?? 0.7,
                    maxTokens: this.config.maxTokens ?? 4096,
                }
            );
        } catch (err) {
            throw new DesignProviderError(
                PROVIDER_NAME,
                err instanceof Error ? err.message : String(err),
                { recoverable: false, cause: err }
            );
        }

        const parsed = parseDesignFiles(response.text);
        const files =
            parsed.length > 0
                ? parsed
                : [{ path: 'designs/generated.md', content: response.text }];

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
