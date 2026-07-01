/**
 * Shipped-feature task filter (BPF-30) — the planner-noise root fix.
 *
 * Across the ClubHubOSS dogfood the decomposer kept emitting development tasks
 * that RE-IMPLEMENT features the nextjs-saas scaffold already ships fully wired
 * — "Add Stripe webhook handler", "Create checkout API", "Integrate Clerk",
 * "Define database client". A weak/OSS model then produced BROKEN duplicates:
 * a redundant `app/api/checkout/route.ts` importing a non-existent `getUserById`,
 * a clobbered webhook route with no valid handler, a `tests/checkout.test.ts`
 * for a non-existent project shape. Each broke `next build`/`npm test`, and the
 * build-fix loop couldn't recover. Downstream auto-fixes (BPF-27/29) only chase
 * the symptoms; this stops them at the source.
 *
 * The scaffold's versions are correct and authoritative, so a task whose intent
 * is to BUILD shipped infra is pure noise — drop it before dispatch. Matching is
 * conservative: a lower-cased substring hit of a bundle-declared phrase against
 * the task's title+description. Customisation tasks (landing copy, domain
 * tables, net-new feature pages) don't contain these phrases and are kept.
 *
 * Pure + side-effect-free so it is trivially unit-testable.
 */

import type { BundleShippedFeature } from '../bundles/types';

export interface FilterableTask {
    readonly title: string;
    readonly description: string;
}

export interface DroppedTask<T> {
    readonly task: T;
    /** The shipped-feature label whose phrase matched. */
    readonly feature: string;
    /** The specific phrase that matched. */
    readonly phrase: string;
}

export interface ShippedFeatureFilterResult<T> {
    readonly kept: readonly T[];
    readonly dropped: readonly DroppedTask<T>[];
}

/**
 * Drop tasks that re-implement a shipped feature. Conservative safety rails:
 *   - No features declared (or none match) → everything kept.
 *   - NEVER drop the entire set: if every task matched, keep them all (a fully
 *     filtered phase would build nothing — almost certainly an over-match).
 */
export function filterShippedFeatureTasks<T extends FilterableTask>(
    tasks: readonly T[],
    features: readonly BundleShippedFeature[],
): ShippedFeatureFilterResult<T> {
    if (features.length === 0 || tasks.length === 0) {
        return { kept: tasks, dropped: [] };
    }

    const kept: T[] = [];
    const dropped: DroppedTask<T>[] = [];

    for (const task of tasks) {
        const hay = `${task.title}\n${task.description}`.toLowerCase();
        let matched: { feature: string; phrase: string } | null = null;
        for (const feature of features) {
            for (const phrase of feature.phrases) {
                const needle = phrase.trim().toLowerCase();
                if (needle.length > 0 && hay.includes(needle)) {
                    matched = { feature: feature.label, phrase: needle };
                    break;
                }
            }
            if (matched !== null) break;
        }
        if (matched !== null) {
            dropped.push({ task, feature: matched.feature, phrase: matched.phrase });
        } else {
            kept.push(task);
        }
    }

    // Safety: never wipe out a whole phase. If the filter matched everything,
    // it almost certainly over-matched — keep the original set untouched.
    if (kept.length === 0 && dropped.length > 0) {
        return { kept: tasks, dropped: [] };
    }

    return { kept, dropped };
}
