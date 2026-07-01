/**
 * KageOps Task Router
 *
 * Routes tasks to the best agent using the speciality matrix.
 * Supports manual overrides for human-assigned tasks.
 */

import { query, getOne } from '../db/client';
import { EventBus } from './event-bus';
import { SpecialityMatrix } from './speciality-matrix';
import { AgentRegistry } from '../agents/agent-registry';

// ── Types ────────────────────────────────────────────

export interface TaskRecord {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly taskType: string;
    readonly phase: string;
    readonly assignedAgent: string | null;
    readonly status: string;
    readonly priority: number;
    readonly dependsOn: readonly string[];
}

export interface RouteResult {
    readonly taskId: string;
    readonly agent: string;
    readonly score: number;
    readonly reason: string;
}

// ── Task Router ──────────────────────────────────────

export class TaskRouter {
    private readonly matrix: SpecialityMatrix;
    private readonly eventBus: EventBus;
    private readonly agentRegistry: AgentRegistry | null;

    constructor(matrix: SpecialityMatrix, eventBus: EventBus, agentRegistry?: AgentRegistry) {
        this.matrix = matrix;
        this.eventBus = eventBus;
        this.agentRegistry = agentRegistry ?? null;
    }

    /**
     * Route a task to the best agent based on the speciality matrix.
     * If the task already has an assigned agent (manual override), use that.
     */
    async routeTask(taskId: string): Promise<RouteResult> {
        const task = await getOne<TaskRecord>(
            `SELECT id, project_id as "projectId", title, description, task_type as "taskType",
                    phase, assigned_agent as "assignedAgent", status, priority, depends_on as "dependsOn"
             FROM tasks WHERE id = $1`,
            [taskId]
        );

        if (task === null) {
            throw new Error(`Task not found: ${taskId}`);
        }

        // Check if task has unresolved dependencies
        if (task.dependsOn.length > 0) {
            const depStatuses = await this.getDependencyStatuses(task.dependsOn as string[]);
            const allCompleted = depStatuses.every((s) => s === 'completed');
            if (!allCompleted) {
                return {
                    taskId,
                    agent: task.assignedAgent ?? 'unassigned',
                    score: 0,
                    reason: 'Blocked — waiting on dependencies',
                };
            }
        }

        // If already assigned (manual override), use that agent
        if (task.assignedAgent !== null && task.assignedAgent !== '') {
            await this.assignTask(taskId, task.assignedAgent, task.projectId);
            return {
                taskId,
                agent: task.assignedAgent,
                score: 10,
                reason: 'Manual assignment (human override)',
            };
        }

        // Find best agent using speciality matrix
        const bestAgent = await this.findBestAgent(task.taskType);

        await this.assignTask(taskId, bestAgent.agent, task.projectId);

        return {
            taskId,
            agent: bestAgent.agent,
            score: bestAgent.score,
            reason: `Best match for skill "${task.taskType}" (score: ${bestAgent.score})`,
        };
    }

    /**
     * Route all pending tasks for a project in priority order.
     * Lifecycle guard is folded into the SELECT — paused/cancelled/archived
     * projects match zero rows so no dispatch happens.
     */
    async routePendingTasks(projectId: string): Promise<readonly RouteResult[]> {
        const tasks = await query<{ id: string }>(
            `SELECT id FROM tasks
             WHERE project_id = $1 AND status = 'pending'
               AND EXISTS (
                   SELECT 1 FROM projects p
                   WHERE p.id = $1 AND p.status IN ('active','awaiting-approval')
               )
             ORDER BY priority DESC`,
            [projectId]
        );

        const results: RouteResult[] = [];
        for (const task of tasks.rows) {
            const result = await this.routeTask(task.id);
            results.push(result);
        }

        return results;
    }

    /**
     * Manually assign a task to a specific agent (human override).
     */
    async manualAssign(taskId: string, agent: string): Promise<RouteResult> {
        const task = await getOne<{ project_id: string }>(
            'SELECT project_id FROM tasks WHERE id = $1',
            [taskId]
        );

        if (task === null) {
            throw new Error(`Task not found: ${taskId}`);
        }

        await this.assignTask(taskId, agent, task.project_id);

        return {
            taskId,
            agent,
            score: 10,
            reason: 'Manual assignment by human',
        };
    }

    // ── Private ──────────────────────────────────────

    private async findBestAgent(taskType: string): Promise<{ agent: string; score: number }> {
        // When a registry is present, filter by availability before selecting
        if (this.agentRegistry !== null) {
            return this.findBestAvailableAgent(taskType);
        }

        // No registry — use getBestAgent directly (legacy path, preserves existing behaviour)
        const best = await this.matrix.getBestAgent(taskType);
        if (best !== null) {
            return { agent: best.agent, score: best.score };
        }

        // Fallback: assign to forge (the generalist engineer)
        return { agent: 'forge', score: 5 };
    }

    /**
     * When a registry is configured, pick the highest-scoring agent that is
     * currently available. Falls back to the global best if all are busy.
     */
    private async findBestAvailableAgent(taskType: string): Promise<{ agent: string; score: number }> {
        const availableNames = this.getAvailableAgentNames();
        const topAgents = await this.matrix.getTopAgents(taskType, 10);

        // Prefer available agents
        const availableCandidates = availableNames !== null
            ? topAgents.filter((a) => availableNames.has(a.agent))
            : topAgents;

        if (availableCandidates.length > 0) {
            return { agent: availableCandidates[0].agent, score: availableCandidates[0].score };
        }

        // All scored agents are busy — fall back to the overall best (no availability filter)
        if (topAgents.length > 0) {
            return { agent: topAgents[0].agent, score: topAgents[0].score };
        }

        // Final fallback: assign to forge (the generalist engineer)
        return { agent: 'forge', score: 5 };
    }

    /**
     * Returns a Set of available agent names from the registry, or null if
     * no registry is configured (availability check is skipped).
     */
    private getAvailableAgentNames(): Set<string> | null {
        if (this.agentRegistry === null) {
            return null;
        }

        const available = this.agentRegistry.getAvailableAgents();
        return new Set(available.map((a) => a.name));
    }

    private async assignTask(taskId: string, agent: string, projectId: string): Promise<void> {
        // Atomic claim — only assign if the task is still pending. Guards against
        // double-dispatch when sweep + task.completed handler race on the same task.
        const claimed = await query<{ id: string }>(
            `UPDATE tasks SET assigned_agent = $1, status = 'assigned', started_at = NOW()
             WHERE id = $2 AND status = 'pending'
             RETURNING id`,
            [agent, taskId]
        );

        if (claimed.rows.length === 0) {
            // Task was already claimed by a concurrent dispatch — skip the publish
            // so we don't fire a duplicate task.assigned event.
            return;
        }

        await this.eventBus.publish('task.assigned', {
            projectId,
            taskId,
            agent,
            data: { assignedAgent: agent },
        });
    }

    private async getDependencyStatuses(depIds: readonly string[]): Promise<readonly string[]> {
        if (depIds.length === 0) {
            return [];
        }

        const placeholders = depIds.map((_, i) => `$${i + 1}`).join(',');
        const result = await query<{ status: string }>(
            `SELECT status FROM tasks WHERE id IN (${placeholders})`,
            [...depIds]
        );

        return result.rows.map((r) => r.status);
    }
}
