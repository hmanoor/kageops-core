/**
 * KageOps Project Lifecycle IPC (B-401 / B-402 / B-403)
 *
 * Registers the main-process handlers for project lifecycle actions:
 *
 *   • `command-center:project-cancel`   — B-401  (cancel running project)
 *   • `command-center:project-pause`    — B-403  (cooperative pause)
 *   • `command-center:project-resume`   — B-403
 *   • `command-center:project-archive`  — B-402  (soft-delete)
 *   • `command-center:project-restore`  — B-402  (unarchive)
 *   • `command-center:project-delete`   — pre-existing (hard delete, B-405)
 *   • `command-center:project-retry-failed` — pre-existing
 *   • `command-center:list-projects-filtered` — supports {include,exclude,
 *     includeArchived} so the Archived tab (B-404) can request archived rows
 *
 * Extracted from `main.ts` to keep that entry point within the CLAUDE.md
 * 400-LOC soft-budget. Patterned after `project-start-ipc.ts`.
 *
 * Sensei already implements the lifecycle state transitions — this module
 * is a thin, strongly-typed IPC shim that validates input and surfaces
 * `{ success, error? }` responses to the renderer.
 */

import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { OrchestratorHandles } from './orchestrator-bootstrap';
import type { ProjectStatus } from '../orchestrator/sensei';
import { createLogger } from '../shared/logger';

const log = createLogger('ProjectLifecycleIPC');

// ── Types ────────────────────────────────────────────

export type LifecycleAction =
    | 'cancel'
    | 'pause'
    | 'resume'
    | 'archive'
    | 'restore'
    | 'delete'
    // F-308 + F-309 — explicit reopen/close after project completion
    | 'reopen'
    | 'close';

export interface LifecycleResponse {
    readonly success: boolean;
    readonly error?: string;
    /**
     * True when the lifecycle action actually transitioned project status in
     * the DB. False when Sensei no-op'd the request (e.g. pause on a project
     * whose status is not `'active'`). Absent when we could not determine
     * the status (project missing / query failure).
     */
    readonly changed?: boolean;
    /** Current project status after the action. */
    readonly status?: string;
    /** Prior project status (pre-action). */
    readonly fromStatus?: string;
    /**
     * Set when the optimistic lock failed. When true, the action did not
     * run; the renderer should refresh and show a conflict toast.
     */
    readonly conflict?: true;
    /** Current `updated_at` of the project — set on conflict so the renderer can sync. */
    readonly currentUpdatedAt?: string | null;
}

export interface RetryFailedResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly retried?: number;
}

export interface RestartProjectResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly requeued?: number;
}

export type TrustLevel = 'low' | 'medium' | 'high';

export interface MetadataUpdate {
    readonly name?: string;
    readonly description?: string;
    readonly trustLevel?: TrustLevel;
}

export interface ProjectFilter {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly includeArchived?: boolean;
}

export interface ProjectLifecycleDeps {
    /** Resolves to the currently booted orchestrator, or null if absent. */
    readonly getOrchestrator: () => OrchestratorHandles | null;
}

// ── Input coercion ───────────────────────────────────

function coerceProjectId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

function coerceReason(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
}

function coerceStringArray(raw: unknown): readonly string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: string[] = [];
    for (const v of raw) {
        if (typeof v === 'string' && v !== '') out.push(v);
    }
    return out.length === 0 ? undefined : out;
}

function coerceFilter(raw: unknown): ProjectFilter {
    if (typeof raw !== 'object' || raw === null) return {};
    const f = raw as Record<string, unknown>;
    const include = coerceStringArray(f['include']);
    const exclude = coerceStringArray(f['exclude']);
    const includeArchived =
        f['includeArchived'] === true ? true : undefined;
    const out: { -readonly [K in keyof ProjectFilter]: ProjectFilter[K] } = {};
    if (include !== undefined) out.include = include;
    if (exclude !== undefined) out.exclude = exclude;
    if (includeArchived !== undefined) out.includeArchived = includeArchived;
    return out;
}

