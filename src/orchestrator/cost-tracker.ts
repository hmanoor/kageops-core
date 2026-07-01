/**
 * KageOps Cost Tracker
 *
 * Tracks per-project AI spending from agent_logs, enforces budgets,
 * and emits cost warning/exceeded events via the EventBus.
 */

import { query, getOne } from '../db/client';
import { EventBus } from './event-bus';
import { createLogger } from '../shared/logger';

const log = createLogger('CostTracker');

// ── Types ────────────────────────────────────────────

export interface BudgetStatus {
    readonly budgetUsd: number | null;
    readonly spentUsd: number;
    readonly remainingUsd: number | null;
    readonly exceeded: boolean;
    readonly warningThreshold: boolean;
}

// ── Errors ───────────────────────────────────────────

export class BudgetExceededError extends Error {
    readonly projectId: string;
    readonly budgetUsd: number;
    readonly spentUsd: number;

    constructor(projectId: string, budgetUsd: number, spentUsd: number) {
        super(
            `Budget exceeded for project ${projectId}: ` +
            `$${spentUsd.toFixed(4)} spent of $${budgetUsd.toFixed(2)} budget`
        );
        this.name = 'BudgetExceededError';
        this.projectId = projectId;
        this.budgetUsd = budgetUsd;
        this.spentUsd = spentUsd;
    }
}

// ── Constants ────────────────────────────────────────

const WARNING_THRESHOLD = 0.8; // 80% of budget

// ── Cost Tracker ─────────────────────────────────────

export class CostTracker {
    private readonly eventBus: EventBus | null;
    private readonly emittedExceeded = new Map<string, boolean>();
    private readonly emittedWarning = new Map<string, boolean>();

    constructor(eventBus?: EventBus) {
        this.eventBus = eventBus ?? null;
    }

    /**
     * Clear idempotency state for a project. Call after a budget cap is raised
     * so the next transition re-emits `cost.warning` / `cost.exceeded`.
     */
    resetThresholdState(projectId: string): void {
        this.emittedExceeded.delete(projectId);
        this.emittedWarning.delete(projectId);
    }

    /**
     * Get total amount spent on a project from agent_logs.
     */
    async getProjectSpent(projectId: string): Promise<number> {
        const result = await getOne<{ total: string }>(
            `SELECT COALESCE(SUM(cost_usd), 0) AS total
             FROM agent_logs WHERE project_id = $1`,
            [projectId]
        );

        return parseFloat(result?.total ?? '0');
    }

    /**
     * Get the budget and spending for a project.
     */
    async getProjectBudget(projectId: string): Promise<BudgetStatus> {
        const project = await getOne<{ budget_usd: string | null; spent_usd: string }>(
            'SELECT budget_usd, spent_usd FROM projects WHERE id = $1',
            [projectId]
        );

        const budgetUsd = project?.budget_usd !== null && project?.budget_usd !== undefined
            ? parseFloat(project.budget_usd)
            : null;
        const spentUsd = parseFloat(project?.spent_usd ?? '0');

        return this.buildBudgetStatus(budgetUsd, spentUsd);
    }

    /**
     * Set a budget for a project.
     */
    async setBudget(projectId: string, budgetUsd: number): Promise<void> {
        await query(
            'UPDATE projects SET budget_usd = $1 WHERE id = $2',
            [budgetUsd, projectId]
        );
    }

    /**
     * Check budget status. Returns whether the budget is exceeded or at warning.
     */
    async checkBudget(projectId: string): Promise<BudgetStatus> {
        return this.getProjectBudget(projectId);
    }

    /**
     * Record a cost for a project. Increments spent_usd on the projects table
     * and checks budget thresholds.
     */
    async recordCost(projectId: string, costUsd: number): Promise<BudgetStatus> {
        // Increment spent_usd
        await query(
            'UPDATE projects SET spent_usd = spent_usd + $1 WHERE id = $2',
            [costUsd, projectId]
        );

        // Check current budget status
        const status = await this.getProjectBudget(projectId);

        // Emit events only on threshold *transitions* (idempotency — fixes TD-002).
        // A project in the exceeded state must not re-publish `cost.exceeded` on
        // every subsequent call; same for `cost.warning`.
        if (status.exceeded) {
            if (this.emittedExceeded.get(projectId) !== true) {
                await this.emitCostEvent('cost.exceeded', projectId, status);
                this.emittedExceeded.set(projectId, true);
            }
        } else if (status.warningThreshold) {
            if (this.emittedWarning.get(projectId) !== true) {
                await this.emitCostEvent('cost.warning', projectId, status);
                this.emittedWarning.set(projectId, true);
            }
            this.emittedExceeded.delete(projectId);
        } else {
            // Below warning threshold — clear both gates so future transitions re-emit.
            this.emittedExceeded.delete(projectId);
            this.emittedWarning.delete(projectId);
        }

        return status;
    }

    /**
     * Check budget and throw BudgetExceededError if exceeded.
     * Used before making AI calls to prevent overspending.
     */
    async enforceBudget(projectId: string): Promise<void> {
        const status = await this.getProjectBudget(projectId);

        if (status.exceeded && status.budgetUsd !== null) {
            throw new BudgetExceededError(
                projectId,
                status.budgetUsd,
                status.spentUsd
            );
        }
    }

    // ── Private ──────────────────────────────────────

    private buildBudgetStatus(budgetUsd: number | null, spentUsd: number): BudgetStatus {
        if (budgetUsd === null) {
            // No budget set — unlimited
            return {
                budgetUsd: null,
                spentUsd,
                remainingUsd: null,
                exceeded: false,
                warningThreshold: false,
            };
        }

        const remaining = budgetUsd - spentUsd;

        return {
            budgetUsd,
            spentUsd,
            remainingUsd: remaining,
            exceeded: spentUsd > budgetUsd,
            warningThreshold: spentUsd >= budgetUsd * WARNING_THRESHOLD,
        };
    }

    private async emitCostEvent(
        channel: 'cost.warning' | 'cost.exceeded',
        projectId: string,
        status: BudgetStatus
    ): Promise<void> {
        if (this.eventBus === null) return;

        try {
            await this.eventBus.publish(channel, {
                projectId,
                agent: 'sensei',
                data: {
                    budgetUsd: status.budgetUsd,
                    spentUsd: status.spentUsd,
                    remainingUsd: status.remainingUsd,
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg, channel }, 'Failed to emit cost event');
        }
    }
}
