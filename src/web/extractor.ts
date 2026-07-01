/**
 * KageOps Web Extractor (firecrawl-inspired)
 *
 * Scrape a URL, then ask the configured AI to distil the page into a
 * user-supplied JSON schema. Uses the existing multi-provider adapter so
 * it picks up whatever preset the user has active (claude-cli, ollama,
 * openrouter, etc.). First iteration always uses the sensei model.
 *
 * The returned object is typed as `unknown` at the public boundary because
 * we cannot trust the LLM to exactly match the schema. A best-effort shape
 * validator (`validateAgainstSchema`) runs after parsing; callers are still
 * responsible for type-narrowing downstream.
 */

import { sendPrompt } from '../agents/ai-adapter';
import { getAgentModelConfig, loadAgentConfig } from '../agents/agent-config';
import { createLogger } from '../shared/logger';
import { scrape, ScrapeOptions, ScrapeResult } from './scraper';

const log = createLogger('WebExtractor');

// ── Types ────────────────────────────────────────────

export interface JsonSchema {
    readonly type?: string;
    readonly properties?: Record<string, JsonSchema>;
    readonly items?: JsonSchema;
    readonly required?: readonly string[];
    readonly description?: string;
    readonly enum?: readonly unknown[];
    // Allow arbitrary schema vocabulary without `any`.
    readonly [key: string]: unknown;
}

export interface ExtractOptions {
    readonly scrape?: ScrapeOptions;
    /** Override the agent whose model config is used (defaults to 'sensei'). */
    readonly agent?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    /** Character cap on the scraped markdown passed to the model. */
    readonly maxInputChars?: number;
}

export interface ExtractResult {
    readonly url: string;
    readonly data: unknown;
    readonly model: string;
    readonly cacheHit: boolean;
    readonly validationErrors: readonly string[];
    readonly scrape: ScrapeResult;
}

const DEFAULT_MAX_INPUT_CHARS = 12_000;

// ── Public API ───────────────────────────────────────

/**
 * Scrape `url` and ask the AI to extract a JSON object matching `schema`.
 *
 * Pipeline:
 *   1. scrape(url) — cached or live fetch.
 *   2. Build a tight prompt (markdown body + schema + instructions).
 *   3. Call sendPrompt with the sensei model.
 *   4. Parse and validate the JSON.
 */
export async function extract(
    url: string,
    schema: JsonSchema,
    opts: ExtractOptions = {},
): Promise<ExtractResult> {
    const scrapeResult = await scrape(url, opts.scrape ?? {});

    const agentName = opts.agent ?? 'sensei';
    const config = loadAgentConfig();
    const modelConfig = getAgentModelConfig(config, agentName);

    const maxInputChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    const body = scrapeResult.markdown.length > 0
        ? scrapeResult.markdown
        : scrapeResult.html;
    const trimmed = body.length > maxInputChars
        ? `${body.slice(0, maxInputChars)}\n\n[...truncated ${body.length - maxInputChars} chars]`
        : body;

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(url, scrapeResult, schema, trimmed);

    const response = await sendPrompt(modelConfig.model, systemPrompt, userPrompt, {
        temperature: opts.temperature ?? 0.1,
        maxTokens: opts.maxTokens ?? modelConfig.maxTokens ?? 2048,
    });

    const parsed = parseJsonResponse(response.text);
    const validationErrors = parsed === null
        ? ['failed to parse JSON from model response']
        : validateAgainstSchema(parsed, schema);

    if (validationErrors.length > 0) {
        log.warn({ url, validationErrors, model: response.model }, 'extractor validation warnings');
    }

    return {
        url,
        data: parsed,
        model: response.model,
        cacheHit: scrapeResult.cacheHit,
        validationErrors: Object.freeze(validationErrors),
        scrape: scrapeResult,
    };
}

// ── Prompt building ──────────────────────────────────

function buildSystemPrompt(): string {
    return [
        'You are a precise web data extractor.',
        'Read the user-provided web page content and return ONE JSON value that exactly satisfies the given schema.',
        'Rules:',
        '- Output ONLY the JSON value. No prose, no markdown fences, no comments.',
        '- Use null for fields that are genuinely unknown from the page.',
        '- Never fabricate facts that are not supported by the page content.',
        '- Preserve URLs as absolute links when the page provides them absolute.',
    ].join('\n');
}

function buildUserPrompt(
    url: string,
    scrapeResult: ScrapeResult,
    schema: JsonSchema,
    body: string,
): string {
    const metaLines: string[] = [`URL: ${url}`];
    if (scrapeResult.metadata.title !== null) metaLines.push(`Title: ${scrapeResult.metadata.title}`);
    if (scrapeResult.metadata.description !== null) metaLines.push(`Description: ${scrapeResult.metadata.description}`);

    return [
        metaLines.join('\n'),
        '',
        '--- PAGE CONTENT (markdown) ---',
        body,
        '--- END PAGE CONTENT ---',
        '',
        'Target JSON schema:',
        JSON.stringify(schema, null, 2),
        '',
        'Return the JSON value now.',
    ].join('\n');
}

// ── Response parsing ─────────────────────────────────

export function parseJsonResponse(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;

    // Strip markdown fences if the model ignored instructions.
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const candidate = fenceMatch !== null ? fenceMatch[1] : trimmed;

    try {
        return JSON.parse(candidate);
    } catch {
        // Last-resort: grab the first {...} or [...] slice.
        const slice = extractJsonSlice(candidate);
        if (slice === null) return null;
        try {
            return JSON.parse(slice);
        } catch {
            return null;
        }
    }
}

function extractJsonSlice(text: string): string | null {
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    const candidates: number[] = [firstObj, firstArr].filter((n) => n >= 0);
    if (candidates.length === 0) return null;
    const start = Math.min(...candidates);
    const lastObj = text.lastIndexOf('}');
    const lastArr = text.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    if (end <= start) return null;
    return text.slice(start, end + 1);
}

// ── Schema validation (minimal) ──────────────────────

export function validateAgainstSchema(value: unknown, schema: JsonSchema): readonly string[] {
    const errors: string[] = [];
    validate(value, schema, '$', errors);
    return errors;
}

function validate(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
    const type = schema.type;
    if (typeof type === 'string') {
        if (!matchesType(value, type)) {
            errors.push(`${path}: expected ${type}, got ${describe(value)}`);
            return;
        }
    }

    if (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const required = schema.required ?? [];
        for (const key of required) {
            if (!(key in obj)) errors.push(`${path}.${key}: missing required property`);
        }
        const props = schema.properties ?? {};
        for (const [key, childSchema] of Object.entries(props)) {
            if (key in obj) {
                validate(obj[key], childSchema, `${path}.${key}`, errors);
            }
        }
    }

    if (type === 'array' && Array.isArray(value) && schema.items !== undefined) {
        value.forEach((item, idx) => {
            validate(item, schema.items as JsonSchema, `${path}[${idx}]`, errors);
        });
    }
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'string':  return typeof value === 'string';
        case 'number':  return typeof value === 'number' && Number.isFinite(value);
        case 'integer': return typeof value === 'number' && Number.isInteger(value);
        case 'boolean': return typeof value === 'boolean';
        case 'array':   return Array.isArray(value);
        case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
        case 'null':    return value === null;
        default:        return true;
    }
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}
