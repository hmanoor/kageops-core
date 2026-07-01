/**
 * KageOps Learning — Reward from logs (Phase 4, APO iter 1)
 *
 * Mines `agent_logs` to produce a scalar reward signal per task. The reward
 * is a bounded scalar in [-1, 1]:
 *
 *   status === 'success'    →  1 - min(costUsd * 4, 0.8)    (range [0.2, 1.0])
 *   status === 'escalated'  → -0.2
 *   status === 'failed'     → -0.5
 *   status === 'unknown'    →  0  (no signal)
 *
 * Why the success formula:
 *   - Floor at 0.2 keeps a successful-but-expensive run strictly positive so
 *     agents aren't punished for completing difficult work.
 *   - Linear slope with coefficient 4 means a $0.05 task scores ~0.8, a $0.20
 *     task scores 0.2 (hits the floor). This matches the budget guardrail
 *     (KAGEOPS_MAX_RUN_USD default $0.25) — anything over ~$0.20 saturates.
 *   - Escalation (-0.2) is milder than failure (-0.5): escalation means "I
 *     couldn't finish alone" whereas failure means "I finished wrong."
 *
 * Events are normalized upstream in `fetchAgentLogs` — see `AgentLogStatus`.
 */

import type { PoolLike, RewardAgentLogRow } from './pool-shape';
import type { AgentLog, AgentLogStatus, RewardAggregate } from './types';

// ── Reward ───────────────────────────────────────────

const SUCCESS_COST_SLOPE = 4;
const SUCCESS_COST_CAP = 0.8;
const ESCALATED_PENALTY = -0.2;
const FAILED_PENALTY = -0.5;

/**
 * Derive a scalar reward for a single log row.
 * Pure function — safe to call repeatedly; never mutates the input.
 */
export function deriveReward(log: AgentLog): number {
    switch (log.status) {
        case 'success': {
            const cost = Math.max(0, log.costUsd);
            const penalty = Math.min(cost * SUCCESS_COST_SLOPE, SUCCESS_COST_CAP);
            return 1 - penalty;
        }
        case 'escalated':
            return ESCALATED_PENALTY;
        case 'failed':
            return FAILED_PENALTY;
        case 'unknown':
        default:
            return 0;
    }
}

// ── Aggregation ──────────────────────────────────────

/**
 * Aggregate reward stats over a batch of logs.
 * `p50` is the 50th-percentile reward using nearest-rank (upper median on
 * even-sized arrays) — consistent with the hoisted test expectations.
 */
export function aggregateRewards(logs: readonly AgentLog[]): RewardAggregate {
    const n = logs.length;
    if (n === 0) {
        return { mean: 0, n: 0, p50: 0 };
    }

    const rewards = logs.map(deriveReward);
    const sum = rewards.reduce((acc, r) => acc + r, 0);
    const mean = sum / n;

    const sorted = [...rewards].sort((a, b) => a - b);
    const midIdx = Math.floor(n / 2);
    // Nearest-rank median: upper of the two central values when n is even.
    const p50 = sorted[midIdx] ?? 0;

    return { mean, n, p50 };
}

// ── Fetch ────────────────────────────────────────────

/**
 * Map a raw event_type → normalized status.
 *   task.completed          → success
 *   task.failed             → failed
 *   approval.required       → escalated  (tiered-retry gate)
 *   task.escalated          → escalated  (explicit)
 *   anything else           → unknown    (filtered by the SQL WHERE clause)
 */
export function eventTypeToStatus(eventType: string | null | undefined): AgentLogStatus {
    if (eventType === 'task.completed') return 'success';
    if (eventType === 'task.failed') return 'failed';
    if (eventType === 'approval.required') return 'escalated';
    if (eventType === 'task.escalated') return 'escalated';
    return 'unknown';
}

/**
 * Fetch the most recent reward-bearing logs for an agent.
 *
 * Only rows whose `event_type` maps to a non-'unknown' status are returned.
 * Ordered newest-first.
 *
 * Implementation notes:
 *   - `pool` is accepted as a parameter (instead of reading `getPool()`) so
 *     tests can inject a deterministic fake without mocking the whole module.
 *   - `agent_logs.agent` is the canonical column name (see src/db/schema.sql).
 *     We normalize to lowercase to match how specialists register themselves.
 */
export async function fetchAgentLogs(
    pool: PoolLike,
    agentName: string,
    limit = 50
): Promise<readonly AgentLog[]> {
    const normalized = agentName.toLowerCase();
    const sql = `
        SELECT id,
               task_id,
               agent,
               COALESCE(cost_usd, 0) AS cost_usd,
               COALESCE(tokens_out, 0) AS tokens_out,
               event_type,
               COALESCE(duration_ms, 0) AS duration_ms,
               COALESCE(output_summary, '') AS output_summary,
               created_at
        FROM agent_logs
        WHERE LOWER(agent) = $1
          AND event_type IN (
              'task.completed',
              'task.failed',
              'approval.required',
              'task.escalated'
          )
        ORDER BY created_at DESC
        LIMIT $2
    `;
    const result = await pool.query(sql, [normalized, limit]);
    const rows = (result?.rows ?? []) as unknown as readonly RewardAgentLogRow[];
    return Object.freeze(rows.map(mapRowToAgentLog));
}

// ── Helpers ──────────────────────────────────────────

function mapRowToAgentLog(row: RewardAgentLogRow): AgentLog {
    const costUsd = toNumber(row.cost_usd);
    const tokensOut = toNumber(row.tokens_out);
    const durationMs = toNumber(row.duration_ms);
    return Object.freeze({
        id: String(row.id),
        taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
        agentName: String(row.agent ?? ''),
        costUsd,
        tokensOut,
        status: eventTypeToStatus(row.event_type),
        durationMs,
        outputSummary: String(row.output_summary ?? ''),
        createdAt: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at ?? ''),
    });
}

function toNumber(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const parsed = Number(v);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
