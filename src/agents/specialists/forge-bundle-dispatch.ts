/**
 * P1-11 — Bundle-aware Forge dispatch.
 *
 * Thin shim that decides whether a given Forge task should be served
 * from a bundle (data-driven) or from the inline `setupStaticHtmlProject`
 * path in forge.ts (the legacy default).
 *
 * Gating:
 *   1. `KAGEOPS_FEATURE_BUNDLES !== 'false'` (env flag, ON by default
 *      since Pillar 2.2 PR-E ships 2026-05-30; was opt-in before).
 *   2. The task's project has `selected_bundle` set (DB column added
 *      in migration 028 — populated by Scout in P1-12).
 *   3. The bundle named in `selected_bundle` resolves in the
 *      registry (i.e. the bundle still exists on disk).
 *
 * If any of the three fails, return `null` and the caller falls back
 * to the existing inline path. This is the rollback knob the plan
 * (decision #2) committed to.
 *
 * Resolution outcome carries the LoadedBundle so the caller can call
 * `renderBundlePrompt()` against it directly — no second lookup.
 */

import { query } from '../../db/client';
import type { BundleRegistry } from '../../bundles/bundle-registry';
import type { LoadedBundle } from '../../bundles/types';

export interface BundleResolutionInput {
    readonly projectId: string;
    /** Pre-loaded registry. Caller owns the lifecycle. */
    readonly registry: BundleRegistry;
}

export interface BundleResolutionHit {
    readonly bundle: LoadedBundle;
    /** Raw `selected_bundle` column value (e.g. "stack::vanilla-html"). */
    readonly key: string;
}

export type BundleResolutionResult =
    | { readonly status: 'flag-off' }
    | { readonly status: 'no-selection' }
    | { readonly status: 'malformed-key'; readonly key: string }
    | { readonly status: 'unknown-bundle'; readonly key: string }
    | { readonly status: 'hit'; readonly hit: BundleResolutionHit };

/**
 * Decide if this project should be served from a bundle.
 *
 * Pure-ish — only reads the env flag + one DB row. Safe to call per-
 * task; the DB hit is a single indexed lookup. Caller caches the
 * BundleRegistry across tasks.
 */
export async function resolveBundleForProject(
    input: BundleResolutionInput
): Promise<BundleResolutionResult> {
    if (process.env['KAGEOPS_FEATURE_BUNDLES'] === 'false') {
        return { status: 'flag-off' };
    }

    let key: string | null = null;
    try {
        const result = await query<{ selected_bundle: string | null }>(
            'SELECT selected_bundle FROM projects WHERE id = $1',
            [input.projectId]
        );
        key = result.rows[0]?.selected_bundle ?? null;
    } catch {
        // DB hiccup → defensively fall back to the inline path so a
        // transient query failure can't break Forge for everyone.
        return { status: 'no-selection' };
    }

    if (key === null || key.length === 0) {
        return { status: 'no-selection' };
    }

    const parsed = parseBundleKey(key);
    if (parsed === null) {
        return { status: 'malformed-key', key };
    }

    const bundle = input.registry.get(parsed.kind, parsed.name);
    if (bundle === undefined) {
        return { status: 'unknown-bundle', key };
    }

    return { status: 'hit', hit: { bundle, key } };
}

/** Parse "stack::vanilla-html" → { kind: 'stack', name: 'vanilla-html' } or null. */
export function parseBundleKey(
    key: string
): { readonly kind: 'stack' | 'capability' | 'deployer'; readonly name: string } | null {
    const m = /^(stack|capability|deployer)::([a-z0-9][a-z0-9-]*)$/.exec(key);
    if (m === null) return null;
    return {
        kind: m[1] as 'stack' | 'capability' | 'deployer',
        name: m[2] as string,
    };
}
