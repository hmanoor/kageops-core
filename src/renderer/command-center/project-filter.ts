/**
 * Pure project search + filter logic (B-407).
 *
 * Extracted so it can be unit-tested without jsdom. The Projects panel
 * reads the raw list straight from Sensei and applies this filter on the
 * client — cheap enough since the list is bounded (typically < 100).
 */

export interface FilterableProject {
    readonly name: string;
    readonly status: string;
    readonly phase: string;
}

export interface ProjectFilterCriteria {
    readonly search?: string;
    readonly status?: string;
    readonly phase?: string;
}

export function applyProjectFilter<T extends FilterableProject>(
    projects: readonly T[],
    criteria: ProjectFilterCriteria,
): readonly T[] {
    const q = (criteria.search ?? '').trim().toLowerCase();
    const statusFilter = criteria.status ?? '';
    const phaseFilter = criteria.phase ?? '';

    if (q === '' && statusFilter === '' && phaseFilter === '') return projects;

    return projects.filter((p) => {
        if (statusFilter !== '' && p.status !== statusFilter) return false;
        if (phaseFilter !== '' && p.phase !== phaseFilter) return false;
        if (q !== '' && !p.name.toLowerCase().includes(q)) return false;
        return true;
    });
}

export function uniqueSorted<T extends FilterableProject, K extends 'status' | 'phase'>(
    projects: readonly T[],
    key: K,
): readonly string[] {
    return Array.from(new Set(projects.map((p) => p[key]))).sort();
}
