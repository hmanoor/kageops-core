/**
 * Minimal pool-shape for the learning module.
 *
 * The full pool contract lives in `src/db/client.ts` (`PoolLike`); we only
 * need `.query()` here. Keeping it local means tests can pass a trivial
 * `{ query: vi.fn() }` fake without importing pg types.
 */

export interface PoolQueryResult {
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
}

export interface PoolLike {
    query(sql: string, params?: readonly unknown[]): Promise<PoolQueryResult>;
}

/** Shape of a row returned by `fetchAgentLogs`'s SQL. */
export interface RewardAgentLogRow {
    readonly id: string;
    readonly task_id: string | null;
    readonly agent: string;
    readonly cost_usd: number | string | null;
    readonly tokens_out: number | string | null;
    readonly event_type: string | null;
    readonly duration_ms: number | string | null;
    readonly output_summary: string | null;
    readonly created_at: string | Date;
}
