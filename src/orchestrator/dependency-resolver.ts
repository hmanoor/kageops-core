/**
 * KageOps Dependency Resolver
 *
 * Topological sort scheduler for task dependency graphs.
 * Returns execution "waves" — sets of tasks that can run in parallel.
 * Detects cycles and reports clear error paths.
 */

import { getMany } from '../db/client';

// ── Types ────────────────────────────────────────────

export interface TaskNode {
    readonly id: string;
    readonly dependsOn: readonly string[];
    readonly status: string;
}

/**
 * A wave is a set of task IDs that can execute in parallel.
 * Wave 0 has no dependencies, wave 1 depends only on wave 0, etc.
 */
export interface TaskWave {
    readonly waveIndex: number;
    readonly taskIds: readonly string[];
}

export interface ReadyTasksResult {
    readonly readyIds: readonly string[];
    readonly blockedIds: readonly string[];
}

// ── Errors ───────────────────────────────────────────

export class CyclicDependencyError extends Error {
    readonly cyclePath: readonly string[];

    constructor(cyclePath: readonly string[]) {
        const pathStr = cyclePath.join(' → ');
        super(`Cyclic dependency detected: ${pathStr}`);
        this.name = 'CyclicDependencyError';
        this.cyclePath = cyclePath;
    }
}

// ── Dependency Resolver ──────────────────────────────

export class DependencyResolver {

    /**
     * Topological sort of tasks into execution waves.
     *
     * Wave 0 = tasks with no dependencies
     * Wave 1 = tasks whose deps are all in wave 0
     * ...etc.
     *
     * Throws CyclicDependencyError if a cycle is detected.
     * Tasks referencing deps not in the input set are treated as having
     * no dependency on those (external deps are assumed satisfied).
     */
    resolve(tasks: readonly TaskNode[]): readonly TaskWave[] {
        if (tasks.length === 0) {
            return [];
        }

        // Build adjacency data — only track deps that exist in the task set
        const taskSet = new Set(tasks.map((t) => t.id));
        const inDegree = new Map<string, number>();
        const dependents = new Map<string, string[]>(); // dep → tasks that depend on it
        const internalDeps = new Map<string, string[]>(); // task → its deps within set

        for (const task of tasks) {
            const localDeps = task.dependsOn.filter((d) => taskSet.has(d));
            internalDeps.set(task.id, localDeps);
            inDegree.set(task.id, localDeps.length);

            for (const dep of localDeps) {
                const existing = dependents.get(dep) ?? [];
                dependents.set(dep, [...existing, task.id]);
            }
        }

        const waves: TaskWave[] = [];
        const resolved = new Set<string>();

        // Kahn's algorithm — wave by wave
        while (resolved.size < tasks.length) {
            const waveIds: string[] = [];

            for (const task of tasks) {
                if (resolved.has(task.id)) continue;
                if ((inDegree.get(task.id) ?? 0) === 0) {
                    waveIds.push(task.id);
                }
            }

            if (waveIds.length === 0) {
                // Remaining tasks form a cycle — find it
                const cyclePath = this.findCycle(tasks, resolved, internalDeps);
                throw new CyclicDependencyError(cyclePath);
            }

            waves.push({
                waveIndex: waves.length,
                taskIds: waveIds,
            });

            // Mark wave as resolved and decrement in-degrees
            for (const id of waveIds) {
                resolved.add(id);
                const deps = dependents.get(id) ?? [];
                for (const dependent of deps) {
                    const current = inDegree.get(dependent) ?? 0;
                    inDegree.set(dependent, current - 1);
                }
            }
        }

        return waves;
    }

    /**
     * Query the database for tasks that are ready to execute:
     * status = 'pending' and all dependsOn tasks are 'completed'.
     */
    async getReadyTasks(projectId: string, phase?: string): Promise<ReadyTasksResult> {
        const phaseFilter = phase !== undefined ? ' AND phase = $2' : '';
        const params = phase !== undefined ? [projectId, phase] : [projectId];

        const pending = await getMany<{
            id: string;
            depends_on: readonly string[] | null;
        }>(
            `SELECT id, depends_on FROM tasks
             WHERE project_id = $1 AND status = 'pending'${phaseFilter}
             ORDER BY priority DESC`,
            params
        );

        if (pending.length === 0) {
            return { readyIds: [], blockedIds: [] };
        }

        // Collect all dependency IDs we need to check
        const allDepIds = new Set<string>();
        for (const task of pending) {
            const deps = task.depends_on ?? [];
            for (const dep of deps) {
                allDepIds.add(dep);
            }
        }

        // Batch-fetch dependency statuses
        const depStatuses = new Map<string, string>();
        if (allDepIds.size > 0) {
            const depArray = [...allDepIds];
            const placeholders = depArray.map((_, i) => `$${i + 1}`).join(',');
            const statusRows = await getMany<{ id: string; status: string }>(
                `SELECT id, status FROM tasks WHERE id IN (${placeholders})`,
                depArray
            );
            for (const row of statusRows) {
                depStatuses.set(row.id, row.status);
            }
        }

        const readyIds: string[] = [];
        const blockedIds: string[] = [];

        for (const task of pending) {
            const deps = task.depends_on ?? [];
            const allCompleted = deps.every((depId) => {
                const status = depStatuses.get(depId);
                // Treat completed, failed, or missing deps as satisfied.
                // Failed tasks shouldn't permanently block the pipeline —
                // dependents should still run (with degraded context).
                return status === undefined || status === 'completed' || status === 'failed';
            });

            if (allCompleted) {
                readyIds.push(task.id);
            } else {
                blockedIds.push(task.id);
            }
        }

        return { readyIds, blockedIds };
    }

    // ── Private ──────────────────────────────────────

    /**
     * Find a cycle in the remaining unresolved tasks using DFS.
     */
    private findCycle(
        tasks: readonly TaskNode[],
        resolved: ReadonlySet<string>,
        internalDeps: ReadonlyMap<string, readonly string[]>
    ): readonly string[] {
        const unresolved = tasks.filter((t) => !resolved.has(t.id));
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const path: string[] = [];

        const dfs = (id: string): readonly string[] | null => {
            if (visiting.has(id)) {
                // Found cycle — extract it from path
                const cycleStart = path.indexOf(id);
                return [...path.slice(cycleStart), id];
            }
            if (visited.has(id)) return null;

            visiting.add(id);
            path.push(id);

            const deps = internalDeps.get(id) ?? [];
            for (const dep of deps) {
                if (resolved.has(dep)) continue;
                const cycle = dfs(dep);
                if (cycle !== null) return cycle;
            }

            visiting.delete(id);
            path.pop();
            visited.add(id);
            return null;
        };

        for (const task of unresolved) {
            const cycle = dfs(task.id);
            if (cycle !== null) return cycle;
        }

        // Should never reach here if called correctly
        return unresolved.map((t) => t.id);
    }
}
