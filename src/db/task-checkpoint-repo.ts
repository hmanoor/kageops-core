/**
 * Task-checkpoint repository (Devin-parity Phase 1 — P1-01).
 *
 * One row per resumable operation inside a task. Wraps the
 * `task_checkpoints` table created in migration 025. The contract here
 * is deliberately minimal — agents only need to record a new in-flight
 * checkpoint, mark it completed/failed, and read prior completed
 * checkpoints by `(taskId, opIndex)` to decide whether to skip work on
 * a resume.
 *
 * No call sites wire this in P1-01a (this PR) — the wiring lands in
 * P1-01b (askAI), P1-01c (writeFile), and P1-01d (exec) so each call
 * site can be reviewed independently and reverted in isolation if a
 * regression surfaces. See `docs/plans/p1-01-task-checkpointing-plan.md`
 * for the full split-PR roadmap.
 *
 * Repository pattern (per common/coding-style.md): pure data access
 * behind a typed surface so the consumer can be tested with a fake
 * repository, and the SQL stays in one place.
 */

import { getMany, getOne, query } from './client';
import { createLogger } from '../shared/logger';

const log = createLogger('TaskCheckpointRepo');

/**
 * Whether task-checkpoint output caching (the engine behind output-cached
 * resume) is active. ON by default as of the durable-recovery work;
 * `KAGEOPS_TASK_CHECKPOINTS=false|0|off|no` is the kill-switch. Single
 * source of truth so the agent call sites and the orchestrator's
 * resume-summary logging agree on the default.
 */
export function taskCheckpointsEnabled(): boolean {
    const v = process.env['KAGEOPS_TASK_CHECKPOINTS'];
    if (v === undefined || v === '') return true;
    const lower = v.trim().toLowerCase();
    return !(lower === 'false' || lower === '0' || lower === 'off' || lower === 'no');
}

// ── Types ──────────────────────────────────────────────────────────

/**
 * Operation kind. Mirrors the CHECK constraint on `task_checkpoints.op_type`.
 *  - `askai` — an `askAI()` call. payload carries promptHash + model;
 *    output carries the response text + token / cost telemetry.
 *  - `write` — a `writeFile()` to the task workspace. payload carries
 *    repoPath + relative filePath + content sha256; output carries the
 *    bytesWritten count.
 *  - `exec`  — a child-process spawn (e.g. `npm test`). payload carries
 *    command + args + cwd; output carries exit code + stdout/err
 *    previews + durationMs.
 *  - `other` — escape hatch for one-off ops the agent wants to make
 *    idempotent without polluting the type union.
 */
export type CheckpointOpType = 'askai' | 'write' | 'exec' | 'other';

/**
 * In-flight = the operation row has been written but has not yet
 * completed (or the process crashed before reporting). Completed =
 * the operation succeeded and `output_json` is the cached payload
 * to return on a resume. Failed = the operation errored; the
 * `error_text` is the surfaced message, and the agent's retry path
 * decides what to do next.
 */
export type CheckpointStatus = 'in-flight' | 'completed' | 'failed';

/**
 * One checkpoint row as persisted in `task_checkpoints`. Mirrors the
 * table columns one-for-one. The JSONB columns are typed as `unknown`
 * here — callers narrow via their own shape oracle when reading
 * `output_json` back, because op-specific shapes don't generalise
 * cleanly to a single discriminated union without making the table
 * surface awkward for the `other` escape hatch.
 */
export interface TaskCheckpointRow {
    readonly id: string;
    readonly taskId: string;
    readonly opIndex: number;
    readonly opType: CheckpointOpType;
    readonly status: CheckpointStatus;
    readonly payloadJson: unknown;
    readonly outputJson: unknown | null;
    readonly errorText: string | null;
    readonly createdAt: string;
    readonly completedAt: string | null;
}

