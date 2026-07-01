/**
 * Route-collision auto-resolver (BPF-29) — a deterministic pre-build repair.
 *
 * Next.js forbids a plain route and an OPTIONAL catch-all of the same path
 * coexisting: `app/sign-in/page.tsx` + `app/(auth)/sign-in/[[...sign-in]]/page.tsx`
 * → "You cannot define a route with the same specificity as an optional
 * catch-all route". The nextjs-saas scaffold ships the Clerk catch-all
 * sign-in/sign-up pages; a weak/OSS model then ALSO emits a plain `sign-in`
 * page (re-implementing a feature the scaffold already provides), and
 * `next build` aborts. The OSS build-fix loop can't reliably resolve it.
 *
 * Same thesis as BPF-26/27/17: absorb the defect deterministically. The
 * optional catch-all already serves the parent path AND everything under it, so
 * the safe resolution is to delete the redundant PLAIN page and keep the
 * catch-all (which, for the scaffold, is the wired Clerk `<SignIn/>`/`<SignUp/>`).
 *
 * Conservative: only the exact plain-vs-optional-catch-all collision is
 * resolved; the existing route-collision-check still surfaces other dup shapes.
 * Pure detection + fs-injected removal. Never throws.
 */

import * as path from 'path';

const PAGE_FILE = /(?:^|\/)(?:page|index)\.(?:tsx|ts|jsx|js|mjs)$/;
const OPTIONAL_CATCHALL = /^\[\[\.\.\..+\]\]$/; // [[...slug]]
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);

interface PageRoute {
    /** Repo-relative, posix-normalized page file path. */
    readonly file: string;
    /** URL path this page resolves to / the catch-all covers (e.g. `/sign-in`). */
    readonly route: string;
    readonly isOptionalCatchAll: boolean;
}

function toPosix(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Map a page file to its route. A plain page resolves to its dir path; an
 * optional-catch-all page `…/x/[[...slug]]/page.tsx` COVERS the parent path
 * `…/x` (that's exactly what collides with a plain `…/x` page in Next.js).
 * Route-group `(group)` segments don't affect the URL. Returns null if not an
 * App Router page.
 */
export function pageRouteInfo(filePath: string): Omit<PageRoute, 'file'> | null {
    const posix = toPosix(filePath);
    if (!PAGE_FILE.test(posix)) return null;

    let rest: string;
    if (posix.startsWith('src/app/')) rest = posix.slice('src/app/'.length);
    else if (posix.startsWith('app/')) rest = posix.slice('app/'.length);
    else return null;

    const lastSlash = rest.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : rest.slice(0, lastSlash);
    const segments = dir
        .split('/')
        .filter((seg) => seg.length > 0 && !(seg.startsWith('(') && seg.endsWith(')')));

    const last = segments[segments.length - 1] ?? '';
    const isOptionalCatchAll = OPTIONAL_CATCHALL.test(last);
    // An optional catch-all also serves its PARENT path → drop that segment.
    const routeSegments = isOptionalCatchAll ? segments.slice(0, -1) : segments;
    return { route: '/' + routeSegments.join('/'), isOptionalCatchAll };
}

export interface RouteCollisionResolution {
    /** The route path where a plain page collided with an optional catch-all. */
    readonly route: string;
    /** The redundant plain page file that was removed. */
    readonly removedFile: string;
    /** The catch-all page that was kept (authoritative). */
    readonly keptFile: string;
}

/** Find plain-vs-optional-catch-all collisions in a page-file list (pure). */
export function findCatchAllCollisions(filePaths: readonly string[]): readonly RouteCollisionResolution[] {
    const pages: PageRoute[] = [];
    for (const f of filePaths) {
        const info = pageRouteInfo(f);
        if (info !== null) pages.push({ file: toPosix(f), ...info });
    }

    const catchAllByRoute = new Map<string, string>(); // route → catch-all file
    const plainByRoute = new Map<string, string[]>();   // route → plain files
    for (const p of pages) {
        if (p.isOptionalCatchAll) {
            if (!catchAllByRoute.has(p.route)) catchAllByRoute.set(p.route, p.file);
        } else {
            const list = plainByRoute.get(p.route) ?? [];
            list.push(p.file);
            plainByRoute.set(p.route, list);
        }
    }

    const out: RouteCollisionResolution[] = [];
    for (const [route, keptFile] of catchAllByRoute) {
        for (const removedFile of (plainByRoute.get(route) ?? []).sort()) {
            out.push({ route, removedFile, keptFile });
        }
    }
    return out.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Walk a repo, find plain-vs-optional-catch-all collisions, delete the redundant
 * plain page(s), and report what was resolved. Never throws.
 */
export function autofixRepoRouteCollisions(
    repoPath: string,
    fsImpl: typeof import('fs'),
): { readonly resolved: readonly RouteCollisionResolution[] } {
    let entries: string[];
    try {
        entries = (fsImpl.readdirSync(repoPath, { recursive: true }) as unknown[])
            .map((e) => String(e).split(path.sep).join('/'))
            .filter((e) => !e.split('/').some((seg) => SKIP_DIRS.has(seg)));
    } catch {
        return { resolved: [] };
    }

    const collisions = findCatchAllCollisions(entries);
    const resolved: RouteCollisionResolution[] = [];
    for (const c of collisions) {
        try {
            fsImpl.rmSync(path.join(repoPath, c.removedFile));
            resolved.push(c);
        } catch {
            // couldn't remove — leave it; the gate's build step still blocks.
        }
    }
    return { resolved };
}
