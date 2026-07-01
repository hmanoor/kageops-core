/**
 * Stall Watchdog — parks silently-stuck projects in `'awaiting-approval'`
 *
 * The headless runner already guards against zombie projects (no tasks
 * decomposed within ~60s). The Electron app didn't have an equivalent —
 * so projects that stalled mid-run (e.g. an agent wedged in a retry
 * loop, a provider outage that never recovered) kept showing `'active'`
 * in the Command Center indefinitely with no tasks progressing.
 *
 * This module periodically scans `projects WHERE status='active'`, and
 * for each one compares `NOW()` against the most recent activity
 * timestamp drawn from `tasks.updated_at` / `agent_logs.created_at`.
 * When the gap exceeds the configured threshold the project is parked
 * in `'awaiting-approval'` and an `approval.required` event is emitted,
 * so the user can see the stall in the approval queue and decide to
 * retry, cancel, or dig deeper.
 *
 * Cooperative with existing lifecycle — `retryFailedTasks()` flips
 * `'awaiting-approval'` back to `'active'`, so a user-initiated retry
 * exits the watchdog-parked state without extra wiring.
 *
 * Durable-recovery (2026-06-22, #1 priority): parking-and-waiting-for-a-
 * human turned every transient stall into a manual restart — the operator's
 * "token-burner" complaint. The watchdog now AUTO-RECLAIMS first: on a stall
 * it calls `reclaim()` (Sensei.restartStalledProject — requeue in-flight
 * tasks + re-dispatch) up to `maxAutoReclaims` times, and only parks for a
 * human once auto-recovery is exhausted. A bounded counter (reset whenever
 * the project makes real forward progress — a task actually completes)
 * prevents an unrecoverable failpoint from looping forever and burning
 * tokens. Auto-reclaim is on by default; disable with KAGEOPS_AUTO_RECLAIM=0.
 */

import { EventBus } from './event-bus';
import { getMany, query } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('StallWatchdog');

// Defaults chosen to avoid false positives. The Pixel/Forge pairs can
// legitimately burn 2–3 minutes on a single askAI call; 5 minutes of
// pure silence is a strong stall signal. Override via env.
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_AUTO_RECLAIMS = 2;

/** Requeue in-flight/failed tasks and re-dispatch. Returns how many requeued. */
export type ReclaimFn = (projectId: string) => Promise<{ requeued: number }>;

/**
 * Per-project auto-reclaim bookkeeping, kept in-memory across scans for the
 * lifetime of the watchdog. `completedAtLastAttempt` is the project's
 * completed-task count at the moment we last auto-reclaimed it — when a later
 * scan sees MORE completed tasks the project genuinely advanced, so we reset
 * the attempt counter (a fresh stall at a new failpoint earns fresh attempts).
 */
interface ReclaimState {
    attempts: number;
    completedAtLastAttempt: number;
}

export interface StallWatchdogOptions {
    readonly stallTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    /** Auto-reclaim hook. When omitted, the watchdog parks immediately (legacy). */
    readonly reclaim?: ReclaimFn;
    /** Max consecutive auto-reclaims before escalating to a human park. */
    readonly maxAutoReclaims?: number;
}

/** Optional reclaim context threaded into `scanOnce` (kept separate so the
 *  2-arg `scanOnce(bus, ms)` test signature stays valid). */
export interface ScanReclaimContext {
    readonly reclaim?: ReclaimFn;
    readonly maxAutoReclaims?: number;
    /** Mutable per-project state map; created once by `startStallWatchdog`. */
    readonly state?: Map<string, ReclaimState>;
}

interface StallRow {
    readonly id: string;
    readonly name: string;
    readonly last_activity: string | null;
    readonly inflight_count: string;
    readonly completed_count: string;
}

/**
 * Start the stall watchdog. Returns a stop function — call on Electron
 * `before-quit` so the interval is cleared and no stray DB queries
 * happen during shutdown.
 */
export function startStallWatchdog(
    bus: EventBus,
    opts: StallWatchdogOptions = {},
): () => void {
    const stallTimeoutMs = opts.stallTimeoutMs
        ?? parseIntEnv('KAGEOPS_STALL_TIMEOUT_MS', DEFAULT_STALL_TIMEOUT_MS);
    const pollIntervalMs = opts.pollIntervalMs
        ?? parseIntEnv('KAGEOPS_STALL_POLL_MS', DEFAULT_POLL_INTERVAL_MS);

    // Auto-reclaim is on by default; KAGEOPS_AUTO_RECLAIM=0|false opts out
    // (falls back to legacy park-and-wait-for-human).
    const autoReclaimEnabled = parseBoolEnv('KAGEOPS_AUTO_RECLAIM', true);
    const maxAutoReclaims = opts.maxAutoReclaims
        ?? parseIntEnv('KAGEOPS_MAX_AUTO_RECLAIMS', DEFAULT_MAX_AUTO_RECLAIMS);
    const reclaim = autoReclaimEnabled ? opts.reclaim : undefined;
    const reclaimState = new Map<string, ReclaimState>();

    log.info(
        { stallTimeoutMs, pollIntervalMs, autoReclaim: reclaim !== undefined, maxAutoReclaims },
        'StallWatchdog started',
    );

    let stopped = false;
    const timer = setInterval(() => {
        if (stopped) return;
        void scanOnce(bus, stallTimeoutMs, { reclaim, maxAutoReclaims, state: reclaimState }).catch((err) => {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Stall scan failed',
            );
        });
    }, pollIntervalMs);
    // Don't hold the Electron main-process event loop open just for this
    // poller — it's strictly advisory.
    if (typeof timer.unref === 'function') timer.unref();

    return () => {
        stopped = true;
        clearInterval(timer);
        log.info('StallWatchdog stopped');
    };
}