/**
 * Input shape for `recordStart()`. The agent supplies the deterministic
 * `(taskId, opIndex)` — the repo fills in `id`, `created_at`, and
 * defaults `status` to `in-flight`. `payloadJson` is op-specific (see
 * {@link CheckpointOpType}).
 */
export interface NewCheckpoint {
    readonly taskId: string;
    readonly opIndex: number;
    readonly opType: CheckpointOpType;
    readonly payloadJson: unknown;
}

/**
 * Repository contract — what the resumable agent path needs. Tests
 * inject a fake implementation that records calls.
 */
export interface TaskCheckpointRepository {
    /**
     * Record a new in-flight checkpoint. Returns the persisted row.
     * Throws on `(taskId, opIndex)` collision so the caller knows the
     * resume lookup race was lost (shouldn't happen — agents are
     * single-threaded per task — but the unique index guarantees it).
     */
    recordStart(input: NewCheckpoint): Promise<TaskCheckpointRow>;

    /**
     * Mark a prior `recordStart()` as completed. `outputJson` is the
     * cached payload the resume path returns on a hit.
     */
    markCompleted(id: string, outputJson: unknown): Promise<void>;

    /**
     * Mark a prior `recordStart()` as failed with a surfaced error
     * message. The agent's retry path consults this when deciding
     * whether to re-execute on resume.
     */
    markFailed(id: string, errorText: string): Promise<void>;

    /**
     * Look up a single checkpoint by `(taskId, opIndex)`. Returns `null`
     * when no row exists — the agent then executes the op for real.
     * Returns the row otherwise; the resume policy lives in the caller.
     */
    findByOp(taskId: string, opIndex: number): Promise<TaskCheckpointRow | null>;

    /**
     * List every checkpoint for a task in `op_index` order. Used by
     * the resume path to figure out the next `opIndex` to assign and
     * by the operator UI / run report to render the op timeline.
     */
    listForTask(taskId: string): Promise<readonly TaskCheckpointRow[]>;

    /**
     * Delete every checkpoint for a task. Used when a task is being
     * deliberately re-executed from scratch (operator-initiated
     * retry, not crash-resume). DB cascades on task delete handle
     * the parent-row-gone case automatically.
     */
    deleteForTask(taskId: string): Promise<void>;
}

// ── Production implementation ──────────────────────────────────────

/**
 * Map a raw `pg` row (snake_case) onto the typed `TaskCheckpointRow`
 * (camelCase). Centralised here so the SQL strings can stay focused
 * on the query.
 */
interface RawRow {
    id: string;
    task_id: string;
    op_index: number;
    op_type: CheckpointOpType;
    status: CheckpointStatus;
    payload_json: unknown;
    output_json: unknown | null;
    error_text: string | null;
    created_at: string;
    completed_at: string | null;
}

function mapRow(row: RawRow): TaskCheckpointRow {
    return {
        id: row.id,
        taskId: row.task_id,
        opIndex: row.op_index,
        opType: row.op_type,
        status: row.status,
        payloadJson: row.payload_json,
        outputJson: row.output_json,
        errorText: row.error_text,
        createdAt: row.created_at,
        completedAt: row.completed_at,
    };
}

