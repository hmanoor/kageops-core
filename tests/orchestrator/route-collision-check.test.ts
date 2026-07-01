/**
 * Route Collision Check tests
 *
 * Driven by the 2026-06 Next.js 14 boot failure: an agent created BOTH a
 * root `app/` and a `src/app/` tree (the stray root shadowed the real
 * one) AND a duplicate `/login` route (`src/app/login/page.tsx` +
 * `app/(auth)/login/page.tsx`). Every route 500'd.
 */

import { describe, it, expect } from 'vitest';
import {
    detectRouteCollisions,
    detectRouteCollisionsInRepo,
    pageFileToRoute,
    formatCollisionWarning,
} from '../../src/orchestrator/route-collision-check';

describe('pageFileToRoute()', () => {
    it('maps a src/app page to its route', () => {
        expect(pageFileToRoute('src/app/login/page.tsx')).toBe('/login');
    });

    it('maps a root app page to its route', () => {
        expect(pageFileToRoute('app/login/page.tsx')).toBe('/login');
    });

    it('strips route-group segments so (auth)/login === /login', () => {
        expect(pageFileToRoute('app/(auth)/login/page.tsx')).toBe('/login');
        expect(pageFileToRoute('src/app/(marketing)/about/page.tsx')).toBe('/about');
    });

    it('maps the app root index to "/"', () => {
        expect(pageFileToRoute('app/page.tsx')).toBe('/');
        expect(pageFileToRoute('src/app/page.tsx')).toBe('/');
    });

    it('treats Windows separators the same as posix', () => {
        expect(pageFileToRoute('src\\app\\login\\page.tsx')).toBe('/login');
        expect(pageFileToRoute('app\\(auth)\\login\\page.tsx')).toBe('/login');
    });

    it('returns null for non-page files and non-App-Router files', () => {
        expect(pageFileToRoute('src/app/login/layout.tsx')).toBeNull();
        expect(pageFileToRoute('src/components/Button.tsx')).toBeNull();
        expect(pageFileToRoute('pages/login.tsx')).toBeNull();
    });
});

describe('detectRouteCollisions() — dual App Router dirs', () => {
    it('flags a project with BOTH a root app/ and a src/app/ tree', () => {
        const report = detectRouteCollisions([
            'app/(auth)/login/page.tsx',
            'src/app/layout.tsx',
            'src/app/page.tsx',
        ]);
        expect(report.dualAppDir).toBe(true);
        expect(report.appDirRoots).toEqual(['app', 'src/app']);
        expect(report.hasCollision).toBe(true);
    });

    it('does NOT flag a project with only src/app/', () => {
        const report = detectRouteCollisions([
            'src/app/layout.tsx',
            'src/app/login/page.tsx',
        ]);
        expect(report.dualAppDir).toBe(false);
        expect(report.hasCollision).toBe(false);
    });

    it('does NOT flag a project with only root app/', () => {
        const report = detectRouteCollisions([
            'app/layout.tsx',
            'app/login/page.tsx',
        ]);
        expect(report.dualAppDir).toBe(false);
    });

    it('treats Windows separators consistently for dual-dir detection', () => {
        const report = detectRouteCollisions([
            'app\\login\\page.tsx',
            'src\\app\\page.tsx',
        ]);
        expect(report.dualAppDir).toBe(true);
    });
});

describe('detectRouteCollisions() — duplicate routes', () => {
    it('flags two pages resolving to the same /login route (the 2026-06 bug)', () => {
        const report = detectRouteCollisions([
            'src/app/login/page.tsx',
            'app/(auth)/login/page.tsx',
        ]);
        expect(report.routeCollisions).toHaveLength(1);
        expect(report.routeCollisions[0].route).toBe('/login');
        expect(report.routeCollisions[0].pages).toEqual([
            'app/(auth)/login/page.tsx',
            'src/app/login/page.tsx',
        ]);
        expect(report.hasCollision).toBe(true);
    });

    it('flags two pages on the same route even with mixed separators', () => {
        const report = detectRouteCollisions([
            'src/app/login/page.tsx',
            'app\\(auth)\\login\\page.tsx',
        ]);
        expect(report.routeCollisions).toHaveLength(1);
        expect(report.routeCollisions[0].route).toBe('/login');
    });

    it('does NOT flag distinct routes', () => {
        const report = detectRouteCollisions([
            'app/login/page.tsx',
            'app/signup/page.tsx',
            'app/dashboard/page.tsx',
        ]);
        expect(report.routeCollisions).toHaveLength(0);
        expect(report.hasCollision).toBe(false);
    });
});

describe('formatCollisionWarning()', () => {
    it('returns null when there is no collision', () => {
        const report = detectRouteCollisions(['src/app/page.tsx']);
        expect(formatCollisionWarning(report)).toBeNull();
    });

    it('describes both the dual-dir and the duplicate route', () => {
        const report = detectRouteCollisions([
            'src/app/login/page.tsx',
            'app/(auth)/login/page.tsx',
        ]);
        const warning = formatCollisionWarning(report);
        expect(warning).not.toBeNull();
        expect(warning).toContain('App Router collision');
        expect(warning).toContain('Duplicate route "/login"');
    });
});

describe('detectRouteCollisionsInRepo()', () => {
    it('walks the repo via the provided fs and detects the collision', () => {
        const fakeFs = {
            readdirSync: () => [
                'src/app/login/page.tsx',
                'app/(auth)/login/page.tsx',
                'package.json',
            ],
        };
        const report = detectRouteCollisionsInRepo('/tmp/repo', fakeFs);
        expect(report.dualAppDir).toBe(true);
        expect(report.routeCollisions).toHaveLength(1);
    });

    it('returns a clean report when the fs walk throws', () => {
        const throwingFs = {
            readdirSync: () => {
                throw new Error('boom');
            },
        };
        const report = detectRouteCollisionsInRepo('/tmp/repo', throwingFs);
        expect(report.hasCollision).toBe(false);
    });
});