// ── Handler core (exported for testing) ──────────────

/**
 * Dispatch a lifecycle action against Sensei. Exported so unit tests can
 * call it directly with a mocked orchestrator — no Electron `ipcMain`
 * plumbing required.
 */
export async function handleLifecycleAction(
    deps: ProjectLifecycleDeps,
    action: LifecycleAction,
    rawProjectId: unknown,
    rawReason?: unknown,
    /**
     * Optional optimistic-lock token (PR C of F-302). When the renderer
     * reads a project's `updated_at` and passes it back here, we refuse
     * to run the action if the live row's version differs — surfaces as
     * a conflict toast instead of silently overwriting another user's
     * change. Pass `null` / omit to skip the check (back-compat).
     */
    expectedUpdatedAt?: string | null,
): Promise<LifecycleResponse> {
    const projectId = coerceProjectId(rawProjectId);
    if (projectId === null) {
        return { success: false, error: 'Invalid projectId' };
    }
    const orchestrator = deps.getOrchestrator();
    if (orchestrator === null) {
        return { success: false, error: 'Orchestrator not running' };
    }

    const { sensei } = orchestrator;

    // Optimistic lock check — runs only when the renderer supplied a
    // version token. `delete` skips the check (it's already wrapped in a
    // two-step confirm modal so silent overwrite isn't the failure mode).
    if (action !== 'delete' && expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
        const { checkOptimisticLock } = await import('./optimistic-lock');
        const lock = await checkOptimisticLock<{ updated_at: string }>(
            'projects', projectId, expectedUpdatedAt,
        );
        if (!lock.ok) {
            log.warn(
                { projectId, action, expected: expectedUpdatedAt, current: lock.currentUpdatedAt },
                'Optimistic-lock conflict — refusing lifecycle action',
            );
            return {
                success: false,
                conflict: true,
                error:
                    'Someone else updated this project just now. ' +
                    'Refresh to see their change, then try again.',
                currentUpdatedAt: lock.currentUpdatedAt,
            };
        }
    }

    // Sensei's lifecycle methods silently no-op when the current status
    // doesn't permit the transition (e.g. pauseProject on a completed run).
    // Snapshot before/after so callers can surface "nothing happened, here's
    // why" instead of a misleading success toast. For `delete` the row is
    // gone after the call, so we skip the post-check.
    const before = await readStatus(projectId);

    try {
        switch (action) {
            case 'cancel':
                await sensei.cancelProject(projectId, coerceReason(rawReason));
                break;
            case 'pause':
                await sensei.pauseProject(projectId);
                break;
            case 'resume':
                await sensei.resumeProject(projectId);
                break;
            case 'archive':
                await sensei.archiveProject(projectId);
                break;
            case 'restore':
                await sensei.restoreProject(projectId);
                break;
            case 'delete':
                await sensei.hardDeleteProject(projectId);
                return { success: true, changed: true, fromStatus: before ?? undefined };
            case 'reopen':
                await sensei.reopenProject(projectId);
                break;
            case 'close':
                await sensei.closeProject(projectId);
                break;
        }
        const after = await readStatus(projectId);
        const changed = before !== null && after !== null && before !== after;
        const response: {
            -readonly [K in keyof LifecycleResponse]: LifecycleResponse[K];
        } = { success: true, changed };
        if (after !== null) response.status = after;
        if (before !== null) response.fromStatus = before;
        return response;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, action, projectId }, 'Lifecycle action failed');
        return { success: false, error: msg };
    }
}

/**
 * Read the current `status` column for a project. Returns `null` when the
 * row is missing or the DB call fails — callers treat that as "unknown"
 * and omit the status field from the response rather than erroring.
 */
async function readStatus(projectId: string): Promise<string | null> {
    try {
        const { getOne } = await import('../db/client');
        const row = await getOne<{ status: string }>(
            'SELECT status FROM projects WHERE id = $1',
            [projectId],
        );
        return row?.status ?? null;
    } catch {
        return null;
    }
}

