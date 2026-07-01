/**
 * artifact-browser-ipc unit tests (B-420 / B-421 / B-422).
 *
 * Exercises the pure IPC handlers and protocol URL parser directly — no
 * Electron runtime required. We only mock `electron` so the module's
 * `ipcMain.handle` / `protocol.registerFileProtocol` side effects are
 * inert when the module is imported.
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

const mockElectron = vi.hoisted(() => ({
    ipcMain: { handle: vi.fn() },
    protocol: {
        registerSchemesAsPrivileged: vi.fn(),
        registerFileProtocol: vi.fn(),
    },
}));

vi.mock('electron', () => mockElectron);

import {
    handleListTree,
    handleReadFile,
    handleTaskDetails,
    mapTaskDetailsRow,
    safeNullableNumber,
    handleArtifactSearch,
    parseArtifactUrl,
    resolveProtocolRequest,
    ARTIFACT_PROTOCOL_SCHEME,
    registerArtifactSchemesAsPrivileged,
    type RawTaskDetailsRow,
    type WorkspaceSearchFn,
} from '../../src/main/artifact-browser-ipc';

// ── Fake service factory ─────────────────────────────

interface FakeService {
    listTree: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
}

function makeService(): FakeService {
    return {
        listTree: vi.fn(async () => []),
        readFile: vi.fn(async () => ({
            content: 'hello',
            encoding: 'utf8',
            mimeType: 'text/plain',
            sizeBytes: 5,
            mtimeIso: '2026-01-01T00:00:00.000Z',
            isBinary: false,
        })),
    };
}

// ── handleListTree ───────────────────────────────────

describe('handleListTree', () => {
    it('returns nodes when projectId is valid', async () => {
        const svc = makeService();
        svc.listTree.mockResolvedValueOnce([
            { name: 'src', path: 'src', type: 'dir', children: [] },
        ]);
        const res = await handleListTree(svc, { projectId: 'p1' });
        expect(res.success).toBe(true);
        expect(res.nodes).toHaveLength(1);
    });

    it('rejects missing projectId', async () => {
        const svc = makeService();
        const res = await handleListTree(svc, {});
        expect(res.success).toBe(false);
        expect(res.error).toBe('Invalid projectId');
        expect(svc.listTree).not.toHaveBeenCalled();
    });

    it('rejects non-object input', async () => {
        const svc = makeService();
        const res = await handleListTree(svc, null);
        expect(res.success).toBe(false);
        expect(res.nodes).toEqual([]);
    });

    it('passes maxDepth through when finite and non-negative', async () => {
        const svc = makeService();
        await handleListTree(svc, { projectId: 'p1', maxDepth: 3 });
        expect(svc.listTree).toHaveBeenCalledWith('p1', 3);
    });

    it('defaults maxDepth when missing or invalid', async () => {
        const svc = makeService();
        await handleListTree(svc, { projectId: 'p1' });
        const call = svc.listTree.mock.calls[0];
        expect(call[0]).toBe('p1');
        expect(typeof call[1]).toBe('number');
        expect(call[1]).toBeGreaterThan(0);
    });

    it('ignores negative maxDepth (falls back to default)', async () => {
        const svc = makeService();
        await handleListTree(svc, { projectId: 'p1', maxDepth: -2 });
        const call = svc.listTree.mock.calls[0];
        expect(call[1]).toBeGreaterThan(0);
    });

    it('wraps service errors as error response', async () => {
        const svc = makeService();
        svc.listTree.mockRejectedValueOnce(new Error('boom'));
        const res = await handleListTree(svc, { projectId: 'p1' });
        expect(res.success).toBe(false);
        expect(res.error).toBe('boom');
        expect(res.nodes).toEqual([]);
    });
});

// ── handleReadFile ───────────────────────────────────

describe('handleReadFile', () => {
    it('returns file on success', async () => {
        const svc = makeService();
        const res = await handleReadFile(svc, { projectId: 'p1', relPath: 'README.md' });
        expect(res.success).toBe(true);
        expect(res.file?.content).toBe('hello');
    });

    it('rejects missing projectId or relPath', async () => {
        const svc = makeService();
        const a = await handleReadFile(svc, { projectId: 'p1' });
        const b = await handleReadFile(svc, { relPath: 'a.txt' });
        expect(a.success).toBe(false);
        expect(b.success).toBe(false);
    });

    it('rejects empty-string arguments', async () => {
        const svc = makeService();
        const res = await handleReadFile(svc, { projectId: '', relPath: '' });
        expect(res.success).toBe(false);
    });

    it('wraps service errors', async () => {
        const svc = makeService();
        svc.readFile.mockRejectedValueOnce(new Error('nope'));
        const res = await handleReadFile(svc, { projectId: 'p1', relPath: 'x' });
        expect(res.success).toBe(false);
        expect(res.error).toBe('nope');
    });
});

// ── parseArtifactUrl ─────────────────────────────────

describe('parseArtifactUrl', () => {
    it('parses projectId and relPath', () => {
        const out = parseArtifactUrl('kageops-artifact://proj-1/src/index.html');
        expect(out).toEqual({ projectId: 'proj-1', relPath: 'src/index.html' });
    });

    it('decodes URI components', () => {
        const out = parseArtifactUrl('kageops-artifact://proj%201/a%20b/c.html');
        expect(out).toEqual({ projectId: 'proj 1', relPath: 'a b/c.html' });
    });

    it('strips query string', () => {
        const out = parseArtifactUrl('kageops-artifact://proj-1/index.html?v=2');
        expect(out).toEqual({ projectId: 'proj-1', relPath: 'index.html' });
    });

    it('strips fragment', () => {
        const out = parseArtifactUrl('kageops-artifact://proj-1/index.html#top');
        expect(out).toEqual({ projectId: 'proj-1', relPath: 'index.html' });
    });

    it('returns null for wrong scheme', () => {
        expect(parseArtifactUrl('file:///etc/passwd')).toBeNull();
        expect(parseArtifactUrl('http://evil.com/a.html')).toBeNull();
    });

    it('returns null when relPath is missing', () => {
        expect(parseArtifactUrl('kageops-artifact://proj-1')).toBeNull();
    });

    it('returns null when projectId is empty', () => {
        expect(parseArtifactUrl('kageops-artifact:///a.html')).toBeNull();
    });

    it('rejects absolute relPath', () => {
        // Leading slash appears as empty path segment after projectId.
        expect(parseArtifactUrl('kageops-artifact://proj/../etc/passwd'))
            .toEqual({ projectId: 'proj', relPath: '../etc/passwd' });
        // Truly absolute (decoded) — should be rejected.
        expect(parseArtifactUrl('kageops-artifact://proj/%2Fabsolute')).toBeNull();
    });

    it('exposes the scheme constant', () => {
        expect(ARTIFACT_PROTOCOL_SCHEME).toBe('kageops-artifact');
    });
});

// ── resolveProtocolRequest ───────────────────────────

describe('resolveProtocolRequest', () => {
    let tmpRoot: string;

    async function makeRoot(): Promise<string> {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kageops-art-'));
        await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'index.html'), '<p>ok</p>');
        await fsp.writeFile(path.join(dir, 'sub', 'page.html'), '<p>sub</p>');
        return dir;
    }

    it('resolves legitimate path inside project root', async () => {
        tmpRoot = await makeRoot();
        const abs = await resolveProtocolRequest(
            { lookupProjectRoot: async () => tmpRoot },
            'kageops-artifact://p1/index.html',
        );
        expect(abs).toBe(path.join(tmpRoot, 'index.html'));
    });

    it('resolves nested path', async () => {
        tmpRoot = await makeRoot();
        const abs = await resolveProtocolRequest(
            { lookupProjectRoot: async () => tmpRoot },
            'kageops-artifact://p1/sub/page.html',
        );
        expect(abs).toBe(path.join(tmpRoot, 'sub', 'page.html'));
    });

    it('returns null when project cannot be found', async () => {
        const abs = await resolveProtocolRequest(
            { lookupProjectRoot: async () => null },
            'kageops-artifact://missing/index.html',
        );
        expect(abs).toBeNull();
    });

    it('throws on traversal attempt', async () => {
        tmpRoot = await makeRoot();
        await expect(
            resolveProtocolRequest(
                { lookupProjectRoot: async () => tmpRoot },
                'kageops-artifact://p1/../../etc/passwd',
            ),
        ).rejects.toThrow(/traversal/i);
    });

    it('throws on an unparseable URL', async () => {
        await expect(
            resolveProtocolRequest(
                { lookupProjectRoot: async () => '/tmp' },
                'not-a-url',
            ),
        ).rejects.toThrow(/invalid artifact url/i);
    });
});

// ── handleTaskDetails (B-428) ────────────────────────

describe('handleTaskDetails', () => {
    const fakeRow: RawTaskDetailsRow = {
        id: 'task-1',
        title: 'Build landing page',
        description: 'Emit index.html + style.css with hero section',
        status: 'completed',
        phase: 'development',
        task_type: 'ui-build',
        assigned_agent: 'pixel',
        retry_count: 1,
        quality_score: '8.5',
        error_message: null,
        branch_name: 'agent/pixel/task-1',
        output_path: 'index.html',
        created_at: '2026-04-25T00:00:00.000Z',
        started_at: '2026-04-25T00:00:05.000Z',
        completed_at: '2026-04-25T00:00:42.500Z',
        total_cost_usd: '0.0123',
        total_tokens_in: 1500,
        total_tokens_out: '3200',
        last_model: 'claude-sonnet-4-6',
    };

    it('returns invalid-args when projectId is missing', async () => {
        const q = vi.fn();
        const out = await handleTaskDetails({ taskId: 't' }, q);
        expect(out.success).toBe(false);
        expect(out.error).toBe('Invalid arguments');
        expect(q).not.toHaveBeenCalled();
    });

    it('returns invalid-args when taskId is missing', async () => {
        const q = vi.fn();
        const out = await handleTaskDetails({ projectId: 'p' }, q);
        expect(out.success).toBe(false);
        expect(q).not.toHaveBeenCalled();
    });

    it('passes the injected query and returns a mapped task', async () => {
        const q = vi.fn(async () => fakeRow);
        const out = await handleTaskDetails({ projectId: 'p-1', taskId: 'task-1' }, q);
        expect(out.success).toBe(true);
        expect(out.task).not.toBeNull();
        expect(out.task?.id).toBe('task-1');
        expect(out.task?.assignedAgent).toBe('pixel');
        expect(out.task?.retryCount).toBe(1);
        expect(out.task?.qualityScore).toBeCloseTo(8.5, 6);
        expect(out.task?.totalCostUsd).toBeCloseTo(0.0123, 6);
        expect(out.task?.totalTokensOut).toBe(3200);
        expect(q).toHaveBeenCalledTimes(1);
        const [, params] = q.mock.calls[0];
        expect(params).toEqual(['task-1', 'p-1']);
    });

    it('returns task=null when the row is not found', async () => {
        const q = vi.fn(async () => null);
        const out = await handleTaskDetails({ projectId: 'p', taskId: 't' }, q);
        expect(out.success).toBe(true);
        expect(out.task).toBeNull();
    });

    it('wraps DB errors into an error response', async () => {
        const q = vi.fn(async () => { throw new Error('db down'); });
        const out = await handleTaskDetails({ projectId: 'p', taskId: 't' }, q);
        expect(out.success).toBe(false);
        expect(out.error).toBe('db down');
    });
});

describe('mapTaskDetailsRow', () => {
    const base: RawTaskDetailsRow = {
        id: 'x',
        title: 'T',
        description: null,
        status: 'pending',
        phase: 'discovery',
        task_type: null,
        assigned_agent: null,
        retry_count: 0,
        quality_score: null,
        error_message: null,
        branch_name: null,
        output_path: null,
        created_at: '2026-04-01T00:00:00.000Z',
        started_at: null,
        completed_at: null,
        total_cost_usd: null,
        total_tokens_in: null,
        total_tokens_out: null,
        last_model: null,
    };

    it('leaves nullable fields null', () => {
        const out = mapTaskDetailsRow(base);
        expect(out.description).toBeNull();
        expect(out.qualityScore).toBeNull();
        expect(out.startedAtIso).toBeNull();
        expect(out.completedAtIso).toBeNull();
        expect(out.totalCostUsd).toBeNull();
        expect(out.totalTokensIn).toBeNull();
        expect(out.lastModel).toBeNull();
    });

    it('coerces string NUMERIC to number', () => {
        const out = mapTaskDetailsRow({
            ...base,
            quality_score: '7.0',
            total_cost_usd: '1.234567',
            total_tokens_in: '42',
        });
        expect(out.qualityScore).toBeCloseTo(7.0, 6);
        expect(out.totalCostUsd).toBeCloseTo(1.234567, 6);
        expect(out.totalTokensIn).toBe(42);
    });

    it('normalizes Date timestamps to ISO strings', () => {
        const d = new Date('2026-04-10T12:34:56.000Z');
        const out = mapTaskDetailsRow({ ...base, created_at: d, started_at: d });
        expect(out.createdAtIso).toBe('2026-04-10T12:34:56.000Z');
        expect(out.startedAtIso).toBe('2026-04-10T12:34:56.000Z');
    });

    it('maps unparseable started/completed timestamps to null (no throw)', () => {
        const out = mapTaskDetailsRow({ ...base, started_at: 'not-a-date', completed_at: 'garbage' });
        expect(out.startedAtIso).toBeNull();
        expect(out.completedAtIso).toBeNull();
    });

    it('falls back to raw string when created_at is unparseable (cannot be null)', () => {
        const out = mapTaskDetailsRow({ ...base, created_at: 'garbage-timestamp' });
        expect(out.createdAtIso).toBe('garbage-timestamp');
    });

    it('maps NaN NUMERIC to null rather than propagating NaN', () => {
        const out = mapTaskDetailsRow({
            ...base,
            quality_score: 'not-a-number',
            total_cost_usd: 'also-bad',
            total_tokens_in: 'nope',
        });
        expect(out.qualityScore).toBeNull();
        expect(out.totalCostUsd).toBeNull();
        expect(out.totalTokensIn).toBeNull();
    });
});

describe('safeNullableNumber', () => {
    it('returns null for null', () => {
        expect(safeNullableNumber(null)).toBeNull();
    });

    it('passes through finite numbers', () => {
        expect(safeNullableNumber(3.14)).toBe(3.14);
        expect(safeNullableNumber(0)).toBe(0);
    });

    it('coerces finite numeric strings', () => {
        expect(safeNullableNumber('2.5')).toBe(2.5);
    });

    it('returns null for NaN, Infinity, or garbage strings', () => {
        expect(safeNullableNumber(Number.NaN)).toBeNull();
        expect(safeNullableNumber(Number.POSITIVE_INFINITY)).toBeNull();
        expect(safeNullableNumber('garbage')).toBeNull();
    });
});

// ── handleArtifactSearch (B-429) ─────────────────────

describe('handleArtifactSearch', () => {
    const fakeService = {
        getProjectRootPublic: vi.fn(async () => '/tmp/project-root'),
    };

    const okSearchFn: WorkspaceSearchFn = vi.fn(async () => ({
        results: [
            { relPath: 'a.ts', matches: [{ line: 1, content: 'hit', columnStart: 0, columnEnd: 3 }] },
        ],
        totalMatches: 1,
        truncated: false,
        durationMs: 5,
        filesScanned: 10,
        filesSkipped: 2,
    }));

    it('rejects missing projectId', async () => {
        const res = await handleArtifactSearch(fakeService, { query: 'x' }, okSearchFn);
        expect(res.success).toBe(false);
        expect(res.error).toBe('Invalid arguments');
    });

    it('rejects empty query', async () => {
        const res = await handleArtifactSearch(fakeService, { projectId: 'p', query: '' }, okSearchFn);
        expect(res.success).toBe(false);
    });

    it('returns Project not found when root is null', async () => {
        const svc = { getProjectRootPublic: vi.fn(async () => null) };
        const res = await handleArtifactSearch(svc, { projectId: 'ghost', query: 'hit' }, okSearchFn);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/project not found/i);
    });

    it('delegates to the search function and returns its result', async () => {
        const res = await handleArtifactSearch(
            fakeService,
            { projectId: 'p', query: 'hit' },
            okSearchFn,
        );
        expect(res.success).toBe(true);
        expect(res.totalMatches).toBe(1);
        expect(res.results[0]?.relPath).toBe('a.ts');
        expect(res.filesScanned).toBe(10);
    });

    it('clamps maxResults to the handler cap', async () => {
        const spy: WorkspaceSearchFn = vi.fn(async (_root, _query, opts) => ({
            results: [],
            totalMatches: 0,
            truncated: false,
            durationMs: 0,
            filesScanned: 0,
            filesSkipped: 0,
            observed: opts.maxResults,
        } as never));
        await handleArtifactSearch(
            fakeService,
            { projectId: 'p', query: 'hit', maxResults: 100_000 },
            spy,
        );
        const call = (spy as unknown as { mock: { calls: readonly [string, string, { maxResults: number }][] } }).mock.calls[0];
        expect(call[2].maxResults).toBeLessThanOrEqual(1000);
    });

    it('wraps search errors into error response', async () => {
        const bad: WorkspaceSearchFn = vi.fn(async () => { throw new Error('regex blew up'); });
        const res = await handleArtifactSearch(
            fakeService,
            { projectId: 'p', query: 'hit', regex: true },
            bad,
        );
        expect(res.success).toBe(false);
        expect(res.error).toBe('regex blew up');
    });
});

// ── registerArtifactSchemesAsPrivileged ──────────────

describe('registerArtifactSchemesAsPrivileged', () => {
    it('registers the scheme as privileged', () => {
        mockElectron.protocol.registerSchemesAsPrivileged.mockClear();
        registerArtifactSchemesAsPrivileged();
        expect(mockElectron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
        const arg = mockElectron.protocol.registerSchemesAsPrivileged.mock.calls[0][0];
        expect(Array.isArray(arg)).toBe(true);
        expect(arg[0].scheme).toBe('kageops-artifact');
        expect(arg[0].privileges.standard).toBe(true);
        expect(arg[0].privileges.secure).toBe(true);
        expect(arg[0].privileges.bypassCSP).toBe(false);
    });
});
