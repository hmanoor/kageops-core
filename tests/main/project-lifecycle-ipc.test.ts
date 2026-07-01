/**
 * project-lifecycle-ipc unit tests (B-401 / B-402 / B-403).
 *
 * Tests the main-process IPC shim directly — no Electron required. We mock
 * `electron` to capture `ipcMain.handle` registrations and exercise both
 * the registration surface and the pure handler functions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Electron before importing the module under test ─────

const mockIpcMain = vi.hoisted(() => {
    const handle = vi.fn();
    const reset = (): void => {
        handle.mockClear();
    };
    return { handle, reset };
});

vi.mock('electron', () => ({
    ipcMain: mockIpcMain,
}));

// db/client.getOne is invoked by handleLifecycleAction to read pre/post
// status. By default we return nothing so legacy tests aren't forced to
// simulate the DB — individual tests that care about `changed` / `status`
// re-configure the mock via `setMockStatuses([...])`.
const mockDb = vi.hoisted(() => {
    const statuses: Array<string | null> = [];
    const getOne = vi.fn(async () => {
        if (statuses.length === 0) return null;
        const next = statuses.shift();
        return next === null || next === undefined ? null : { status: next };
    });
    const setMockStatuses = (seq: Array<string | null>): void => {
        statuses.length = 0;
        statuses.push(...seq);
    };
    const reset = (): void => {
        statuses.length = 0;
        getOne.mockClear();
    };
    return { getOne, setMockStatuses, reset };
});

vi.mock('../../src/db/client', () => ({
    getOne: mockDb.getOne,
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    getMany: vi.fn(async () => []),
}));

// Import after mocks
import {
    handleLifecycleAction,
    handleRetryFailed,
    handleListProjectsFiltered,
    handleUpdateProjectMetadata,
    coerceMetadataUpdate,
    registerProjectLifecycleHandlers,
    PROJECT_LIFECYCLE_CHANNELS,
} from '../../src/main/project-lifecycle-ipc';
import { IPC } from '../../src/shared/ipc-channels';

// ── Helpers ──────────────────────────────────────────

interface MockSensei {
    cancelProject: ReturnType<typeof vi.fn>;
    pauseProject: ReturnType<typeof vi.fn>;
    resumeProject: ReturnType<typeof vi.fn>;
    archiveProject: ReturnType<typeof vi.fn>;
    restoreProject: ReturnType<typeof vi.fn>;
    hardDeleteProject: ReturnType<typeof vi.fn>;
    retryFailedTasks: ReturnType<typeof vi.fn>;
    getAllProjectsStatus: ReturnType<typeof vi.fn>;
}

function makeMockSensei(): MockSensei {
    return {
        cancelProject: vi.fn(async () => undefined),
        pauseProject: vi.fn(async () => undefined),
        resumeProject: vi.fn(async () => undefined),
        archiveProject: vi.fn(async () => undefined),
        restoreProject: vi.fn(async () => undefined),
        hardDeleteProject: vi.fn(async () => undefined),
        retryFailedTasks: vi.fn(async () => ({ retried: 0 })),
        getAllProjectsStatus: vi.fn(async () => []),
    };
}

function makeDeps(sensei: MockSensei | null): {
    readonly getOrchestrator: () => { readonly sensei: MockSensei } | null;
} {
    return {
        // Cast: the IPC module only touches `.sensei` — structural match.
        getOrchestrator: () =>
            sensei === null
                ? null
                : ({ sensei } as unknown as { readonly sensei: MockSensei }),
    };
}

// ── Channel registration ─────────────────────────────

describe('registerProjectLifecycleHandlers', () => {
    beforeEach(() => {
        mockIpcMain.reset();
    });

    it('registers exactly the claimed lifecycle channels', () => {
        const sensei = makeMockSensei();
        registerProjectLifecycleHandlers(makeDeps(sensei) as never);

        const registeredChannels = mockIpcMain.handle.mock.calls.map((c) => c[0]);
        // All claimed channels must be present...
        for (const ch of PROJECT_LIFECYCLE_CHANNELS) {
            expect(registeredChannels).toContain(ch);
        }
        // ...and we should not register extras.
        expect(registeredChannels.sort()).toEqual([...PROJECT_LIFECYCLE_CHANNELS].sort());
    });

    it('claims the canonical IPC channel constants (no string drift)', () => {
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.PROJECT_CANCEL);
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.PROJECT_PAUSE);
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.PROJECT_RESUME);
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.PROJECT_ARCHIVE);
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.PROJECT_RESTORE);
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.PROJECT_DELETE);
        expect(PROJECT_LIFECYCLE_CHANNELS).toContain(IPC.LIST_PROJECTS_FILTERED);
    });
});

// ── handleLifecycleAction input validation ───────────

describe('handleLifecycleAction input validation', () => {
    it('rejects a blank projectId', async () => {
        const sensei = makeMockSensei();
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'cancel', '');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/projectId/i);
        expect(sensei.cancelProject).not.toHaveBeenCalled();
    });

    it('rejects a non-string projectId', async () => {
        const sensei = makeMockSensei();
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'cancel', 42);
        expect(res.success).toBe(false);
        expect(sensei.cancelProject).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only projectId', async () => {
        const sensei = makeMockSensei();
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'pause', '   ');
        expect(res.success).toBe(false);
        expect(sensei.pauseProject).not.toHaveBeenCalled();
    });

    it('returns a structured error when the orchestrator is not running', async () => {
        const res = await handleLifecycleAction(makeDeps(null) as never, 'pause', 'proj-1');
        expect(res).toEqual({ success: false, error: 'Orchestrator not running' });
    });
});

// ── handleLifecycleAction dispatch ───────────────────

describe('handleLifecycleAction dispatch', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    it('routes "cancel" to Sensei.cancelProject with reason', async () => {
        const sensei = makeMockSensei();
        const res = await handleLifecycleAction(
            makeDeps(sensei) as never,
            'cancel',
            'proj-1',
            'user-stopped',
        );
        expect(res.success).toBe(true);
        expect(sensei.cancelProject).toHaveBeenCalledWith('proj-1', 'user-stopped');
    });

    it('passes undefined reason when the IPC payload is null', async () => {
        // Renderer sends `reason ?? null` — the handler should coerce to undefined.
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'cancel', 'proj-1', null);
        expect(sensei.cancelProject).toHaveBeenCalledWith('proj-1', undefined);
    });

    it('passes undefined reason when an empty string is provided', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'cancel', 'proj-1', '  ');
        expect(sensei.cancelProject).toHaveBeenCalledWith('proj-1', undefined);
    });

    it('routes "pause" to Sensei.pauseProject', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'pause', 'proj-1');
        expect(sensei.pauseProject).toHaveBeenCalledWith('proj-1');
    });

    it('routes "resume" to Sensei.resumeProject', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'resume', 'proj-1');
        expect(sensei.resumeProject).toHaveBeenCalledWith('proj-1');
    });

    it('routes "archive" to Sensei.archiveProject', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'archive', 'proj-1');
        expect(sensei.archiveProject).toHaveBeenCalledWith('proj-1');
    });

    it('routes "restore" to Sensei.restoreProject', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'restore', 'proj-1');
        expect(sensei.restoreProject).toHaveBeenCalledWith('proj-1');
    });

    it('routes "delete" to Sensei.hardDeleteProject', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(makeDeps(sensei) as never, 'delete', 'proj-1');
        expect(sensei.hardDeleteProject).toHaveBeenCalledWith('proj-1');
    });

    it('returns a structured error when Sensei throws (never leaks stack)', async () => {
        const sensei = makeMockSensei();
        sensei.pauseProject.mockRejectedValueOnce(new Error('DB gone'));
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'pause', 'proj-1');
        expect(res).toEqual({ success: false, error: 'DB gone' });
    });
});

// ── Optimistic locking (PR C of F-302 V1) ────────────
//
// When the renderer passes `expectedUpdatedAt`, the handler refuses
// the action if the live row has a different version. Pass-through
// otherwise so legacy callers stay working.
describe('handleLifecycleAction optimistic locking', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    it('skips the lock check when expectedUpdatedAt is null', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(
            makeDeps(sensei) as never,
            'pause',
            'proj-1',
            undefined,
            null,
        );
        // Sensei.pauseProject was still called — no early-return.
        expect(sensei.pauseProject).toHaveBeenCalledWith('proj-1');
    });

    it('skips the lock check when expectedUpdatedAt is undefined', async () => {
        const sensei = makeMockSensei();
        await handleLifecycleAction(
            makeDeps(sensei) as never,
            'pause',
            'proj-1',
            undefined,
            undefined,
        );
        expect(sensei.pauseProject).toHaveBeenCalledWith('proj-1');
    });

    it('proceeds when expectedUpdatedAt matches the live row', async () => {
        const sensei = makeMockSensei();
        const ts = '2026-05-10T12:00:00.000Z';
        // Lock probe returns the same timestamp → match → action runs.
        // The status pre/post readStatus calls happen after the lock
        // check; queue them in order.
        mockDb.setMockStatuses([null]);  // version probe (matches via mock impl below)
        // We can't make `setMockStatuses` return arbitrary shapes — use
        // a one-shot getOne mock instead.
        mockDb.getOne
            .mockReset()
            .mockResolvedValueOnce({ updated_at: ts })  // version probe
            .mockResolvedValueOnce({ status: 'active' })  // before
            .mockResolvedValueOnce({ status: 'paused' }); // after

        const res = await handleLifecycleAction(
            makeDeps(sensei) as never,
            'pause',
            'proj-1',
            undefined,
            ts,
        );

        expect(sensei.pauseProject).toHaveBeenCalledWith('proj-1');
        expect(res.success).toBe(true);
        expect(res.conflict).toBeUndefined();
    });

    it('returns a conflict envelope when expectedUpdatedAt differs from the live row', async () => {
        const sensei = makeMockSensei();
        const expected = '2026-05-10T12:00:00.000Z';
        const live     = '2026-05-10T12:00:05.000Z';

        mockDb.getOne
            .mockReset()
            .mockResolvedValueOnce({ updated_at: live })
            .mockResolvedValueOnce({ id: 'proj-1', updated_at: live, status: 'paused' });

        const res = await handleLifecycleAction(
            makeDeps(sensei) as never,
            'pause',
            'proj-1',
            undefined,
            expected,
        );

        expect(sensei.pauseProject).not.toHaveBeenCalled();
        expect(res.success).toBe(false);
        expect(res.conflict).toBe(true);
        expect(res.currentUpdatedAt).toBe(live);
        expect(res.error).toContain('Refresh');
    });

    it('skips the lock check on delete even when expectedUpdatedAt is provided', async () => {
        // Delete is gated by a two-step confirm modal; silent overwrite
        // isn't the failure mode. Locking would only add friction.
        const sensei = makeMockSensei();
        const res = await handleLifecycleAction(
            makeDeps(sensei) as never,
            'delete',
            'proj-1',
            undefined,
            'any-stale-token',
        );
        expect(sensei.hardDeleteProject).toHaveBeenCalledWith('proj-1');
        expect(res.success).toBe(true);
        expect(res.conflict).toBeUndefined();
    });
});

// ── Lifecycle status-transition reporting ────────────
//
// Sensei's lifecycle methods silently no-op when the project isn't in a
// permitted state (e.g. pauseProject on a completed project). The IPC
// shim snapshots status before/after so the renderer can tell the user
// "nothing happened" instead of silently refreshing.
describe('handleLifecycleAction status transitions', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    it('reports changed=true and new status when pause transitions active → paused', async () => {
        const sensei = makeMockSensei();
        mockDb.setMockStatuses(['active', 'paused']);
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'pause', 'proj-1');
        expect(res).toEqual({
            success: true,
            changed: true,
            status: 'paused',
            fromStatus: 'active',
        });
    });

    it('reports changed=false when pause is a no-op (status already completed)', async () => {
        const sensei = makeMockSensei();
        mockDb.setMockStatuses(['completed', 'completed']);
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'pause', 'proj-1');
        expect(res).toEqual({
            success: true,
            changed: false,
            status: 'completed',
            fromStatus: 'completed',
        });
    });

    it('reports changed=false when cancel no-ops on an archived project', async () => {
        const sensei = makeMockSensei();
        mockDb.setMockStatuses(['archived', 'archived']);
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'cancel', 'proj-1');
        expect(res).toEqual({
            success: true,
            changed: false,
            status: 'archived',
            fromStatus: 'archived',
        });
    });

    it('reports changed=true for delete and does not post-read the missing row', async () => {
        const sensei = makeMockSensei();
        mockDb.setMockStatuses(['active']);
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'delete', 'proj-1');
        expect(res).toEqual({
            success: true,
            changed: true,
            fromStatus: 'active',
        });
        // Only the pre-read call — post-read is skipped for delete.
        expect(mockDb.getOne).toHaveBeenCalledTimes(1);
    });

    it('survives a DB failure in readStatus (no throw, changed omitted/false)', async () => {
        const sensei = makeMockSensei();
        mockDb.getOne.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
        const res = await handleLifecycleAction(makeDeps(sensei) as never, 'pause', 'proj-1');
        expect(res.success).toBe(true);
        expect(res.changed).toBe(false);
        expect(res.status).toBeUndefined();
        expect(res.fromStatus).toBeUndefined();
    });
});

// ── handleRetryFailed ────────────────────────────────

describe('handleRetryFailed', () => {
    it('returns retried count on success', async () => {
        const sensei = makeMockSensei();
        sensei.retryFailedTasks.mockResolvedValueOnce({ retried: 3 });
        const res = await handleRetryFailed(makeDeps(sensei) as never, 'proj-1');
        expect(res).toEqual({ success: true, retried: 3 });
    });

    it('rejects a blank projectId', async () => {
        const res = await handleRetryFailed(makeDeps(makeMockSensei()) as never, '');
        expect(res.success).toBe(false);
    });

    it('returns structured error when Sensei throws', async () => {
        const sensei = makeMockSensei();
        sensei.retryFailedTasks.mockRejectedValueOnce(new Error('boom'));
        const res = await handleRetryFailed(makeDeps(sensei) as never, 'proj-1');
        expect(res).toEqual({ success: false, error: 'boom' });
    });
});

// ── handleListProjectsFiltered ──────────────────────

describe('handleListProjectsFiltered', () => {
    it('forwards an empty filter when nothing is provided', async () => {
        const sensei = makeMockSensei();
        await handleListProjectsFiltered(makeDeps(sensei) as never, undefined);
        expect(sensei.getAllProjectsStatus).toHaveBeenCalledWith({});
    });

    it('forwards `include` as a string array', async () => {
        const sensei = makeMockSensei();
        await handleListProjectsFiltered(makeDeps(sensei) as never, {
            include: ['archived', 'completed'],
        });
        expect(sensei.getAllProjectsStatus).toHaveBeenCalledWith({
            include: ['archived', 'completed'],
        });
    });

    it('forwards `exclude` as a string array', async () => {
        const sensei = makeMockSensei();
        await handleListProjectsFiltered(makeDeps(sensei) as never, {
            exclude: ['paused'],
        });
        expect(sensei.getAllProjectsStatus).toHaveBeenCalledWith({
            exclude: ['paused'],
        });
    });

    it('forwards `includeArchived: true` so B-404 can request archived rows', async () => {
        const sensei = makeMockSensei();
        await handleListProjectsFiltered(makeDeps(sensei) as never, {
            includeArchived: true,
        });
        expect(sensei.getAllProjectsStatus).toHaveBeenCalledWith({ includeArchived: true });
    });

    it('drops includeArchived when not strictly true (no silent coercion)', async () => {
        const sensei = makeMockSensei();
        await handleListProjectsFiltered(makeDeps(sensei) as never, {
            includeArchived: 'yes',
        });
        expect(sensei.getAllProjectsStatus).toHaveBeenCalledWith({});
    });

    it('strips non-string entries from include/exclude arrays', async () => {
        const sensei = makeMockSensei();
        await handleListProjectsFiltered(makeDeps(sensei) as never, {
            include: ['archived', 42, null, ''],
        });
        expect(sensei.getAllProjectsStatus).toHaveBeenCalledWith({ include: ['archived'] });
    });

    it('returns [] (not throw) when Sensei fails', async () => {
        const sensei = makeMockSensei();
        sensei.getAllProjectsStatus.mockRejectedValueOnce(new Error('db down'));
        const res = await handleListProjectsFiltered(makeDeps(sensei) as never, {});
        expect(res).toEqual([]);
    });

    it('returns [] when the orchestrator is not running', async () => {
        const res = await handleListProjectsFiltered(makeDeps(null) as never, {});
        expect(res).toEqual([]);
    });
});

// ── coerceMetadataUpdate (B-406) ─────────────────────

describe('coerceMetadataUpdate', () => {
    it('rejects non-object payloads', () => {
        expect(coerceMetadataUpdate(null).ok).toBe(false);
        expect(coerceMetadataUpdate('hello').ok).toBe(false);
        expect(coerceMetadataUpdate(42).ok).toBe(false);
    });

    it('rejects empty payload (no fields to update)', () => {
        const res = coerceMetadataUpdate({});
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/No metadata fields/i);
    });

    it('trims name and accepts it', () => {
        const res = coerceMetadataUpdate({ name: '  MyApp  ' });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value.name).toBe('MyApp');
    });

    it('rejects empty-after-trim name', () => {
        const res = coerceMetadataUpdate({ name: '   ' });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/name cannot be empty/i);
    });

    it('rejects name over 200 chars', () => {
        const res = coerceMetadataUpdate({ name: 'x'.repeat(201) });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/200/);
    });

    it('rejects non-string name', () => {
        const res = coerceMetadataUpdate({ name: 42 });
        expect(res.ok).toBe(false);
    });

    it('preserves description untrimmed (allows leading/trailing whitespace)', () => {
        const res = coerceMetadataUpdate({ description: '  hello world\n' });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value.description).toBe('  hello world\n');
    });

    it('allows empty-string description (clearing field)', () => {
        const res = coerceMetadataUpdate({ description: '' });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value.description).toBe('');
    });

    it('rejects non-string description', () => {
        const res = coerceMetadataUpdate({ description: { foo: 'bar' } });
        expect(res.ok).toBe(false);
    });

    it('accepts each valid trust tier', () => {
        for (const t of ['low', 'medium', 'high'] as const) {
            const res = coerceMetadataUpdate({ trustLevel: t });
            expect(res.ok).toBe(true);
            if (res.ok) expect(res.value.trustLevel).toBe(t);
        }
    });

    it('rejects an invalid trust tier', () => {
        const res = coerceMetadataUpdate({ trustLevel: 'extreme' });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/trustLevel/);
    });

    it('drops unknown keys silently', () => {
        const res = coerceMetadataUpdate({ name: 'App', unrelated: 'x', another: 42 });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.value.name).toBe('App');
            expect(Object.keys(res.value)).toEqual(['name']);
        }
    });
});

// ── handleUpdateProjectMetadata ──────────────────────

describe('handleUpdateProjectMetadata', () => {
    it('rejects a blank projectId', async () => {
        const runQuery = vi.fn(async () => ({ rowCount: 0 }));
        const res = await handleUpdateProjectMetadata(
            makeDeps(makeMockSensei()) as never,
            '',
            { name: 'x' },
            runQuery,
        );
        expect(res.success).toBe(false);
        expect(runQuery).not.toHaveBeenCalled();
    });

    it('bubbles coerce errors up unchanged', async () => {
        const runQuery = vi.fn(async () => ({ rowCount: 0 }));
        const res = await handleUpdateProjectMetadata(
            makeDeps(makeMockSensei()) as never,
            'proj-1',
            { trustLevel: 'godmode' },
            runQuery,
        );
        expect(res).toEqual({ success: false, error: 'trustLevel must be low | medium | high' });
        expect(runQuery).not.toHaveBeenCalled();
    });

    it('builds a name-only UPDATE when only name changes', async () => {
        const runQuery = vi.fn(async () => ({ rowCount: 1 }));
        const res = await handleUpdateProjectMetadata(
            makeDeps(makeMockSensei()) as never,
            'proj-1',
            { name: 'Renamed' },
            runQuery,
        );
        expect(res).toEqual({ success: true });
        expect(runQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = runQuery.mock.calls[0];
        expect(sql).toBe('UPDATE projects SET name = $1 WHERE id = $2');
        expect(params).toEqual(['Renamed', 'proj-1']);
    });

    it('builds a combined UPDATE when multiple fields change (preserves order name/desc/trust)', async () => {
        const runQuery = vi.fn(async () => ({ rowCount: 1 }));
        await handleUpdateProjectMetadata(
            makeDeps(makeMockSensei()) as never,
            'proj-1',
            { trustLevel: 'high', description: 'New brief', name: 'A' },
            runQuery,
        );
        const [sql, params] = runQuery.mock.calls[0];
        expect(sql).toBe(
            'UPDATE projects SET name = $1, description = $2, trust_level = $3 WHERE id = $4',
        );
        expect(params).toEqual(['A', 'New brief', 'high', 'proj-1']);
    });

    it('returns "Project not found" when rowCount is 0', async () => {
        const runQuery = vi.fn(async () => ({ rowCount: 0 }));
        const res = await handleUpdateProjectMetadata(
            makeDeps(makeMockSensei()) as never,
            'missing',
            { name: 'x' },
            runQuery,
        );
        expect(res).toEqual({ success: false, error: 'Project not found' });
    });

    it('returns structured error when the query throws', async () => {
        const runQuery = vi.fn(async () => {
            throw new Error('constraint violation');
        });
        const res = await handleUpdateProjectMetadata(
            makeDeps(makeMockSensei()) as never,
            'proj-1',
            { name: 'Renamed' },
            runQuery,
        );
        expect(res).toEqual({ success: false, error: 'constraint violation' });
    });

    it('passes the orchestrator touch through (for AcceptanceGate re-extraction hook)', async () => {
        const sensei = makeMockSensei();
        const deps = makeDeps(sensei) as never;
        const runQuery = vi.fn(async () => ({ rowCount: 1 }));
        await handleUpdateProjectMetadata(deps, 'proj-1', { description: 'new' }, runQuery);
        // Success path invokes the deps.getOrchestrator fn so a future hook can fire.
        // We don't assert on count (impl detail), just that the call succeeded.
        expect(runQuery).toHaveBeenCalled();
    });
});