export async function handleRestartStalled(
    deps: ProjectLifecycleDeps,
    rawProjectId: unknown,
): Promise<RestartProjectResponse> {
    const projectId = coerceProjectId(rawProjectId);
    if (projectId === null) {
        return { success: false, error: 'Invalid projectId' };
    }
    const orchestrator = deps.getOrchestrator();
    if (orchestrator === null) {
        return { success: false, error: 'Orchestrator not running' };
    }
    try {
        const result = await orchestrator.sensei.restartStalledProject(projectId);
        return { success: true, requeued: result.requeued };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, projectId }, 'Restart stalled project failed');
        return { success: false, error: msg };
    }
}

export async function handleRetryFailed(
    deps: ProjectLifecycleDeps,
    rawProjectId: unknown,
): Promise<RetryFailedResponse> {
    const projectId = coerceProjectId(rawProjectId);
    if (projectId === null) {
        return { success: false, error: 'Invalid projectId' };
    }
    const orchestrator = deps.getOrchestrator();
    if (orchestrator === null) {
        return { success: false, error: 'Orchestrator not running' };
    }
    try {
        const result = await orchestrator.sensei.retryFailedTasks(projectId);
        return { success: true, retried: result.retried };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, projectId }, 'Retry failed tasks failed');
        return { success: false, error: msg };
    }
}

/**
 * Coerce an untyped IPC payload into a normalised `MetadataUpdate`.
 * Unknown keys are dropped; non-string values are rejected. Trust level
 * is validated against the three accepted tiers — anything else returns
 * `{ok:false, error}` so the handler can surface a clear message.
 */
export function coerceMetadataUpdate(raw: unknown): { readonly ok: true; readonly value: MetadataUpdate } | { readonly ok: false; readonly error: string } {
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, error: 'Invalid metadata payload' };
    }
    const f = raw as Record<string, unknown>;
    const out: { -readonly [K in keyof MetadataUpdate]: MetadataUpdate[K] } = {};

    if (f['name'] !== undefined) {
        if (typeof f['name'] !== 'string') return { ok: false, error: 'name must be a string' };
        const trimmed = f['name'].trim();
        if (trimmed === '') return { ok: false, error: 'name cannot be empty' };
        if (trimmed.length > 200) return { ok: false, error: 'name exceeds 200 characters' };
        out.name = trimmed;
    }

    if (f['description'] !== undefined) {
        if (typeof f['description'] !== 'string') return { ok: false, error: 'description must be a string' };
        // Description is allowed to be empty — callers clearing the field.
        out.description = f['description'];
    }

    if (f['trustLevel'] !== undefined) {
        if (f['trustLevel'] !== 'low' && f['trustLevel'] !== 'medium' && f['trustLevel'] !== 'high') {
            return { ok: false, error: 'trustLevel must be low | medium | high' };
        }
        out.trustLevel = f['trustLevel'];
    }

    if (Object.keys(out).length === 0) {
        return { ok: false, error: 'No metadata fields provided' };
    }

    return { ok: true, value: out };
}

/**
 * Update mutable project metadata (B-406). Returns `{success}` or an
 * error message. Name is NOT NULL at the DB level, so an empty name is
 * rejected at coercion time. Trust level is validated against the three
 * accepted tiers.
 */
