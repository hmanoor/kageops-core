/**
 * P1-10 — Bundle registry.
 *
 * Thin in-memory index over the loader result. Boot-time discovery
 * lives in `loadBundles()`; this class wraps the result with lookups
 * by name and by kind so consumers (Forge dispatch in P1-11, Scout
 * matching in P1-12) don't need to know about the loader internals.
 *
 * Intentionally non-reactive: bundles do not change at runtime in
 * this iteration. To reload, replace the registry instance.
 */

import type { BundleKind, BundleLoadResult, LoadedBundle } from './types';

export class BundleRegistry {
    private readonly byKey: ReadonlyMap<string, LoadedBundle>;
    private readonly byKind: ReadonlyMap<BundleKind, readonly LoadedBundle[]>;

    constructor(loadResult: BundleLoadResult) {
        const byKey = new Map<string, LoadedBundle>();
        const byKind = new Map<BundleKind, LoadedBundle[]>();
        for (const bundle of loadResult.bundles) {
            const key = registryKey(bundle.manifest.kind, bundle.manifest.name);
            // Last-write-wins on collision; loader already logs duplicates
            // through its surrounding context, so just keep it simple here.
            byKey.set(key, bundle);
            const list = byKind.get(bundle.manifest.kind) ?? [];
            list.push(bundle);
            byKind.set(bundle.manifest.kind, list);
        }
        this.byKey = byKey;
        this.byKind = byKind;
    }

    /** Total number of successfully loaded bundles. */
    size(): number {
        return this.byKey.size;
    }

    /** All loaded bundles, in load order. */
    all(): readonly LoadedBundle[] {
        return Array.from(this.byKey.values());
    }

    /** Bundles of one kind, in load order. */
    ofKind(kind: BundleKind): readonly LoadedBundle[] {
        return this.byKind.get(kind) ?? [];
    }

    /** Single bundle by (kind, name) or undefined. */
    get(kind: BundleKind, name: string): LoadedBundle | undefined {
        return this.byKey.get(registryKey(kind, name));
    }

    /** True if a bundle with this (kind, name) exists. */
    has(kind: BundleKind, name: string): boolean {
        return this.byKey.has(registryKey(kind, name));
    }
}

function registryKey(kind: BundleKind, name: string): string {
    return `${kind}::${name}`;
}
