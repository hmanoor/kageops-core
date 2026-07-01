/**
 * Web scraper — cache hit/miss + engine orchestration tests.
 *
 * The db/client and engine-cascade modules are mocked so we never touch the
 * database or the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── db/client mock ────────────────────────────────────

const { mockGetOne, mockQuery, mockFetchEngineFetch } = vi.hoisted(() => ({
    mockGetOne: vi.fn(),
    mockQuery: vi.fn(),
    mockFetchEngineFetch: vi.fn(),
}));

vi.mock('../../src/db/client', () => ({
    getOne: (...args: unknown[]) => mockGetOne(...args),
    query: (...args: unknown[]) => mockQuery(...args),
}));

// ── engine-cascade mock ───────────────────────────────
// Provide a controllable mock engine but keep the real helpers (pickEngine,
// fetchEngine) importable by callers that need them.

vi.mock('../../src/web/engine-cascade', async () => {
    const actual = await vi.importActual<typeof import('../../src/web/engine-cascade')>(
        '../../src/web/engine-cascade',
    );
    const fakeFetchEngine = {
        name: 'fetch' as const,
        canHandle: () => true,
        fetch: mockFetchEngineFetch,
    };
    return {
        ...actual,
        fetchEngine: fakeFetchEngine,
        pickEngine: vi.fn(() => fakeFetchEngine),
    };
});

// ── Imports after mocks ───────────────────────────────

import { scrape } from '../../src/web/scraper';

// ── Fixtures ──────────────────────────────────────────

const FRESH_HTML = '<html><head><title>Fresh</title><meta name="description" content="A page"></head>'
    + '<body><h1>Hi</h1><p>Hello <a href="/x">link</a></p></body></html>';

function mockEngineResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        status: 200,
        contentType: 'text/html',
        bytes: FRESH_HTML.length,
        html: FRESH_HTML,
        engine: 'fetch',
        truncated: false,
        headers: {},
        ...overrides,
    };
}

beforeEach(() => {
    mockGetOne.mockReset();
    mockQuery.mockReset();
    mockFetchEngineFetch.mockReset();
});

// ── Tests ─────────────────────────────────────────────

describe('scrape — cache miss', () => {
    it('returns cacheHit=false when no fresh row exists', async () => {
        mockGetOne.mockResolvedValue(null);
        mockFetchEngineFetch.mockResolvedValue(mockEngineResponse());
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        const result = await scrape('https://example.com');

        expect(result.cacheHit).toBe(false);
        expect(result.markdown).toContain('# Hi');
        expect(result.markdown).toContain('Hello');
        expect(result.metadata.title).toBe('Fresh');
        expect(result.metadata.description).toBe('A page');
    });

    it('persists the scrape to web_scrapes on miss', async () => {
        mockGetOne.mockResolvedValue(null);
        mockFetchEngineFetch.mockResolvedValue(mockEngineResponse());
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        await scrape('https://example.com');

        expect(mockQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(String(sql)).toMatch(/INSERT INTO web_scrapes/i);
        expect((params as unknown[])[0]).toBe('https://example.com');
        // params: url, markdown, html, metadata(JSON), engine, status
        expect((params as unknown[])[4]).toBe('fetch');
        expect((params as unknown[])[5]).toBe('ok');
    });

    it('extracts links from the HTML', async () => {
        mockGetOne.mockResolvedValue(null);
        mockFetchEngineFetch.mockResolvedValue(mockEngineResponse());
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        const result = await scrape('https://example.com');
        expect(result.links.length).toBe(1);
        expect(result.links[0].href).toBe('/x');
        expect(result.links[0].text).toBe('link');
    });
});

describe('scrape — cache hit', () => {
    it('returns cacheHit=true and skips the engine entirely', async () => {
        mockGetOne.mockResolvedValue({
            id: 'row-1',
            url: 'https://example.com',
            markdown: '# cached',
            html: FRESH_HTML,
            metadata: JSON.stringify({
                title: 'Cached',
                description: null,
                contentType: 'text/html',
                bytes: 42,
                status: 200,
                finalUrl: 'https://example.com',
                truncated: false,
            }),
            engine_used: 'fetch',
            status: 'ok',
        });

        const result = await scrape('https://example.com');

        expect(result.cacheHit).toBe(true);
        expect(result.markdown).toBe('# cached');
        expect(result.metadata.title).toBe('Cached');
        expect(mockFetchEngineFetch).not.toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('treats object metadata (non-stringified) as valid on cache hit', async () => {
        mockGetOne.mockResolvedValue({
            id: 'row-2',
            url: 'https://example.com',
            markdown: '# cached2',
            html: '<html></html>',
            metadata: { title: 'Obj', contentType: 'text/html', bytes: 1, status: 200, finalUrl: 'x', truncated: false },
            engine_used: 'fetch',
            status: 'ok',
        });

        const result = await scrape('https://example.com');
        expect(result.cacheHit).toBe(true);
        expect(result.metadata.title).toBe('Obj');
    });

    it('bypasses cache when forceRefresh=true', async () => {
        mockGetOne.mockResolvedValue({ /* never consulted */ });
        mockFetchEngineFetch.mockResolvedValue(mockEngineResponse());
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        const result = await scrape('https://example.com', { forceRefresh: true });
        expect(result.cacheHit).toBe(false);
        expect(mockGetOne).not.toHaveBeenCalled();
        expect(mockFetchEngineFetch).toHaveBeenCalledTimes(1);
    });
});

describe('scrape — error handling', () => {
    it('persists an error row and rethrows when the fetch engine fails', async () => {
        mockGetOne.mockResolvedValue(null);
        mockFetchEngineFetch.mockRejectedValue(new Error('boom'));
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        await expect(scrape('https://example.com')).rejects.toThrow(/boom/);

        // Error persisted with status='error'
        const [, params] = mockQuery.mock.calls[0];
        expect((params as unknown[])[5]).toBe('error');
    });

    it('treats a db read failure as a cache miss rather than crashing', async () => {
        mockGetOne.mockRejectedValue(new Error('db down'));
        mockFetchEngineFetch.mockResolvedValue(mockEngineResponse());
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        const result = await scrape('https://example.com');
        expect(result.cacheHit).toBe(false);
        expect(mockFetchEngineFetch).toHaveBeenCalledTimes(1);
    });
});

describe('scrape — SQL shape', () => {
    it('reads with url + expires_at + status filters', async () => {
        mockGetOne.mockResolvedValue(null);
        mockFetchEngineFetch.mockResolvedValue(mockEngineResponse());
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

        await scrape('https://example.com');

        const [sql, params] = mockGetOne.mock.calls[0];
        expect(String(sql)).toMatch(/FROM web_scrapes/i);
        expect(String(sql)).toMatch(/expires_at > NOW\(\)/i);
        expect(String(sql)).toMatch(/status = 'ok'/i);
        expect((params as unknown[])[0]).toBe('https://example.com');
    });
});
