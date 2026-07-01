/**
 * P2-05 — AcceptanceGate v2 (`build-tests-preview` kind) tests.
 *
 * Covers:
 *   - bundleHint with kind='build-tests-preview' routes to verifyBuildTestsPreview
 *   - missing preview URL surfaces as preview-url-missing violation
 *   - HTTP 200 on `/` + preview_routes → passed
 *   - Non-200 status on any route → violation
 *   - Network error → preview-url-unreachable violation
 *   - HEAD 405/501 → falls back to GET
 *   - joinUrl helper handles absolute and relative routes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMockEventBus } from '../helpers/mock-event-bus';

import { AcceptanceGate, joinUrl } from '../../src/orchestrator/acceptance-gate';

function mkFetchOk(status: number): typeof globalThis.fetch {
    return vi.fn(async () =>
        new Response(null, { status })
    ) as unknown as typeof globalThis.fetch;
}

function mkFetchRoutes(
    map: Readonly<Record<string, number>>
): typeof globalThis.fetch {
    return vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        const status = map[u] ?? 404;
        return new Response(null, { status });
    }) as unknown as typeof globalThis.fetch;
}

function mkFetchThrows(message: string): typeof globalThis.fetch {
    return vi.fn(async () => {
        throw new Error(message);
    }) as unknown as typeof globalThis.fetch;
}

describe('joinUrl()', () => {
    it('combines a base + relative route', () => {
        expect(joinUrl('https://x.vercel.app', '/sign-in')).toBe('https://x.vercel.app/sign-in');
    });

    it('strips trailing slash on base before appending', () => {
        expect(joinUrl('https://x.vercel.app/', '/sign-in')).toBe('https://x.vercel.app/sign-in');
    });

    it('prefixes a missing leading slash on the route', () => {
        expect(joinUrl('https://x.vercel.app', 'sign-in')).toBe('https://x.vercel.app/sign-in');
    });

    it('returns the route verbatim when it is already absolute', () => {
        expect(joinUrl('https://x.vercel.app', 'https://other.app/y')).toBe('https://other.app/y');
    });
});

describe('AcceptanceGate.verify() — build-tests-preview dispatch', () => {
    let gate: AcceptanceGate;
    let eventBus: ReturnType<typeof createMockEventBus>;
    // Isolated EMPTY repo dir. The build-tests-preview path runs a source-level
    // fabrication/slice audit over repoPath; a shared dir (e.g. /tmp) would let
    // unrelated files trip 'unreplaced-template'. A fresh mkdtemp dir keeps these
    // tests deterministic across machines and CI.
    let repoDir: string;

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new AcceptanceGate(eventBus as never);
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-ag2-'));
    });

    afterEach(() => {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('returns preview-url-missing when bundleHint.kind=build-tests-preview but previewUrl is undefined', async () => {
        const result = await gate.verify('proj-1', repoDir, 'unused', {
            kind: 'build-tests-preview',
        });

        expect(result.passed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.check).toBe('preview-url-missing');
        expect(result.violations[0]?.severity).toBe('must');
        expect(eventBus.publish).toHaveBeenCalledWith(
            'acceptance.failed',
            expect.objectContaining({ projectId: 'proj-1' })
        );
    });

    it('passes when preview URL responds 200 on /', async () => {
        gate.setFetchOverrideForTests(mkFetchOk(200));

        const result = await gate.verify('proj-1', repoDir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://my-app-abc.vercel.app',
            previewRoutes: [],
        });

        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
        expect(result.reason).toMatch(/1 route/);
        expect(eventBus.publish).toHaveBeenCalledWith(
            'acceptance.passed',
            expect.anything()
        );
    });

    it('checks all bundle-declared preview_routes in addition to /', async () => {
        gate.setFetchOverrideForTests(
            mkFetchRoutes({
                'https://my-app.vercel.app/': 200,
                'https://my-app.vercel.app/sign-in': 200,
                'https://my-app.vercel.app/sign-up': 200,
            })
        );

        const result = await gate.verify('proj-1', repoDir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://my-app.vercel.app',
            previewRoutes: ['/sign-in', '/sign-up'],
        });

        expect(result.passed).toBe(true);
        expect(result.reason).toMatch(/3 routes/);
    });

    it('fails with preview-url-not-200 when a route returns non-200', async () => {
        gate.setFetchOverrideForTests(
            mkFetchRoutes({
                'https://my-app.vercel.app/': 200,
                'https://my-app.vercel.app/sign-in': 500,
            })
        );

        const result = await gate.verify('proj-1', repoDir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://my-app.vercel.app',
            previewRoutes: ['/sign-in'],
        });

        expect(result.passed).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.check).toBe('preview-url-not-200');
        expect(result.violations[0]?.message).toContain('500');
        expect(result.violations[0]?.message).toContain('/sign-in');
    });

    it('fails with preview-url-unreachable when fetch throws', async () => {
        gate.setFetchOverrideForTests(mkFetchThrows('ECONNREFUSED'));

        const result = await gate.verify('proj-1', repoDir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://unreachable.vercel.app',
            previewRoutes: [],
        });

        expect(result.passed).toBe(false);
        expect(result.violations[0]?.check).toBe('preview-url-unreachable');
        expect(result.violations[0]?.message).toContain('ECONNREFUSED');
    });

    it('falls back to GET when HEAD returns 405', async () => {
        const calls: string[] = [];
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            calls.push(init?.method ?? 'GET');
            if ((init?.method ?? 'GET') === 'HEAD') {
                return new Response(null, { status: 405 });
            }
            return new Response(null, { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        gate.setFetchOverrideForTests(fetchImpl);

        const result = await gate.verify('proj-1', repoDir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://x.vercel.app',
            previewRoutes: [],
        });

        expect(result.passed).toBe(true);
        expect(calls).toContain('HEAD');
        expect(calls).toContain('GET');
    });

    it('routes through the legacy HTML-ID path when bundleHint.kind is html-ids', async () => {
        // No fetch override needed — we expect the legacy HTML path, not the v2 path.
        // The legacy path checks for index.html in repoPath. With a fake repoPath
        // and a description that has no testable rules, it'll skip-pass.
        const result = await gate.verify('proj-1', repoDir, 'no rules here', {
            kind: 'html-ids',
        });

        expect(result.skipped).toBe(true);
        expect(result.reason).toMatch(/no testable assertions/);
    });

    it('also routes through legacy when no bundleHint is provided (backwards-compat)', async () => {
        const result = await gate.verify('proj-1', repoDir, 'no rules here');
        expect(result.skipped).toBe(true);
    });
});
