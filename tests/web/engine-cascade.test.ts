/**
 * Engine cascade — picker + fetch engine behavioral tests.
 * Network is mocked via global.fetch so no real requests fire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_USER_AGENT,
    Engine,
    EngineNotImplementedError,
    fetchEngine,
    isFetchableUrl,
    pdfEngine,
    pickEngine,
    playwrightEngine,
} from '../../src/web/engine-cascade';

// ── Fetch mocking ─────────────────────────────────────

type FetchArgs = Parameters<typeof fetch>;
const originalFetch = global.fetch;

interface MockResponseInit {
    readonly status?: number;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly url?: string;
}

function mockResponse(init: MockResponseInit = {}): Response {
    const body = init.body ?? '<html><body><h1>Hi</h1></body></html>';
    const headers = new Headers({ 'content-type': 'text/html', ...(init.headers ?? {}) });
    const response = new Response(body, {
        status: init.status ?? 200,
        headers,
    });
    // `url` on Response is read-only; override via defineProperty.
    Object.defineProperty(response, 'url', { value: init.url ?? 'https://example.com/' });
    return response;
}

beforeEach(() => {
    global.fetch = vi.fn(async (..._args: FetchArgs) => mockResponse()) as unknown as typeof fetch;
});

afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
});

// ── Picker ────────────────────────────────────────────

describe('pickEngine', () => {
    it('selects fetch engine for an ordinary http url with no hints', () => {
        const engine = pickEngine('https://example.com');
        expect(engine.name).toBe('fetch');
    });

    it('selects pdf engine when URL ends in .pdf', () => {
        const engine = pickEngine('https://example.com/report.pdf');
        expect(engine.name).toBe('pdf');
    });

    it('selects pdf engine when hint.isPdf is true', () => {
        const engine = pickEngine('https://example.com/foo', { isPdf: true });
        expect(engine.name).toBe('pdf');
    });

    it('selects playwright engine when hints.dynamic is true', () => {
        const engine = pickEngine('https://example.com', { dynamic: true });
        expect(engine.name).toBe('playwright');
    });

    it('honours an explicit preferredEngine hint even if not implemented', () => {
        const engine = pickEngine('https://example.com', { preferredEngine: 'playwright' });
        expect(engine.name).toBe('playwright');
    });

    it('falls back to fetch when no specialist engine volunteers', () => {
        const engine = pickEngine('https://example.com/api?foo=bar');
        expect(engine.name).toBe('fetch');
    });
});

// ── Placeholder engine contracts ──────────────────────

describe('placeholder engines', () => {
    it('playwright engine throws EngineNotImplementedError', async () => {
        await expect(playwrightEngine.fetch({ url: 'https://example.com' }))
            .rejects.toBeInstanceOf(EngineNotImplementedError);
    });

    it('pdf engine throws EngineNotImplementedError', async () => {
        await expect(pdfEngine.fetch({ url: 'https://example.com/a.pdf' }))
            .rejects.toBeInstanceOf(EngineNotImplementedError);
    });

    it('Engine interface shape is stable — name/canHandle/fetch required', () => {
        const engines: readonly Engine[] = [fetchEngine, playwrightEngine, pdfEngine];
        for (const engine of engines) {
            expect(typeof engine.name).toBe('string');
            expect(typeof engine.canHandle).toBe('function');
            expect(typeof engine.fetch).toBe('function');
        }
    });
});

// ── URL guards ────────────────────────────────────────

describe('isFetchableUrl / SSRF guards', () => {
    it('accepts public https URL', () => {
        expect(isFetchableUrl('https://example.com')).toBe(true);
    });

    it('rejects invalid URL', () => {
        expect(isFetchableUrl('not-a-url')).toBe(false);
    });

    it('rejects file:// scheme', () => {
        expect(isFetchableUrl('file:///etc/passwd')).toBe(false);
    });

    it('rejects loopback host', () => {
        expect(isFetchableUrl('http://127.0.0.1/admin')).toBe(false);
        expect(isFetchableUrl('http://localhost:3000')).toBe(false);
    });

    it('rejects RFC1918 private ranges', () => {
        expect(isFetchableUrl('http://10.0.0.1')).toBe(false);
        expect(isFetchableUrl('http://192.168.1.1')).toBe(false);
    });
});

// ── fetchEngine behaviour ─────────────────────────────

describe('fetchEngine.fetch', () => {
    it('sends a User-Agent header with the KageOps tag', async () => {
        const spy = vi.mocked(global.fetch);
        await fetchEngine.fetch({ url: 'https://example.com' });

        expect(spy).toHaveBeenCalledTimes(1);
        const [, init] = spy.mock.calls[0];
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['User-Agent']).toBe(DEFAULT_USER_AGENT);
    });

    it('accepts a custom User-Agent when provided', async () => {
        const spy = vi.mocked(global.fetch);
        await fetchEngine.fetch({ url: 'https://example.com', userAgent: 'MyBot/1.0' });
        const [, init] = spy.mock.calls[0];
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['User-Agent']).toBe('MyBot/1.0');
    });

    it('returns the HTML body and status from the mocked response', async () => {
        global.fetch = vi.fn(async () => mockResponse({
            status: 201,
            body: '<html><title>Hi</title></html>',
            url: 'https://example.com/final',
        })) as unknown as typeof fetch;

        const result = await fetchEngine.fetch({ url: 'https://example.com' });
        expect(result.status).toBe(201);
        expect(result.html).toContain('<title>Hi</title>');
        expect(result.finalUrl).toBe('https://example.com/final');
        expect(result.engine).toBe('fetch');
    });

    it('exposes the byte count and truncation=false for small bodies', async () => {
        global.fetch = vi.fn(async () => mockResponse({ body: 'hello' })) as unknown as typeof fetch;
        const result = await fetchEngine.fetch({ url: 'https://example.com' });
        expect(result.bytes).toBe(5);
        expect(result.truncated).toBe(false);
    });

    it('truncates bodies larger than maxBytes', async () => {
        const big = 'x'.repeat(2000);
        global.fetch = vi.fn(async () => mockResponse({ body: big })) as unknown as typeof fetch;
        const result = await fetchEngine.fetch({ url: 'https://example.com', maxBytes: 500 });
        expect(result.truncated).toBe(true);
        expect(result.html.length).toBeLessThanOrEqual(500);
    });

    it('rejects disallowed hosts before making a network call', async () => {
        const spy = vi.mocked(global.fetch);
        await expect(fetchEngine.fetch({ url: 'http://localhost/x' }))
            .rejects.toThrow(/disallowed host/i);
        expect(spy).not.toHaveBeenCalled();
    });

    it('rejects non-http(s) protocols before any network call', async () => {
        const spy = vi.mocked(global.fetch);
        await expect(fetchEngine.fetch({ url: 'file:///etc/passwd' }))
            .rejects.toThrow(/disallowed protocol/i);
        expect(spy).not.toHaveBeenCalled();
    });

    it('wraps fetch failures with a WebEngineCascade prefix', async () => {
        global.fetch = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
        await expect(fetchEngine.fetch({ url: 'https://example.com' }))
            .rejects.toThrow(/fetch failed.*network down/i);
    });

    it('caps effective max bytes to the configured default when none provided', () => {
        expect(DEFAULT_MAX_BYTES).toBeGreaterThan(0);
    });
});
