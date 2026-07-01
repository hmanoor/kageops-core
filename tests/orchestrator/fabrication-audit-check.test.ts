/**
 * Fabrication audit (PR-5) — placeholder/fabricated values must not ship.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectFabrication,
    scanRepoForFabrication,
    formatFabricationWarning,
} from '../../src/orchestrator/fabrication-audit-check';

describe('detectFabrication()', () => {
    it('flags lorem ipsum', () => {
        const v = detectFabrication('<p>Lorem ipsum dolor sit amet</p>', 'app/page.tsx');
        expect(v.map((x) => x.check)).toContain('lorem-ipsum');
    });

    it('flags placeholder emails', () => {
        const v = detectFabrication('Contact us at hello@example.com', 'app/page.tsx');
        expect(v.map((x) => x.check)).toContain('placeholder-contact');
    });

    it('flags placeholder phone numbers', () => {
        expect(detectFabrication('Call 555-555-5555', 'a.html').map((x) => x.check)).toContain('placeholder-contact');
        expect(detectFabrication('Call 123-456-7890', 'a.html').map((x) => x.check)).toContain('placeholder-contact');
    });

    it('flags placeholder addresses', () => {
        const v = detectFabrication('123 Main Street, Anytown', 'a.html');
        expect(v.map((x) => x.check)).toContain('placeholder-contact');
    });

    it('flags unfilled placeholders', () => {
        expect(detectFabrication('[TODO: confirm pricing]', 'a.html').map((x) => x.check)).toContain('unfilled-placeholder');
        expect(detectFabrication('YOUR_COMPANY_HERE', 'a.html').map((x) => x.check)).toContain('unfilled-placeholder');
        expect(detectFabrication('color: TODO_FROM_BRIEF;', 'a.html').map((x) => x.check)).toContain('unfilled-placeholder');
    });

    it('flags unreplaced template variables', () => {
        const v = detectFabrication('<title>{{title}}</title>', 'app/layout.tsx');
        expect(v.map((x) => x.check)).toContain('unreplaced-template');
    });

    it('passes clean real content', () => {
        const v = detectFabrication(
            `export default function Page() { return <h1>Acme Memberships</h1>; }`,
            'app/page.tsx',
        );
        expect(v).toEqual([]);
    });
});

describe('scanRepoForFabrication()', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-fab-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('flags a rendered file but ignores docs/env/tests (where placeholders are legitimate)', () => {
        fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), '<p>Lorem ipsum dolor</p>');
        // These legitimately contain placeholders and must NOT be flagged:
        fs.writeFileSync(path.join(dir, 'SETUP.md'), 'Set EMAIL to your@email.com and run lorem ipsum demo');
        fs.writeFileSync(path.join(dir, '.env.example'), 'CONTACT_EMAIL=email@example.com');
        fs.writeFileSync(path.join(dir, 'app', 'page.test.tsx'), 'expect("lorem ipsum")');

        const v = scanRepoForFabrication(dir, fs);
        expect(v).toHaveLength(1);
        expect(v[0].file).toBe('app/page.tsx');
        expect(v[0].check).toBe('lorem-ipsum');
    });

    it('returns [] for a clean repo', () => {
        fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default () => <h1>Real Co</h1>;');
        expect(scanRepoForFabrication(dir, fs)).toEqual([]);
    });
});

describe('formatFabricationWarning()', () => {
    it('returns null for no violations', () => {
        expect(formatFabricationWarning([])).toBeNull();
    });
    it('lists file + snippet', () => {
        const w = formatFabricationWarning([
            { check: 'lorem-ipsum', file: 'app/page.tsx', snippet: 'Lorem ipsum', message: 'x' },
        ]);
        expect(w).toContain('app/page.tsx');
        expect(w).toContain('lorem-ipsum');
    });
});

describe('the shipped nextjs-saas scaffold passes the fabrication audit', () => {
    const scaffold = path.resolve(__dirname, '..', '..', 'bundles', 'stacks', 'nextjs-saas', 'scaffold');

    it('ships NO real fabrication — only the by-design {{template}} vars the copier substitutes', () => {
        const v = scanRepoForFabrication(scaffold, fs);
        // The raw scaffold legitimately holds `{{title}}`/`{{description}}` which
        // copyBundleScaffold substitutes on copy. Any OTHER fabrication kind would
        // be a real defect.
        const nonTemplate = v.filter((x) => x.check !== 'unreplaced-template');
        expect(nonTemplate, JSON.stringify(nonTemplate)).toEqual([]);
        for (const x of v) expect(x.snippet).toMatch(/\{\{\s*(?:title|description)\s*\}\}/);
    });

    it('is fully clean once the template vars are substituted (the generated-app condition)', () => {
        // Mirror copyBundleScaffold's substitution on the rendered files, then
        // assert a generated app trips nothing.
        const sub = (s: string): string =>
            s.replace(/\{\{\s*title\s*\}\}/gi, 'Acme Club').replace(/\{\{\s*description\s*\}\}/gi, 'A members club');
        for (const rel of ['app/layout.tsx', 'app/page.tsx']) {
            const content = sub(fs.readFileSync(path.join(scaffold, rel), 'utf-8'));
            expect(detectFabrication(content, rel), rel).toEqual([]);
        }
    });
});