/**
 * Exported for tests. Performs one scan+park pass against the DB.
 * Returns the list of project IDs that were parked during this call.
 */
export async function scanOnce(
    bus: EventBus,
    stallTimeoutMs: number,
    ctx: ScanReclaimContext = {},
): Promise<readonly string[]> {
    // `tasks` has no `updated_at` — the schema tracks task-level activity
    // via created_at → started_at → completed_at. Coalesce down that list
    // so an in-flight task with a stale created_at still counts as
    // activity when the agent picks it up or finishes.
    const rows = await getMany<StallRow>(
        `SELECT p.id,
                p.name,
                GREATEST(
                    p.updated_at,
                    COALESCE((SELECT MAX(COALESCE(t.completed_at, t.started_at, t.created_at))
                              FROM tasks t WHERE t.project_id = p.id), p.updated_at),
                    COALESCE((SELECT MAX(a.created_at) FROM agent_logs a WHERE a.project_id = p.id), p.updated_at)
                ) AS last_activity,
                (SELECT COUNT(*)::text FROM tasks t
                    WHERE t.project_id = p.id
                      AND t.status IN ('assigned','in-progress')
                ) AS inflight_count,
                (SELECT COUNT(*)::text FROM tasks t
                    WHERE t.project_id = p.id
                      AND t.status = 'completed'
                ) AS completed_count
         FROM projects p
         WHERE p.status = 'active'`,
        [],
    );

    const now = Date.now();
    const parked: string[] = [];
    const maxAutoReclaims = ctx.maxAutoReclaims ?? DEFAULT_MAX_AUTO_RECLAIMS;
    const state = ctx.state;

    for (const row of rows) {
        if (row.last_activity === null) continue;
        const lastMs = Date.parse(row.last_activity);
        if (!Number.isFinite(lastMs)) continue;
        const silenceMs = now - lastMs;
        if (silenceMs < stallTimeoutMs) continue;

        const inflight = parseInt(row.inflight_count, 10);
        const completed = parseIntSafe(row.completed_count);

        // ── Durable-recovery: try auto-reclaim before parking ──
        if (ctx.reclaim !== undefined) {
            const prior = state?.get(row.id);
            // Forward progress since the last attempt (a task actually
            // completed) → this is a NEW failpoint; grant fresh attempts.
            const attempts = (prior !== undefined && completed <= prior.completedAtLastAttempt)
                ? prior.attempts
                : 0;

            if (attempts < maxAutoReclaims) {
                state?.set(row.id, { attempts: attempts + 1, completedAtLastAttempt: completed });
                log.warn(
                    { projectId: row.id, name: row.name, silenceMs, inflight, attempt: attempts + 1, maxAutoReclaims },
                    'Stall detected — auto-reclaiming (requeue + re-dispatch)',
                );
                try {
                    const { requeued } = await ctx.reclaim(row.id);
                    log.info(
                        { projectId: row.id, requeued, attempt: attempts + 1 },
                        'Auto-reclaim dispatched',
                    );
                } catch (err) {
                    log.warn(
                        { err: err instanceof Error ? err.message : String(err), projectId: row.id },
                        'Auto-reclaim failed — will park on next stall if it persists',
                    );
                }
                // Don't park — give the re-dispatched work a chance.
                continue;
            }
            // Auto-recovery exhausted → fall through to the human park below.
        }

        const parkedOk = await parkProject(row.id);
        if (!parkedOk) continue;

        const exhausted = ctx.reclaim !== undefined;
        const reason = exhausted
            ? `Stall persisted after ${maxAutoReclaims} auto-recovery attempts — ` +
              `no project activity for ${Math.round(silenceMs / 1000)}s`
            : 'Stall detected — no project activity for ' +
              `${Math.round(silenceMs / 1000)}s`;

        log.warn(
            { projectId: row.id, name: row.name, silenceMs, inflight, exhausted },
            'Stall detected — parking project in awaiting-approval',
        );

        await bus.publish('approval.required', {
            projectId: row.id,
            agent: 'sensei',
            data: {
                reason,
                projectId: row.id,
                inflight,
            },
        }).catch((err) => {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), projectId: row.id },
                'approval.required publish failed',
            );
        });

        parked.push(row.id);
    }
    return parked;
}

function parseIntSafe(raw: string | null | undefined): number {
    if (raw === null || raw === undefined) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Park one project in `'awaiting-approval'`. Returns true when the row
 * actually transitioned — false on a no-op (status already changed, row
 * missing) or on DB failure. Callers should only emit side-effects when
 * the return is true so we never double-notify.
 */
async function parkProject(projectId: string): Promise<boolean> {
    try {
        const res = await query<{ id: string }>(
            `UPDATE projects
             SET status = 'awaiting-approval',
                 updated_at = NOW()
             WHERE id = $1 AND status = 'active'
             RETURNING id`,
            [projectId],
        );
        return res.rows.length > 0;
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err), projectId },
            'Failed to park project',
        );
        return false;
    }
}

function parseIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    return fallback;
}
