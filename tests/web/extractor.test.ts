/**
 * Web extractor — scrape → AI → JSON pipeline tests.
 * Both the scraper and the ai-adapter are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── scraper mock ──────────────────────────────────────

const mockScrape = vi.fn();

vi.mock('../../src/web/scraper', () => ({
    scrape: (...args: unknown[]) => mockScrape(...args),
}));

// ── ai-adapter mock ───────────────────────────────────

const mockSendPrompt = vi.fn();

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: (...args: unknown[]) => mockSendPrompt(...args),
}));

// ── agent-config mock (deterministic model selection) ─

vi.mock('../../src/agents/agent-config', () => ({
    loadAgentConfig: vi.fn(() => ({
        defaults: { model: 'mock/model', temperature: 0.1, maxTokens: 2048 },
        agents: {
            sensei: { model: 'mock/sensei-model', temperature: 0.1, maxTokens: 4096 },
        },
    })),
    getAgentModelConfig: vi.fn((_cfg: unknown, name: string) => ({
        model: name === 'sensei' ? 'mock/sensei-model' : `mock/${name}-model`,
        temperature: 0.1,
        maxTokens: 2048,
    })),
}));

// ── Imports after mocks ───────────────────────────────

import {
    extract,
    parseJsonResponse,
    validateAgainstSchema,
    JsonSchema,
} from '../../src/web/extractor';

// ── Fixtures ──────────────────────────────────────────

function mockScrapeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        url: 'https://example.com',
        markdown: '# Title\n\nHello world',
        html: '<html><body><h1>Title</h1></body></html>',
        links: [],
        metadata: {
            title: 'Title',
            description: 'desc',
            contentType: 'text/html',
            bytes: 100,
            status: 200,
            finalUrl: 'https://example.com',
            truncated: false,
        },
        engine: 'fetch',
        cacheHit: false,
        ...overrides,
    };
}

function mockAiResponse(text: string): Record<string, unknown> {
    return {
        text,
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.0001,
        model: 'mock/sensei-model',
        durationMs: 120,
    };
}

beforeEach(() => {
    mockScrape.mockReset();
    mockSendPrompt.mockReset();
});

// ── parseJsonResponse ────────────────────────────────

describe('parseJsonResponse', () => {
    it('parses plain JSON', () => {
        expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
    });

    it('strips ```json fences', () => {
        expect(parseJsonResponse('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    });

    it('strips plain ``` fences', () => {
        expect(parseJsonResponse('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
    });

    it('returns null for garbage', () => {
        expect(parseJsonResponse('not json at all')).toBe(null);
    });

    it('recovers a JSON slice when prose wraps the response', () => {
        const text = 'Sure, here you go: {"ok":true} cheers';
        expect(parseJsonResponse(text)).toEqual({ ok: true });
    });
});

// ── validateAgainstSchema ────────────────────────────

describe('validateAgainstSchema', () => {
    const schema: JsonSchema = {
        type: 'object',
        required: ['name', 'score'],
        properties: {
            name: { type: 'string' },
            score: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
        },
    };

    it('returns no errors for a valid object', () => {
        const errors = validateAgainstSchema({ name: 'x', score: 1, tags: ['a'] }, schema);
        expect(errors).toEqual([]);
    });

    it('flags missing required properties', () => {
        const errors = validateAgainstSchema({ name: 'x' }, schema);
        expect(errors.join('|')).toMatch(/score.*missing required property/);
    });

    it('flags wrong primitive types', () => {
        const errors = validateAgainstSchema({ name: 1, score: 'nope' }, schema);
        expect(errors.some((e) => /\$\.name.*expected string/.test(e))).toBe(true);
        expect(errors.some((e) => /\$\.score.*expected number/.test(e))).toBe(true);
    });

    it('recurses into array item schemas', () => {
        const errors = validateAgainstSchema({ name: 'x', score: 1, tags: ['a', 42] }, schema);
        expect(errors.some((e) => /tags\[1\].*expected string/.test(e))).toBe(true);
    });
});

// ── extract() end-to-end ──────────────────────────────

describe('extract', () => {
    it('scrapes, calls sendPrompt with the sensei model, and returns parsed data', async () => {
        mockScrape.mockResolvedValue(mockScrapeResult());
        mockSendPrompt.mockResolvedValue(mockAiResponse('{"headline":"Hello"}'));

        const schema: JsonSchema = {
            type: 'object',
            required: ['headline'],
            properties: { headline: { type: 'string' } },
        };

        const result = await extract('https://example.com', schema);

        expect(mockScrape).toHaveBeenCalledWith('https://example.com', {});
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        const [model, system, user] = mockSendPrompt.mock.calls[0];
        expect(model).toBe('mock/sensei-model');
        expect(String(system)).toMatch(/precise web data extractor/i);
        expect(String(user)).toContain('https://example.com');
        expect(String(user)).toContain('PAGE CONTENT');

        expect(result.data).toEqual({ headline: 'Hello' });
        expect(result.validationErrors).toEqual([]);
        expect(result.cacheHit).toBe(false);
        expect(result.model).toBe('mock/sensei-model');
    });

    it('passes through cacheHit from the scrape result', async () => {
        mockScrape.mockResolvedValue(mockScrapeResult({ cacheHit: true }));
        mockSendPrompt.mockResolvedValue(mockAiResponse('{"headline":"Hi"}'));

        const schema: JsonSchema = {
            type: 'object',
            properties: { headline: { type: 'string' } },
        };
        const result = await extract('https://example.com', schema);
        expect(result.cacheHit).toBe(true);
    });

    it('reports validation errors when the model returns a mismatched shape', async () => {
        mockScrape.mockResolvedValue(mockScrapeResult());
        mockSendPrompt.mockResolvedValue(mockAiResponse('{"headline":42}'));

        const schema: JsonSchema = {
            type: 'object',
            required: ['headline'],
            properties: { headline: { type: 'string' } },
        };

        const result = await extract('https://example.com', schema);
        expect(result.data).toEqual({ headline: 42 });
        expect(result.validationErrors.length).toBeGreaterThan(0);
        expect(result.validationErrors.some((e) => /headline.*expected string/.test(e))).toBe(true);
    });

    it('reports a JSON parse error when the model returns prose', async () => {
        mockScrape.mockResolvedValue(mockScrapeResult());
        mockSendPrompt.mockResolvedValue(mockAiResponse('sorry, I cannot help with that'));

        const schema: JsonSchema = { type: 'object' };
        const result = await extract('https://example.com', schema);
        expect(result.data).toBe(null);
        expect(result.validationErrors.some((e) => /failed to parse JSON/.test(e))).toBe(true);
    });

    it('truncates very long bodies before sending to the model', async () => {
        const longBody = 'x'.repeat(50_000);
        mockScrape.mockResolvedValue(mockScrapeResult({ markdown: longBody }));
        mockSendPrompt.mockResolvedValue(mockAiResponse('{"ok":true}'));

        const schema: JsonSchema = { type: 'object' };
        await extract('https://example.com', schema, { maxInputChars: 500 });

        const [, , userPrompt] = mockSendPrompt.mock.calls[0];
        expect(String(userPrompt)).toMatch(/\[\.\.\.truncated/);
    });

    it('uses an override agent name when provided', async () => {
        mockScrape.mockResolvedValue(mockScrapeResult());
        mockSendPrompt.mockResolvedValue(mockAiResponse('{"ok":true}'));

        const schema: JsonSchema = { type: 'object' };
        await extract('https://example.com', schema, { agent: 'scout' });

        const [model] = mockSendPrompt.mock.calls[0];
        expect(model).toBe('mock/scout-model');
    });
});
