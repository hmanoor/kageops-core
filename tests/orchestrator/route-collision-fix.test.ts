/**
 * BPF-29 — auto-resolve plain-vs-optional-catch-all route collisions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    pageRouteInfo,
    findCatchAllCollisions,
    autofixRepoRouteCollisions,
} from '../../src/orchestrator/route-collision-fix';

describe('pageRouteInfo', () => {
    it('maps a plain page to its route', () => {
        expect(pageRouteInfo('app/sign-in/page.tsx')).toEqual({ route: '/sign-in', isOptionalCatchAll: false });
    });
    it('maps an optional catch-all to the PARENT path it also serves', () => {
        expect(pageRouteInfo('app/(auth)/sign-in/[[...sign-in]]/page.tsx'))
            .toEqual({ route: '/sign-in', isOptionalCatchAll: true });
    });
    it('drops route groups from the URL', () => {
        expect(pageRouteInfo('app/(marketing)/about/page.tsx')).toEqual({ route: '/about', isOptionalCatchAll: false });
    });
    it('returns null for non-page files', () => {
        expect(pageRouteInfo('app/sign-in/route.ts')).toBeNull();
        expect(pageRouteInfo('lib/db/schema.ts')).toBeNull();
    });
});

describe('findCatchAllCollisions', () => {
    it('flags the plain page colliding with an optional catch-all (the ClubHubOSS case)', () => {
        const collisions = findCatchAllCollisions([
            'app/(auth)/sign-in/[[...sign-in]]/page.tsx',
            'app/sign-in/page.tsx',
            'app/(auth)/sign-up/[[...sign-up]]/page.tsx', // no plain dup → no collision
        ]);
        expect(collisions).toEqual([
            {
                route: '/sign-in',
                removedFile: 'app/sign-in/page.tsx',
                keptFile: 'app/(auth)/sign-in/[[...sign-in]]/page.tsx',
            },
        ]);
    });

    it('does not flag a plain route with no catch-all counterpart', () => {
        expect(findCatchAllCollisions(['app/dashboard/page.tsx', 'app/members/page.tsx'])).toEqual([]);
    });

    it('does not flag a catch-all with no plain counterpart', () => {
        expect(findCatchAllCollisions(['app/(auth)/sign-in/[[...sign-in]]/page.tsx'])).toEqual([]);
    });
});

describe('autofixRepoRouteCollisions', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bpf29-'));
    });
    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    function write(rel: string, body = 'export default function P() { return null; }\n'): void {
        const full = path.join(repo, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf-8');
    }

    it('removes the redundant plain page and keeps the catch-all', () => {
        write('app/(auth)/sign-in/[[...sign-in]]/page.tsx');
        write('app/sign-in/page.tsx');
        write('app/dashboard/page.tsx'); // unrelated, must survive

        const result = autofixRepoRouteCollisions(repo, fs);

        expect(result.resolved).toHaveLength(1);
        expect(result.resolved[0].route).toBe('/sign-in');
        // plain page deleted, catch-all + unrelated kept
        expect(fs.existsSync(path.join(repo, 'app/sign-in/page.tsx'))).toBe(false);
        expect(fs.existsSync(path.join(repo, 'app/(auth)/sign-in/[[...sign-in]]/page.tsx'))).toBe(true);
        expect(fs.existsSync(path.join(repo, 'app/dashboard/page.tsx'))).toBe(true);
    });

    it('is a no-op on a clean repo (no collisions)', () => {
        write('app/(auth)/sign-in/[[...sign-in]]/page.tsx');
        write('app/page.tsx');
        const result = autofixRepoRouteCollisions(repo, fs);
        expect(result.resolved).toEqual([]);
        expect(fs.existsSync(path.join(repo, 'app/(auth)/sign-in/[[...sign-in]]/page.tsx'))).toBe(true);
    });
});
