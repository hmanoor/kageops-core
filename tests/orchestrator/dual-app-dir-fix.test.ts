/**
 * BPF-34 — dual App Router directory resolver.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveDualAppDir } from '../../src/orchestrator/dual-app-dir-fix';

describe('resolveDualAppDir', () => {
    let repo: string;
    beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bpf34-')); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    const w = (rel: string, body: string): void => {
        const full = path.join(repo, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf-8');
    };
    const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf-8');
    const exists = (rel: string): boolean => fs.existsSync(path.join(repo, rel));

    it('the ClubHubOSS6 case: src/app/page.tsx (real) overwrites the stock app/page.tsx; src/app removed', () => {
        w('app/page.tsx', 'export default () => <main>Initialize project scaffold</main>;');
        w('app/layout.tsx', 'export default ({children}) => <html><body>{children}</body></html>;'); // scaffold layout MUST survive
        w('src/app/page.tsx', 'export default () => <section id="hero">real</section>;');

        const res = resolveDualAppDir(repo, fs);

        expect(res.merged).toBe(true);
        expect(res.movedFiles).toContain('app/page.tsx');
        // active app/page.tsx is now the real landing page
        expect(read('app/page.tsx')).toContain('id="hero"');
        // scaffold layout untouched, shadow dir gone
        expect(read('app/layout.tsx')).toContain('html');
        expect(exists('src/app')).toBe(false);
    });

    it('merges nested files into the matching app/ path', () => {
        w('app/page.tsx', 'stock');
        w('src/app/dashboard/page.tsx', 'export default () => <div id="dash"/>;');
        const res = resolveDualAppDir(repo, fs);
        expect(res.merged).toBe(true);
        expect(read('app/dashboard/page.tsx')).toContain('id="dash"');
        expect(exists('src/app')).toBe(false);
    });

    it('is a no-op when only root app/ exists (the healthy layout)', () => {
        w('app/page.tsx', 'export default () => <section id="hero"/>;');
        const res = resolveDualAppDir(repo, fs);
        expect(res.merged).toBe(false);
        expect(res.movedFiles).toEqual([]);
        expect(read('app/page.tsx')).toContain('id="hero"');
    });

    it('is a no-op when only src/app exists (legitimate src layout — leave it as the active dir)', () => {
        w('src/app/page.tsx', 'export default () => <section id="hero"/>;');
        const res = resolveDualAppDir(repo, fs);
        expect(res.merged).toBe(false);
        expect(exists('src/app/page.tsx')).toBe(true);
    });
});
