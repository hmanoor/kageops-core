/**
 * KageOps Operational Cost Tracker
 *
 * Syncs LiteLLM_SpendLogs → operational_costs table every 60 seconds.
 * Provides aggregated cost summaries for the Command Center dashboard.
 *
 * Two cost types:
 *   'project'  = tokens agents spent building user projects
 *   'platform' = KageOps overhead (Sensei reasoning, phase gates, etc.)
 */

import { query, getMany, getOne } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('OperationalCostTracker');

// ── Types ─────────────────────────────────────────────

export interface AgentCostEntry {
    readonly agent: string;
    readonly totalCostUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly callCount: number;
}

export interface ProviderCostEntry {
    readonly provider: string;
    readonly totalCostUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly callCount: number;
}

export interface ProjectCostEntry {
    readonly projectId: string;
    readonly projectName: string | null;
    readonly totalCostUsd: number;
    readonly callCount: number;
}

export interface OperationalCostSummary {
    readonly totalToday: number;
    readonly totalThisWeek: number;
    readonly totalThisMonth: number;
    readonly byAgent: readonly AgentCostEntry[];
    readonly byProvider: readonly ProviderCostEntry[];
    readonly byProject: readonly ProjectCostEntry[];
    readonly lastSyncAt: Date | null;
}

interface LiteLLMSpendRow {
    readonly request_id: string;
    readonly startTime: Date;
    readonly model: string;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly spend: number;
    readonly custom_llm_provider: string | null;
    readonly metadata: Record<string, unknown> | null;
}

interface OperationalCostRow {
    readonly id: string;
    readonly agent: string | null;
    readonly project_id: string | null;
    readonly provider: string;
    readonly model: string;
    readonly tokens_in: number;
    readonly tokens_out: number;
    readonly cost_usd: string;
    readonly litellm_request_id: string | null;
    readonly cost_type: 'project' | 'platform';
    readonly created_at: Date;
}

// ── Params for direct cost recording (Claude CLI bypasses LiteLLM) ──

export interface DirectCostParams {
    readonly agent?: string;
    readonly projectId?: string;
    readonly taskId?: string;
    readonly provider: string;
    readonly model: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly costType: 'project' | 'platform';
}

// ── OperationalCostTracker ────────────────────────────

export class OperationalCostTracker {
    private lastSyncAt: Date | null = null;
    private syncInterval: ReturnType<typeof setInterval> | null = null;
    private readonly syncIntervalMs: number;

    constructor(syncIntervalMs = 60_000) {
        this.syncIntervalMs = syncIntervalMs;
    }

    // ── Public API ──────────────────────────────────────

    /**
     * Start periodic sync from LiteLLM_SpendLogs.
     * Calls syncFromLiteLLM() immediately then every syncIntervalMs.
     */
    start(): void {
        // Initial sync — don't block startup on failure
        void this.syncFromLiteLLM().catch((err: unknown) => {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Initial LiteLLM sync failed — will retry on next interval'
            );
        });