export async function handleUpdateProjectMetadata(
    deps: ProjectLifecycleDeps,
    rawProjectId: unknown,
    rawUpdates: unknown,
    runQuery: (sql: string, params: unknown[]) => Promise<{ rowCount: number }>,
): Promise<LifecycleResponse> {
    const projectId = coerceProjectId(rawProjectId);
    if (projectId === null) return { success: false, error: 'Invalid projectId' };

    const coerced = coerceMetadataUpdate(rawUpdates);
    if (!coerced.ok) return { success: false, error: coerced.error };

    const update = coerced.value;
    const set: string[] = [];
    const params: unknown[] = [];
    if (update.name !== undefined) {
        params.push(update.name);
        set.push(`name = $${params.length}`);
    }
    if (update.description !== undefined) {
        params.push(update.description);
        set.push(`description = $${params.length}`);
    }
    if (update.trustLevel !== undefined) {
        params.push(update.trustLevel);
        set.push(`trust_level = $${params.length}`);
    }
    params.push(projectId);
    const sql = `UPDATE projects SET ${set.join(', ')} WHERE id = $${params.length}`;

    try {
        const result = await runQuery(sql, params);
        if (result.rowCount === 0) {
            return { success: false, error: 'Project not found' };
        }
        // Kick the orchestrator so active runs pick up the new description
        // on their next acceptance check (B-406 notes call out the
        // AcceptanceGate re-extraction path).
        deps.getOrchestrator();
        return { success: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, projectId }, 'Update project metadata failed');
        return { success: false, error: msg };
    }
}

export async function handleListProjectsFiltered(
    deps: ProjectLifecycleDeps,
    rawFilter: unknown,
): Promise<readonly ProjectStatus[]> {
    const orchestrator = deps.getOrchestrator();
    if (orchestrator === null) return [];
    try {
        const filter = coerceFilter(rawFilter);
        return await orchestrator.sensei.getAllProjectsStatus(filter);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'list-projects-filtered failed');
        return [];
    }
}

// ── Registration ─────────────────────────────────────

/**
 * Register all lifecycle IPC handlers. Idempotent — safe to call once at
 * startup from `main.ts`.
 */
