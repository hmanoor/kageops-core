/**
 * BPF-33 — source-level required-id acceptance check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { corpusHasId, checkHtmlIdsInSource } from '../../src/orchestrator/html-id-source-check';

describe('corpusHasId', () => {
    it('matches double, single, and brace-quoted JSX id attributes', () => {
        expect(corpusHasId('<section id="hero">', 'hero')).toBe(true);
        expect(corpusHasId("<a id='signin-link'>", 'signin-link')).toBe(true);
        expect(corpusHasId('<div id={"footer"}>', 'footer')).toBe(true);
        expect(corpusHasId("<div id={'pricing'}>", 'pricing')).toBe(true);
    });
    it('does not match a different id or a substring', () => {
        expect(corpusHasId('<section id="hero-banner">', 'hero')).toBe(false);
        expect(corpusHasId('// the hero section', 'hero')).toBe(false);
    });
});

describe('checkHtmlIdsInSource', () => {
    let repo: string;
    beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bpf33-')); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    function write(rel: string, body: string): void {
        const full = path.join(repo, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf-8');
    }

    it('passes (no violations) when every required id is present in app source', () => {
        write('app/page.tsx', `
            export default function P() {
              return (<main>
                <section id="hero">h</section>
                <section id="pricing">p</section>
                <button id="join-cta">j</button>
                <a id="signin-link">s</a>
                <footer id="footer">f</footer>
              </main>);
            }`);
        const v = checkHtmlIdsInSource(repo, ['hero', 'pricing', 'join-cta', 'signin-link', 'footer'], fs);
        expect(v).toEqual([]);
    });

    it('flags the missing ids when the page is the stock scaffold (the OSS6 bug)', () => {
        write('app/page.tsx', `
            export default function HomePage() {
              return (<main><h1>Initialize project scaffold</h1></main>);
            }`);
        const v = checkHtmlIdsInSource(repo, ['hero', 'pricing', 'join-cta', 'signin-link', 'footer'], fs);
        expect(v.map((x) => x.check)).toEqual(['missing-id', 'missing-id', 'missing-id', 'missing-id', 'missing-id']);
        expect(v[0].message).toContain('id="hero"');
    });

    it('finds ids across components/, not just app/page.tsx', () => {
        write('app/page.tsx', `import {Hero} from '@/components/hero'; export default () => <Hero/>;`);
        write('components/hero.tsx', `export const Hero = () => <section id="hero">x</section>;`);
        const v = checkHtmlIdsInSource(repo, ['hero'], fs);
        expect(v).toEqual([]);
    });

    it('ignores ids that only appear in test files', () => {
        write('app/page.tsx', `export default () => <main>nothing</main>;`);
        write('tests/page.test.tsx', `it('has hero', () => { render(<div id="hero"/>); });`);
        const v = checkHtmlIdsInSource(repo, ['hero'], fs);
        expect(v).toHaveLength(1); // the test-file match must NOT satisfy it
    });

    it('returns no violations when nothing is required', () => {
        expect(checkHtmlIdsInSource(repo, [], fs)).toEqual([]);
    });

    it('BPF-33 dual-app-dir trap: ids in the DEAD src/app do NOT count when root app/ renders', () => {
        // Exactly the ClubHubOSS6 bug: Next renders root app/ (stock), src/app is shadowed.
        write('app/page.tsx', `export default () => <main><h1>Initialize project scaffold</h1></main>;`);
        write('src/app/page.tsx', `export default () => <section id="hero"><a id="footer"/></section>;`);
        const v = checkHtmlIdsInSource(repo, ['hero', 'footer'], fs);
        expect(v).toHaveLength(2); // the shadowed src/app must not satisfy the ids
    });

    it('uses src/app when there is no root app/ (legitimate src layout)', () => {
        write('src/app/page.tsx', `export default () => <section id="hero">x</section>;`);
        const v = checkHtmlIdsInSource(repo, ['hero'], fs);
        expect(v).toEqual([]);
    });
});