        this.syncInterval = setInterval(() => {
            void this.syncFromLiteLLM().catch((err: unknown) => {
                log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'LiteLLM sync failed'
                );
            });
        }, this.syncIntervalMs);
    }

    /**
     * Stop the sync interval. Call during app shutdown.
     */
    stop(): void {
        if (this.syncInterval !== null) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    /**
     * Pull new rows from LiteLLM_SpendLogs and upsert into operational_costs.
     * Uses ON CONFLICT DO NOTHING for idempotency — safe to call repeatedly.
     */
    async syncFromLiteLLM(): Promise<void> {
        // Check if LiteLLM tables exist before querying
        const tableExists = await this.liteLLMTableExists();
        if (!tableExists) {
            log.debug('LiteLLM_SpendLogs table not found — skipping sync (LiteLLM not running?)');
            return;
        }

        const since = this.lastSyncAt ?? new Date(0);

        let rows: readonly LiteLLMSpendRow[];
        try {
            rows = await getMany<LiteLLMSpendRow>(
                `SELECT
                    request_id,
                    "startTime",
                    model,
                    prompt_tokens,
                    completion_tokens,
                    spend,
                    custom_llm_provider,
                    metadata
                 FROM "LiteLLM_SpendLogs"
                 WHERE "startTime" > $1
                 ORDER BY "startTime" ASC
                 LIMIT 1000`,
                [since]
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err: message }, 'Failed to query LiteLLM_SpendLogs');
            return;
        }

        if (rows.length === 0) {
            return;
        }

        let inserted = 0;
        for (const row of rows) {
            const provider = row.custom_llm_provider ?? extractProvider(row.model);
            const agent = extractMetadataString(row.metadata, 'agent');
            const projectId = extractMetadataString(row.metadata, 'project_id');
            const taskId = extractMetadataString(row.metadata, 'task_id');
            const costType = extractMetadataString(row.metadata, 'cost_type') === 'platform'
                ? 'platform'
                : 'project';

            try {
                const result = await query(
                    `INSERT INTO operational_costs
                        (agent, project_id, task_id, provider, model,
                         tokens_in, tokens_out, cost_usd, litellm_request_id,
                         cost_type, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     ON CONFLICT (litellm_request_id) DO NOTHING`,
                    [
                        agent ?? null,
                        projectId ?? null,
                        taskId ?? null,
                        provider,
                        row.model,
                        row.prompt_tokens,
                        row.completion_tokens,
                        row.spend,
                        row.request_id,
                        costType,
                        row.startTime,
                    ]
                );
                inserted += result.rowCount;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.warn({ err: message, requestId: row.request_id }, 'Failed to insert spend row');
            }
        }

        this.lastSyncAt = new Date();
        log.debug({ inserted, total: rows.length }, 'LiteLLM sync complete');
    }

    /**
     * Record a cost entry directly (for Claude CLI calls that bypass LiteLLM).
     */
    async recordDirectCost(params: DirectCostParams): Promise<void> {
        await query(
            `INSERT INTO operational_costs
                (agent, project_id, task_id, provider, model,
                 tokens_in, tokens_out, cost_usd, litellm_request_id, cost_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)`,
            [
                params.agent ?? null,
                params.projectId ?? null,
                params.taskId ?? null,
                params.provider,
                params.model,
                params.tokensIn,
                params.tokensOut,
                params.costUsd,
                params.costType,
            ]
        );
    }

    /**
     * Get aggregated cost summary for the Command Center dashboard.
     * @param windowDays - Number of days to look back (default 30)
     */
    async getOperationalSummary(windowDays = 30): Promise<OperationalCostSummary> {
        const now = new Date();
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const windowStart = new Date(now);
        windowStart.setDate(now.getDate() - windowDays);

        const [todayResult, weekResult, monthResult, byAgentRows, byProviderRows, byProjectRows] =
            await Promise.all([
                this.sumCosts(startOfToday),
                this.sumCosts(startOfWeek),
                this.sumCosts(startOfMonth),
                this.costsByAgent(windowStart),
                this.costsByProvider(windowStart),
                this.costsByProject(windowStart),
            ]);

        return {
            totalToday: todayResult,
            totalThisWeek: weekResult,
            totalThisMonth: monthResult,
            byAgent: byAgentRows,
            byProvider: byProviderRows,
            byProject: byProjectRows,
            lastSyncAt: this.lastSyncAt,
        };
    }

    // ── Private query helpers ───────────────────────────
    //
    // Cost data lives in two places:
    //   operational_costs — synced from LiteLLM_SpendLogs (when LiteLLM runs)
    //   agent_logs        — written directly by agents on every askAI() call
    //
    // The Command Center panel needs to reflect cost from both so live
    // headless runs (which populate agent_logs but not operational_costs)
    // show up in real time. UNIFIED_COSTS_CTE normalizes both sources.

    private static readonly UNIFIED_COSTS_CTE = `
        WITH unified_costs AS (
            SELECT agent, project_id, provider,
                   tokens_in, tokens_out, cost_usd, created_at
            FROM operational_costs
            UNION ALL
            SELECT agent, project_id,
                   CASE
                       WHEN position('/' in model_used) > 0 THEN split_part(model_used, '/', 1)
                       WHEN model_used LIKE 'claude%' THEN 'anthropic'
                       WHEN model_used LIKE 'gpt%' THEN 'openai'
                       WHEN model_used LIKE 'gemini%' THEN 'google'
                       ELSE COALESCE(model_used, 'unknown')
                   END AS provider,
                   COALESCE(tokens_in, 0) AS tokens_in,
                   COALESCE(tokens_out, 0) AS tokens_out,
                   COALESCE(cost_usd, 0) AS cost_usd,
                   created_at
            FROM agent_logs
            WHERE cost_usd IS NOT NULL AND cost_usd > 0
        )
    `;

    private async sumCosts(since: Date): Promise<number> {
        const row = await getOne<{ total: string }>(
            `${OperationalCostTracker.UNIFIED_COSTS_CTE}
             SELECT COALESCE(SUM(cost_usd), 0)::text AS total
             FROM unified_costs
             WHERE created_at >= $1`,
            [since]
        );
        return parseFloat(row?.total ?? '0');
    }

    private async costsByAgent(since: Date): Promise<readonly AgentCostEntry[]> {
        const rows = await getMany<{
            agent: string | null;
            total_cost: string;
            tokens_in: string;
            tokens_out: string;
            call_count: string;
        }>(
            `${OperationalCostTracker.UNIFIED_COSTS_CTE}
             SELECT
                COALESCE(agent, 'unknown') AS agent,
                SUM(cost_usd)::text AS total_cost,
                SUM(tokens_in)::text AS tokens_in,
                SUM(tokens_out)::text AS tokens_out,
                COUNT(*)::text AS call_count
             FROM unified_costs
             WHERE created_at >= $1
             GROUP BY COALESCE(agent, 'unknown')
             ORDER BY SUM(cost_usd) DESC`,
            [since]
        );

        return rows.map((r) => ({
            agent: r.agent ?? 'unknown',
            totalCostUsd: parseFloat(r.total_cost),
            tokensIn: parseInt(r.tokens_in, 10),
            tokensOut: parseInt(r.tokens_out, 10),
            callCount: parseInt(r.call_count, 10),
        }));
    }

    private async costsByProvider(since: Date): Promise<readonly ProviderCostEntry[]> {
        const rows = await getMany<{
            provider: string;
            total_cost: string;
            tokens_in: string;
            tokens_out: string;
            call_count: string;
        }>(
            `${OperationalCostTracker.UNIFIED_COSTS_CTE}
             SELECT
                provider,
                SUM(cost_usd)::text AS total_cost,
                SUM(tokens_in)::text AS tokens_in,
                SUM(tokens_out)::text AS tokens_out,
                COUNT(*)::text AS call_count
             FROM unified_costs
             WHERE created_at >= $1
             GROUP BY provider
             ORDER BY SUM(cost_usd) DESC`,
            [since]
        );

        return rows.map((r) => ({
            provider: r.provider,
            totalCostUsd: parseFloat(r.total_cost),
            tokensIn: parseInt(r.tokens_in, 10),
            tokensOut: parseInt(r.tokens_out, 10),
            callCount: parseInt(r.call_count, 10),
        }));
    }

    private async costsByProject(since: Date): Promise<readonly ProjectCostEntry[]> {
        const rows = await getMany<{
            project_id: string | null;
            project_name: string | null;
            total_cost: string;
            call_count: string;
        }>(
            `${OperationalCostTracker.UNIFIED_COSTS_CTE}
             SELECT
                uc.project_id,
                p.name AS project_name,
                SUM(uc.cost_usd)::text AS total_cost,
                COUNT(*)::text AS call_count
             FROM unified_costs uc
             LEFT JOIN projects p ON p.id = uc.project_id
             WHERE uc.created_at >= $1
             GROUP BY uc.project_id, p.name
             ORDER BY SUM(uc.cost_usd) DESC`,
            [since]
        );

        return rows.map((r) => ({
            projectId: r.project_id ?? 'platform',
            projectName: r.project_name,
            totalCostUsd: parseFloat(r.total_cost),
            callCount: parseInt(r.call_count, 10),
        }));
    }

    private async liteLLMTableExists(): Promise<boolean> {
        try {
            const result = await getOne<{ exists: boolean }>(
                `SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'public'
                    AND table_name = 'LiteLLM_SpendLogs'
                ) AS exists`
            );
            return result?.exists ?? false;
        } catch {
            return false;
        }
    }
}

// ── Utilities ─────────────────────────────────────────

/** Extract provider name from a LiteLLM model string like "claude/claude-sonnet-4-20250514" */
function extractProvider(model: string): string {
    const slash = model.indexOf('/');
    return slash >= 0 ? model.slice(0, slash) : 'unknown';
}

/** Safely extract a string from LiteLLM metadata JSONB */
function extractMetadataString(
    metadata: Record<string, unknown> | null,
    key: string
): string | null {
    if (metadata === null || typeof metadata !== 'object') {
        return null;
    }
    const value = metadata[key];
    return typeof value === 'string' ? value : null;
}

// ── Singleton factory ─────────────────────────────────

let instance: OperationalCostTracker | null = null;

/**
 * Get or create the shared OperationalCostTracker singleton.
 * Use this in orchestrator-bootstrap.ts.
 */
export function getOperationalCostTracker(syncIntervalMs?: number): OperationalCostTracker {
    if (instance === null) {
        instance = new OperationalCostTracker(syncIntervalMs);
    }
    return instance;
}

/** Reset singleton — for testing only. */
export function resetOperationalCostTrackerForTesting(): void {
    instance = null;
}
