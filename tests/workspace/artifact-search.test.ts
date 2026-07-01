/**
 * artifact-search unit tests (B-429).
 *
 * Covers the pure query compiler, the line matcher, and an on-disk
 * `searchWorkspace` against a tmp fixture (excludes, binary skip, caps).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
    compileQuery,
    matchLinesInContent,
    searchWorkspace,
} from '../../src/workspace/artifact-search';

// ── compileQuery ─────────────────────────────────────

describe('compileQuery', () => {
    it('defaults to case-insensitive literal match', () => {
        const r = compileQuery('Foo');
        expect(r.flags.includes('i')).toBe(true);
        expect(r.flags.includes('g')).toBe(true);
        expect(r.test('hello FOO world')).toBe(true);
    });

    it('honors caseSensitive', () => {
        const r = compileQuery('Foo', { caseSensitive: true });
        expect(r.flags.includes('i')).toBe(false);
        expect(r.test('hello FOO world')).toBe(false);
        expect(r.test('hello Foo world')).toBe(true);
    });

    it('escapes regex metacharacters in literal mode', () => {
        const r = compileQuery('a.b');
        expect(r.test('axb')).toBe(false);
        expect(r.test('a.b')).toBe(true);
    });

    it('keeps regex metacharacters in regex mode', () => {
        const r = compileQuery('a.b', { regex: true });
        expect(r.test('axb')).toBe(true);
    });

    it('throws on empty query', () => {
        expect(() => compileQuery('')).toThrow(/empty/i);
    });

    it('throws on over-long query', () => {
        expect(() => compileQuery('a'.repeat(1001))).toThrow(/too long/i);
    });

    it('throws on invalid regex in regex mode', () => {
        expect(() => compileQuery('(unclosed', { regex: true })).toThrow(SyntaxError);
    });

    it('tighter length cap in regex mode', () => {
        expect(() => compileQuery('a'.repeat(250), { regex: true })).toThrow(/too long/i);
        // Literal mode still allows longer queries.
        expect(() => compileQuery('a'.repeat(250))).not.toThrow();
    });

    it('rejects known catastrophic-backtracking patterns in regex mode', () => {
        expect(() => compileQuery('(a+)+', { regex: true })).toThrow(/catastrophic/i);
        expect(() => compileQuery('(x*)*', { regex: true })).toThrow(/catastrophic/i);
    });
});

// ── matchLinesInContent ──────────────────────────────

describe('matchLinesInContent', () => {
    it('reports 1-based line numbers', () => {
        const out = matchLinesInContent('a\nhit\nb\nhit', /hit/g);
        expect(out.map((m) => m.line)).toEqual([2, 4]);
    });

    it('returns the first match position per line', () => {
        const out = matchLinesInContent('foo foo foo', /foo/g);
        expect(out).toHaveLength(1);
        expect(out[0]?.columnStart).toBe(0);
        expect(out[0]?.columnEnd).toBe(3);
    });

    it('returns empty on no matches', () => {
        expect(matchLinesInContent('hello', /nope/g)).toEqual([]);
    });

    it('preserves the original line content including leading whitespace', () => {
        const out = matchLinesInContent('    indented hit', /hit/g);
        expect(out[0]?.content).toBe('    indented hit');
        expect(out[0]?.columnStart).toBe(13);
    });

    it('skips lines over the 10_000 char cap', () => {
        const giant = 'hit' + 'x'.repeat(10_000);
        const out = matchLinesInContent(giant, /hit/g);
        expect(out).toEqual([]);
    });
});

// ── searchWorkspace (on-disk fixture) ────────────────

describe('searchWorkspace', () => {
    let root: string;

    async function writeFile(rel: string, content: string | Buffer): Promise<void> {
        const abs = path.join(root, rel);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        if (typeof content === 'string') {
            await fsp.writeFile(abs, content, 'utf8');
        } else {
            await fsp.writeFile(abs, content);
        }
    }

    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kageops-search-'));
    });

    afterEach(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    it('finds the query across multiple files and groups by file', async () => {
        await writeFile('a.ts', 'const x = 1;\nconst HIT = 2;\n');
        await writeFile('nested/b.ts', '// HIT comment\n');
        await writeFile('c.md', 'no match here\n');

        const res = await searchWorkspace(root, 'HIT');
        const paths = res.results.map((r) => r.relPath).sort();
        expect(paths).toEqual(['a.ts', 'nested/b.ts']);
        expect(res.totalMatches).toBe(2);
        expect(res.truncated).toBe(false);
    });

    it('skips files under EXCLUDE_DIRS', async () => {
        await writeFile('a.ts', 'HIT\n');
        await writeFile('node_modules/pkg/index.js', 'HIT\n');
        await writeFile('dist/bundle.js', 'HIT\n');
        await writeFile('.git/config', 'HIT\n');

        const res = await searchWorkspace(root, 'HIT');
        expect(res.results.map((r) => r.relPath)).toEqual(['a.ts']);
    });

    it('skips binary files', async () => {
        await writeFile('a.ts', 'HIT found\n');
        // 0x00 early in the sample marks it as binary.
        const buf = Buffer.concat([Buffer.from('HIT '), Buffer.from([0, 0, 0, 0]), Buffer.from('more')]);
        await writeFile('blob.bin', buf);

        const res = await searchWorkspace(root, 'HIT');
        expect(res.results.map((r) => r.relPath)).toEqual(['a.ts']);
        expect(res.filesSkipped).toBeGreaterThanOrEqual(1);
    });

    it('truncates when total matches exceed maxResults', async () => {
        const lines = Array.from({ length: 5 }, (_, i) => `HIT line ${i}`).join('\n');
        await writeFile('a.ts', lines);
        await writeFile('b.ts', lines);

        const res = await searchWorkspace(root, 'HIT', { maxResults: 6 });
        expect(res.totalMatches).toBe(6);
        expect(res.truncated).toBe(true);
    });

    it('skips files larger than maxFileBytes', async () => {
        const big = 'HIT line\n'.repeat(200); // ~1800 bytes
        await writeFile('big.ts', big);
        await writeFile('small.ts', 'HIT once\n');

        const res = await searchWorkspace(root, 'HIT', { maxFileBytes: 100 });
        expect(res.results.map((r) => r.relPath)).toEqual(['small.ts']);
        expect(res.filesSkipped).toBeGreaterThanOrEqual(1);
    });

    it('returns empty result for a query that matches nothing', async () => {
        await writeFile('a.ts', 'only apples\n');
        const res = await searchWorkspace(root, 'oranges');
        expect(res.totalMatches).toBe(0);
        expect(res.results).toEqual([]);
        expect(res.truncated).toBe(false);
    });

    it('supports regex mode', async () => {
        await writeFile('a.ts', 'foo_a1 bar_b2 baz_c3\n');
        const res = await searchWorkspace(root, '_[a-c]\\d', { regex: true });
        expect(res.totalMatches).toBe(1);
    });
});