export const taskCheckpointRepository: TaskCheckpointRepository = {
    async recordStart(input: NewCheckpoint): Promise<TaskCheckpointRow> {
        const row = await getOne<RawRow>(
            `INSERT INTO task_checkpoints
                 (task_id, op_index, op_type, status, payload_json)
             VALUES ($1, $2, $3, 'in-flight', $4::jsonb)
             RETURNING *`,
            [
                input.taskId,
                input.opIndex,
                input.opType,
                JSON.stringify(input.payloadJson ?? {}),
            ],
        );
        if (row === null) {
            throw new Error(
                `task_checkpoints insert returned no row for taskId=${input.taskId} opIndex=${input.opIndex}`,
            );
        }
        log.debug(
            { taskId: input.taskId, opIndex: input.opIndex, opType: input.opType, id: row.id },
            'checkpoint recorded (in-flight)',
        );
        return mapRow(row);
    },

    async markCompleted(id: string, outputJson: unknown): Promise<void> {
        await query(
            `UPDATE task_checkpoints
                SET status       = 'completed',
                    output_json  = $2::jsonb,
                    completed_at = NOW()
              WHERE id = $1`,
            [id, JSON.stringify(outputJson ?? null)],
        );
    },

    async markFailed(id: string, errorText: string): Promise<void> {
        await query(
            `UPDATE task_checkpoints
                SET status       = 'failed',
                    error_text   = $2,
                    completed_at = NOW()
              WHERE id = $1`,
            [id, errorText],
        );
    },

    async findByOp(taskId: string, opIndex: number): Promise<TaskCheckpointRow | null> {
        const row = await getOne<RawRow>(
            `SELECT * FROM task_checkpoints
              WHERE task_id = $1 AND op_index = $2
              LIMIT 1`,
            [taskId, opIndex],
        );
        return row === null ? null : mapRow(row);
    },

    async listForTask(taskId: string): Promise<readonly TaskCheckpointRow[]> {
        const rows = await getMany<RawRow>(
            `SELECT * FROM task_checkpoints
              WHERE task_id = $1
              ORDER BY op_index ASC`,
            [taskId],
        );
        return rows.map(mapRow);
    },

    async deleteForTask(taskId: string): Promise<void> {
        await query(
            `DELETE FROM task_checkpoints WHERE task_id = $1`,
            [taskId],
        );
    },
};

// ── Test helpers ───────────────────────────────────────────────────

/**
 * In-memory fake for unit tests that don't want to spin up PGlite.
 * Mirrors the production semantics exactly for the four flows the
 * resume path relies on: unique `(taskId, opIndex)`, status
 * transitions, cascade-on-delete-task, ordered listing.
 */
export function createInMemoryTaskCheckpointRepository(): TaskCheckpointRepository {
    const rows = new Map<string, TaskCheckpointRow>();
    const key = (taskId: string, opIndex: number): string => `${taskId}::${opIndex}`;

    let nextId = 1;
    const fakeId = (): string => `ck-${nextId++}`;
    const fakeNow = (): string => new Date().toISOString();

    return {
        async recordStart(input) {
            if (rows.has(key(input.taskId, input.opIndex))) {
                throw new Error(
                    `duplicate checkpoint (taskId=${input.taskId}, opIndex=${input.opIndex})`,
                );
            }
            const row: TaskCheckpointRow = {
                id: fakeId(),
                taskId: input.taskId,
                opIndex: input.opIndex,
                opType: input.opType,
                status: 'in-flight',
                payloadJson: input.payloadJson,
                outputJson: null,
                errorText: null,
                createdAt: fakeNow(),
                completedAt: null,
            };
            rows.set(key(input.taskId, input.opIndex), row);
            return row;
        },

        async markCompleted(id, outputJson) {
            for (const [k, row] of rows) {
                if (row.id === id) {
                    rows.set(k, {
                        ...row,
                        status: 'completed',
                        outputJson,
                        completedAt: fakeNow(),
                    });
                    return;
                }
            }
        },

        async markFailed(id, errorText) {
            for (const [k, row] of rows) {
                if (row.id === id) {
                    rows.set(k, {
                        ...row,
                        status: 'failed',
                        errorText,
                        completedAt: fakeNow(),
                    });
                    return;
                }
            }
        },

        async findByOp(taskId, opIndex) {
            return rows.get(key(taskId, opIndex)) ?? null;
        },

        async listForTask(taskId) {
            return Array.from(rows.values())
                .filter((r) => r.taskId === taskId)
                .sort((a, b) => a.opIndex - b.opIndex);
        },

        async deleteForTask(taskId) {
            for (const k of Array.from(rows.keys())) {
                if (rows.get(k)?.taskId === taskId) rows.delete(k);
            }
        },
    };
}
