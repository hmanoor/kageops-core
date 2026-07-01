/**
 * KageOps Route Collision Check
 *
 * Detects two structural defects that broke a live Next.js 14 project
 * (2026-06): an agent created BOTH a root `app/` directory AND a
 * `src/app/` directory (Next.js App Router resolves only one — the
 * stray one shadows the real tree), and two page files that resolve to
 * the SAME route (Next.js forbids parallel pages on one path).
 *
 * Pure, filesystem-free: callers pass the list of workspace-relative
 * file paths (any separator). The build gate / a post-write check feeds
 * it the produced file set and surfaces a blocking warning on collision.
 *
 * All comparisons are done on `path.posix`-normalized separators so
 * `app\login` and `app/login` are recognised as the same route.
 */

import * as path from 'path';

// ── Types ────────────────────────────────────────────

export interface RouteCollision {
    /** The normalized route path two+ pages resolve to (e.g. `/login`). */
    readonly route: string;
    /** The colliding page file paths (posix-normalized). */
    readonly pages: readonly string[];
}

export interface CollisionReport {
    /** True when BOTH a root `app/` and a `src/app/` App Router dir exist. */
    readonly dualAppDir: boolean;
    /** The two App Router roots found, when `dualAppDir` is true. */
    readonly appDirRoots: readonly string[];
    /** Routes with two or more pages resolving to them. */
    readonly routeCollisions: readonly RouteCollision[];
    /** Convenience: any blocking collision present. */
    readonly hasCollision: boolean;
}

// ── Helpers ──────────────────────────────────────────

/** Normalize any-OS separators to posix and strip a leading `./`. */
function toPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

const PAGE_FILE = /(?:^|\/)(page|index)\.(?:tsx|ts|jsx|js|mjs)$/;

/**
 * Map an App Router page file to its route. Strips the leading App
 * Router root (`app/` or `src/app/`), drops the trailing `page.*` /
 * `index.*` file, and removes route-group segments `(group)` which do
 * NOT contribute to the URL. `app/(auth)/login/page.tsx` ⇒ `/login`,
 * `src/app/login/page.tsx` ⇒ `/login` — so the two collide.
 */
export function pageFileToRoute(filePath: string): string | null {
    const posix = toPosix(filePath);
    if (!PAGE_FILE.test(posix)) return null;

    let rest: string;
    if (posix.startsWith('src/app/')) rest = posix.slice('src/app/'.length);
    else if (posix.startsWith('app/')) rest = posix.slice('app/'.length);
    else return null; // not an App Router page

    // Drop the file segment.
    const lastSlash = rest.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : rest.slice(0, lastSlash);

    // Drop route-group segments `(group)` — they don't affect the URL.
    const segments = dir
        .split('/')
        .filter((seg) => seg.length > 0 && !(seg.startsWith('(') && seg.endsWith(')')));

    return '/' + segments.join('/');
}

// ── Detection ────────────────────────────────────────

/**
 * Inspect a flat list of workspace-relative file paths and report
 * App Router structural collisions. Never throws.
 */
export function detectRouteCollisions(filePaths: readonly string[]): CollisionReport {
    const posixPaths = filePaths.map(toPosix);

    // 1. Dual App Router roots: any file under `app/...` AND any under `src/app/...`.
    const hasRootApp = posixPaths.some((p) => p === 'app' || p.startsWith('app/'));
    const hasSrcApp = posixPaths.some((p) => p === 'src/app' || p.startsWith('src/app/'));
    const dualAppDir = hasRootApp && hasSrcApp;
    const appDirRoots = dualAppDir ? (['app', 'src/app'] as const) : ([] as const);

    // 2. Route collisions: group page files by resolved route.
    const byRoute = new Map<string, string[]>();
    for (const p of posixPaths) {
        const route = pageFileToRoute(p);
        if (route === null) continue;
        const existing = byRoute.get(route);
        if (existing === undefined) byRoute.set(route, [p]);
        else existing.push(p);
    }

    const routeCollisions: RouteCollision[] = [];
    for (const [route, pages] of byRoute) {
        if (pages.length > 1) {
            routeCollisions.push({ route, pages: [...pages].sort() });
        }
    }
    routeCollisions.sort((a, b) => a.route.localeCompare(b.route));

    return {
        dualAppDir,
        appDirRoots: [...appDirRoots],
        routeCollisions,
        hasCollision: dualAppDir || routeCollisions.length > 0,
    };
}

/**
 * Walk a repo on disk and run {@link detectRouteCollisions} over every
 * file. Filesystem-aware wrapper for the build gate. Never throws —
 * returns an empty (no-collision) report when the walk fails.
 */
export function detectRouteCollisionsInRepo(
    repoPath: string,
    fsLike: { readonly readdirSync: (p: string, opts: { recursive: true }) => readonly unknown[] },
): CollisionReport {
    let entries: string[] = [];
    try {
        entries = (fsLike.readdirSync(repoPath, { recursive: true }) as unknown[])
            .map((e) => String(e))
            .map((e) => e.split(path.sep).join('/'));
    } catch {
        return { dualAppDir: false, appDirRoots: [], routeCollisions: [], hasCollision: false };
    }
    return detectRouteCollisions(entries);
}

/**
 * Render a human-readable, blocking-warning summary of a collision
 * report. Returns null when there's nothing to warn about.
 */
export function formatCollisionWarning(report: CollisionReport): string | null {
    if (!report.hasCollision) return null;
    const lines: string[] = [];
    if (report.dualAppDir) {
        lines.push(
            `App Router collision: BOTH a root \`app/\` and a \`src/app/\` directory exist ` +
            `(${report.appDirRoots.join(' + ')}). Next.js resolves only one — the stray tree ` +
            `shadows the real one and routes 404/500. Keep exactly one App Router root.`,
        );
    }
    for (const c of report.routeCollisions) {
        lines.push(
            `Duplicate route "${c.route}": ${c.pages.length} pages resolve to the same path ` +
            `(${c.pages.join(', ')}). Next.js forbids parallel pages on one route.`,
        );
    }
    return lines.join('\n');
}