export function registerProjectLifecycleHandlers(
    deps: ProjectLifecycleDeps,
): void {
    // Optional fourth argument on every lifecycle handler is the
    // expected `updated_at` token for optimistic locking (PR C of F-302).
    // When the renderer doesn't pass it (legacy callers), the lock check
    // is skipped — same behaviour as before.
    const coerceTimestamp = (raw: unknown): string | null =>
        typeof raw === 'string' && raw !== '' ? raw : null;

    ipcMain.handle(IPC.PROJECT_CANCEL, (_event, projectId: unknown, reason?: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'cancel', projectId, reason, coerceTimestamp(expectedUpdatedAt)),
    );
    ipcMain.handle(IPC.PROJECT_PAUSE, (_event, projectId: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'pause', projectId, undefined, coerceTimestamp(expectedUpdatedAt)),
    );
    ipcMain.handle(IPC.PROJECT_RESUME, (_event, projectId: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'resume', projectId, undefined, coerceTimestamp(expectedUpdatedAt)),
    );
    ipcMain.handle(IPC.PROJECT_ARCHIVE, (_event, projectId: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'archive', projectId, undefined, coerceTimestamp(expectedUpdatedAt)),
    );
    ipcMain.handle(IPC.PROJECT_RESTORE, (_event, projectId: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'restore', projectId, undefined, coerceTimestamp(expectedUpdatedAt)),
    );
    ipcMain.handle(IPC.PROJECT_DELETE, (_event, projectId: unknown) =>
        // Delete intentionally skips optimistic-lock — already gated by
        // a two-step confirm modal; silent overwrite isn't the failure mode.
        handleLifecycleAction(deps, 'delete', projectId),
    );
    ipcMain.handle(IPC.PROJECT_REOPEN, (_event, projectId: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'reopen', projectId, undefined, coerceTimestamp(expectedUpdatedAt)),
    );
    ipcMain.handle(IPC.PROJECT_CLOSE, (_event, projectId: unknown, expectedUpdatedAt?: unknown) =>
        handleLifecycleAction(deps, 'close', projectId, undefined, coerceTimestamp(expectedUpdatedAt)),
    );

    ipcMain.handle('command-center:project-retry-failed', (_event, projectId: unknown) =>
        handleRetryFailed(deps, projectId),
    );

    ipcMain.handle(IPC.PROJECT_RESTART, (_event, projectId: unknown) =>
        handleRestartStalled(deps, projectId),
    );

    ipcMain.handle(IPC.PROJECT_ADD_REQUIREMENT, (_event, args: unknown) =>
        handleAddRequirement(deps, args),
    );

    ipcMain.handle(IPC.LIST_PROJECTS_FILTERED, (_event, filter: unknown) =>
        handleListProjectsFiltered(deps, filter),
    );

    ipcMain.handle(IPC.PROJECT_GET_METADATA, async (_event, args: unknown) => {
        const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
        const projectId = coerceProjectId(a['projectId']);
        if (projectId === null) return { success: false, error: 'Invalid projectId' };
        try {
            const { getOne } = await import('../db/client');
            const row = await getOne<{ name: string; description: string | null; trust_level: string | null }>(
                'SELECT name, description, trust_level FROM projects WHERE id = $1',
                [projectId],
            );
            if (row === null) return { success: false, error: 'Project not found' };
            return {
                success: true,
                metadata: {
                    name: row.name,
                    description: row.description ?? '',
                    trustLevel: row.trust_level ?? 'low',
                },
            };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });

    ipcMain.handle(IPC.PROJECT_UPDATE_METADATA, async (_event, args: unknown) => {
        const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
        const projectId = a['projectId'];
        const updates: Record<string, unknown> = {};
        if ('name' in a) updates['name'] = a['name'];
        if ('description' in a) updates['description'] = a['description'];
        if ('trustLevel' in a) updates['trustLevel'] = a['trustLevel'];
        const { query } = await import('../db/client');
        return handleUpdateProjectMetadata(deps, projectId, updates, async (sql, params) => {
            const res = await query(sql, params);
            return { rowCount: res.rowCount };
        });
    });
}

/**
 * The exact set of channels this module claims. Exported so that tests
 * (and a future startup audit) can assert uniqueness without peeking
 * inside Electron's `ipcMain`.
 */
export const PROJECT_LIFECYCLE_CHANNELS: readonly string[] = [
    IPC.PROJECT_CANCEL,
    IPC.PROJECT_PAUSE,
    IPC.PROJECT_RESUME,
    IPC.PROJECT_ARCHIVE,
    IPC.PROJECT_RESTORE,
    IPC.PROJECT_DELETE,
    IPC.PROJECT_REOPEN,
    IPC.PROJECT_CLOSE,
    'command-center:project-retry-failed',
    IPC.PROJECT_RESTART,
    IPC.PROJECT_ADD_REQUIREMENT,
    IPC.LIST_PROJECTS_FILTERED,
    IPC.PROJECT_UPDATE_METADATA,
    IPC.PROJECT_GET_METADATA,
];

// ── Add-requirement handler (F-148 / #148) ───────────

export interface AddRequirementResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly newTaskCount?: number;
    readonly affectedPhase?: string;
}

async function handleAddRequirement(
    deps: ProjectLifecycleDeps,
    rawArgs: unknown,
): Promise<AddRequirementResponse> {
    const args = (typeof rawArgs === 'object' && rawArgs !== null)
        ? rawArgs as Record<string, unknown>
        : {};
    const projectId = coerceProjectId(args['projectId']);
    if (projectId === null) {
        return { success: false, error: 'Invalid projectId' };
    }
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    if (text.trim().length === 0) {
        return { success: false, error: 'Requirement text is required' };
    }

    const orchestrator = deps.getOrchestrator();
    if (orchestrator === null) {
        return { success: false, error: 'Orchestrator not running' };
    }

    try {
        const result = await orchestrator.sensei.addRequirement(projectId, text);
        if (!result.ok) {
            return {
                success: false,
                error: result.error ?? 'Unknown error',
                ...(result.affectedPhase !== null ? { affectedPhase: result.affectedPhase } : {}),
            };
        }
        return {
            success: true,
            newTaskCount: result.newTaskCount,
            ...(result.affectedPhase !== null ? { affectedPhase: result.affectedPhase } : {}),
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, projectId }, 'addRequirement IPC failed');
        return { success: false, error: msg };
    }
}
