/**
 * Output parser unit tests
 *
 * Tests the shared AI output → file block parser used by all agents.
 */

import { describe, it, expect } from 'vitest';
import {
    parseFileBlocks,
    isValidFilePath,
    stripMarkdownFences,
    stripBom,
    stripZeroWidth,
    normalizeSmartQuotes,
    normalizeNbsp,
    sanitizeAgentOutput,
    isLikelyArtifactContent,
    recoverArtifactFromNarration,
    sanitizePackageJson,
    isNoOpFileNote,
} from '../../src/agents/output-parser';

// ── parseFileBlocks() ────────────────────────────────────────────────────────

describe('parseFileBlocks()', () => {
    it('parses a single file block', () => {
        const output = [
            '--- FILE: src/index.ts ---',
            'console.log("hello");',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].filePath).toBe('src/index.ts');
        expect(blocks[0].content).toBe('console.log("hello");');
    });

    it('parses multiple file blocks', () => {
        const output = [
            '--- FILE: src/a.ts ---',
            'const a = 1;',
            '--- END FILE ---',
            '--- FILE: src/b.ts ---',
            'const b = 2;',
            '--- END FILE ---',
            '--- FILE: tests/a.test.ts ---',
            'test("a", () => {});',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(3);
        expect(blocks[0].filePath).toBe('src/a.ts');
        expect(blocks[1].filePath).toBe('src/b.ts');
        expect(blocks[2].filePath).toBe('tests/a.test.ts');
    });

    it('handles consecutive FILE markers without END FILE', () => {
        const output = [
            '--- FILE: src/a.ts ---',
            'const a = 1;',
            '--- FILE: src/b.ts ---',
            'const b = 2;',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(2);
        expect(blocks[0].filePath).toBe('src/a.ts');
        expect(blocks[1].filePath).toBe('src/b.ts');
    });

    it('returns empty array when no file blocks found', () => {
        const output = 'Just some text with no file blocks.';

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
        expect(parseFileBlocks('')).toHaveLength(0);
    });

    it('skips blocks with empty content', () => {
        const output = [
            '--- FILE: src/empty.ts ---',
            '',
            '--- END FILE ---',
            '--- FILE: src/real.ts ---',
            'const x = 1;',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].filePath).toBe('src/real.ts');
    });

    it('rejects path traversal in file paths', () => {
        const output = [
            '--- FILE: ../../../etc/passwd ---',
            'root:x:0:0:root:/root:/bin/bash',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(0);
    });

    it('rejects absolute paths', () => {
        const output = [
            '--- FILE: /etc/passwd ---',
            'dangerous content',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(0);
    });

    it('rejects Windows absolute paths', () => {
        const output = [
            '--- FILE: C:\\Windows\\System32\\config ---',
            'dangerous content',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(0);
    });

    it('preserves multi-line content including code blocks', () => {
        const content = [
            '# README',
            '',
            '```typescript',
            'function hello(): void {',
            '  console.log("world");',
            '}',
            '```',
        ].join('\n');

        const output = [
            '--- FILE: README.md ---',
            content,
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].content).toContain('```typescript');
        expect(blocks[0].content).toContain('function hello()');
    });

    it('trims whitespace from paths and content', () => {
        const output = [
            '--- FILE:  src/padded.ts  ---',
            '  const x = 1;  ',
            '--- END FILE ---',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].filePath).toBe('src/padded.ts');
        expect(blocks[0].content).toBe('const x = 1;');
    });

    it('handles text before and after file blocks (preamble/epilogue)', () => {
        const output = [
            'Here is the implementation:',
            '',
            '--- FILE: src/main.ts ---',
            'export function main() {}',
            '--- END FILE ---',
            '',
            'Let me know if you need changes.',
        ].join('\n');

        const blocks = parseFileBlocks(output);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].filePath).toBe('src/main.ts');
    });

    it('can be called multiple times without state leaking', () => {
        const output = '--- FILE: a.ts ---\nconst a = 1;\n--- END FILE ---';

        const blocks1 = parseFileBlocks(output);
        const blocks2 = parseFileBlocks(output);

        expect(blocks1).toHaveLength(1);
        expect(blocks2).toHaveLength(1);
    });
});

// ── isValidFilePath() ────────────────────────────────────────────────────────

describe('isValidFilePath()', () => {
    it('accepts normal relative paths', () => {
        expect(isValidFilePath('src/index.ts')).toBe(true);
        expect(isValidFilePath('docs/README.md')).toBe(true);
        expect(isValidFilePath('tests/unit/auth.test.ts')).toBe(true);
    });

    it('accepts single-level file names', () => {
        expect(isValidFilePath('package.json')).toBe(true);
        expect(isValidFilePath('.gitignore')).toBe(true);
    });

    it('rejects path traversal with ..', () => {
        expect(isValidFilePath('../secret.txt')).toBe(false);
        expect(isValidFilePath('../../etc/passwd')).toBe(false);
        expect(isValidFilePath('src/../../escape.ts')).toBe(false);
    });

    it('rejects Unix absolute paths', () => {
        expect(isValidFilePath('/etc/passwd')).toBe(false);
        expect(isValidFilePath('/home/user/.ssh/id_rsa')).toBe(false);
    });

    it('rejects Windows absolute paths', () => {
        expect(isValidFilePath('C:\\Windows\\System32')).toBe(false);
        expect(isValidFilePath('D:\\data')).toBe(false);
    });

    it('rejects null bytes', () => {
        expect(isValidFilePath('src/file\0.ts')).toBe(false);
    });
});

// ── stripMarkdownFences() ────────────────────────────────────────────────────

describe('stripMarkdownFences()', () => {
    it('strips full-wrap fences with language tag', () => {
        const input = '```css\nbody { color: red; }\n```';
        expect(stripMarkdownFences(input)).toBe('body { color: red; }');
    });

    it('strips full-wrap fences without language tag', () => {
        const input = '```\nconst x = 1;\n```';
        expect(stripMarkdownFences(input)).toBe('const x = 1;');
    });

    it('strips a leading fence when no closing fence exists (GreenThumb case)', () => {
        // The exact 2026-04-22 GreenThumb shape: leading ```css, no trailing ```
        const input = '```css\nbody { color: red; }\n.empty { margin: 0; }';
        expect(stripMarkdownFences(input)).toBe('body { color: red; }\n.empty { margin: 0; }');
    });

    it('strips a trailing fence when no opening fence exists', () => {
        const input = 'body { color: red; }\n```';
        expect(stripMarkdownFences(input)).toBe('body { color: red; }');
    });

    it('leaves fences in the middle of the file (e.g. README code blocks)', () => {
        const input = [
            '# Docs',
            '',
            '```typescript',
            'const x = 1;',
            '```',
            '',
            'end',
        ].join('\n');
        expect(stripMarkdownFences(input)).toBe(input);
    });

    it('leaves clean content untouched', () => {
        const input = 'body { color: red; }\nh1 { margin: 0; }';
        expect(stripMarkdownFences(input)).toBe(input);
    });

    it('does not strip backticks inside a line', () => {
        // `content: "\`\`\`"` in CSS — not a fence line, stays.
        const input = 'body::before { content: "```"; }';
        expect(stripMarkdownFences(input)).toBe(input);
    });

    it('is idempotent', () => {
        const once = stripMarkdownFences('```css\nbody { color: red; }\n```');
        const twice = stripMarkdownFences(once);
        expect(twice).toBe(once);
    });
});

// ── stripBom() ───────────────────────────────────────────────────────────────

describe('stripBom()', () => {
    it('strips a leading BOM', () => {
        expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}');
    });

    it('leaves content without a BOM unchanged', () => {
        expect(stripBom('no bom here')).toBe('no bom here');
    });

    it('only strips the leading BOM, not BOMs mid-string', () => {
        expect(stripBom('foo\uFEFFbar')).toBe('foo\uFEFFbar');
    });

    it('is idempotent', () => {
        const once = stripBom('\uFEFFhello');
        expect(stripBom(once)).toBe(once);
    });
});

// ── stripZeroWidth() ─────────────────────────────────────────────────────────

describe('stripZeroWidth()', () => {
    it('strips zero-width spaces anywhere in the string', () => {
        expect(stripZeroWidth('foo\u200Bbar\u200Bbaz')).toBe('foobarbaz');
    });

    it('strips zero-width joiners and non-joiners', () => {
        expect(stripZeroWidth('a\u200Cb\u200Dc')).toBe('abc');
    });

    it('strips BOMs mid-string (complements stripBom)', () => {
        expect(stripZeroWidth('clean\uFEFFtext')).toBe('cleantext');
    });

    it('leaves normal whitespace alone', () => {
        expect(stripZeroWidth('a\n\tb  c')).toBe('a\n\tb  c');
    });

    it('is idempotent', () => {
        const once = stripZeroWidth('x\u200By\u200Cz');
        expect(stripZeroWidth(once)).toBe(once);
    });
});

// ── normalizeSmartQuotes() ───────────────────────────────────────────────────

describe('normalizeSmartQuotes()', () => {
    it('converts curly double quotes to straight', () => {
        expect(normalizeSmartQuotes('\u201Chello\u201D')).toBe('"hello"');
    });

    it('converts curly single quotes to straight', () => {
        expect(normalizeSmartQuotes('\u2018it\u2019s\u2019')).toBe("'it's'");
    });

    it('leaves straight quotes alone', () => {
        expect(normalizeSmartQuotes(`"a" + 'b'`)).toBe(`"a" + 'b'`);
    });

    it('handles a realistic JS literal with smart quotes', () => {
        // AI-emitted bug: string literal opens with “ and closes with ”
        const broken = 'const msg = \u201Chello world\u201D;';
        expect(normalizeSmartQuotes(broken)).toBe('const msg = "hello world";');
    });

    it('is idempotent', () => {
        const once = normalizeSmartQuotes('\u201Cfoo\u201D');
        expect(normalizeSmartQuotes(once)).toBe(once);
    });
});

// ── normalizeNbsp() ──────────────────────────────────────────────────────────

describe('normalizeNbsp()', () => {
    it('replaces non-breaking spaces with regular spaces', () => {
        expect(normalizeNbsp('foo\u00A0bar')).toBe('foo bar');
    });

    it('leaves regular spaces alone', () => {
        expect(normalizeNbsp('a b c')).toBe('a b c');
    });

    it('fixes indentation-leading NBSPs that would break Python', () => {
        const broken = 'def f():\n\u00A0\u00A0\u00A0\u00A0return 1';
        expect(normalizeNbsp(broken)).toBe('def f():\n    return 1');
    });

    it('is idempotent', () => {
        const once = normalizeNbsp('a\u00A0b');
        expect(normalizeNbsp(once)).toBe(once);
    });
});

// ── sanitizeAgentOutput() ────────────────────────────────────────────────────

describe('sanitizeAgentOutput()', () => {
    it('layers BOM-strip + fence-strip + zero-width-strip for any file type', () => {
        const input = '\uFEFF```css\nbody\u200B { color: red; }\n```';
        expect(sanitizeAgentOutput(input, 'style.css')).toBe('body { color: red; }');
    });

    it('normalizes smart quotes for .js files', () => {
        const input = 'const msg = \u201Chi\u201D;';
        expect(sanitizeAgentOutput(input, 'src/app.js')).toBe('const msg = "hi";');
    });

    it('normalizes smart quotes for .ts and .tsx files', () => {
        expect(sanitizeAgentOutput('\u2018a\u2019', 'x.ts')).toBe("'a'");
        expect(sanitizeAgentOutput('\u201Ca\u201D', 'x.tsx')).toBe('"a"');
    });

    it('normalizes smart quotes for .json files (JSON.parse would reject them)', () => {
        const input = '{\u201Ckey\u201D: \u201Cvalue\u201D}';
        expect(sanitizeAgentOutput(input, 'pkg.json')).toBe('{"key": "value"}');
    });

    it('preserves smart quotes in markdown (typographic intent)', () => {
        const input = '\u201CHello\u201D, said he.';
        expect(sanitizeAgentOutput(input, 'README.md')).toBe('\u201CHello\u201D, said he.');
    });

    it('preserves smart quotes in plain text', () => {
        const input = '\u201Chi\u201D';
        expect(sanitizeAgentOutput(input, 'notes.txt')).toBe('\u201Chi\u201D');
    });

    it('preserves smart quotes in HTML (body-content typography)', () => {
        const input = '<p>\u201Cquoted\u201D</p>';
        expect(sanitizeAgentOutput(input, 'index.html')).toBe('<p>\u201Cquoted\u201D</p>');
    });

    it('normalizes NBSP in python indentation', () => {
        const input = 'def f():\n\u00A0\u00A0\u00A0\u00A0return 1';
        expect(sanitizeAgentOutput(input, 'app.py')).toBe('def f():\n    return 1');
    });

    it('is idempotent — running twice is a no-op', () => {
        const input = '\uFEFF```js\nconst x = \u201Chi\u201D;\n```';
        const once = sanitizeAgentOutput(input, 'x.js');
        const twice = sanitizeAgentOutput(once, 'x.js');
        expect(twice).toBe(once);
    });

    it('handles clean content untouched', () => {
        const input = 'body { color: red; }';
        expect(sanitizeAgentOutput(input, 'style.css')).toBe(input);
    });

    it('is case-insensitive on file extension', () => {
        const input = 'const x = \u201Chi\u201D;';
        expect(sanitizeAgentOutput(input, 'App.JS')).toBe('const x = "hi";');
    });

    it('handles files without an extension as non-code (conservative)', () => {
        // No extension → no smart-quote normalization. Safer default.
        const input = '\u201Chi\u201D';
        expect(sanitizeAgentOutput(input, 'Dockerfile')).toBe('\u201Chi\u201D');
    });
});

// ── recoverArtifactFromNarration() (BPF-4) ───────────────────────────────────

describe('recoverArtifactFromNarration()', () => {
    const CODE = "import { useState } from 'react';\nexport default function Page() {\n  return <main id=\"hero\">Hi</main>;\n}\n";

    it('recovers a .tsx artifact behind a reasoning preamble (the run-5 failure)', () => {
        const input =
            "I'll analyze the current workspace structure first, then implement the landing page as specified.\n\n" +
            CODE;
        const recovered = recoverArtifactFromNarration(input, 'src/app/(public)/page.tsx');
        expect(recovered).not.toBeNull();
        expect(recovered!.startsWith("import { useState }")).toBe(true);
        expect(isLikelyArtifactContent(recovered!, 'src/app/(public)/page.tsx')).toBe(true);
    });

    it('recovers from a fenced code block after a preamble', () => {
        const input = "Let me implement this for you:\n\n```tsx\n" + CODE + "```\n";
        const recovered = recoverArtifactFromNarration(input, 'app/page.tsx');
        expect(recovered).not.toBeNull();
        expect(recovered!).toContain('export default function Page');
        expect(isLikelyArtifactContent(recovered!, 'app/page.tsx')).toBe(true);
    });

    it('returns null when the content is already a valid artifact (no-op)', () => {
        expect(recoverArtifactFromNarration(CODE, 'app/page.tsx')).toBeNull();
    });

    it('returns null for a chat-summary lead (no real artifact)', () => {
        const input = 'All 6 test files written. Summary of what was created:\n- a\n- b\n';
        expect(recoverArtifactFromNarration(input, 'app/page.tsx')).toBeNull();
    });

    it('returns null for mostly-prose content (no clean code body)', () => {
        const input =
            "I'll implement the page. First I analyze the requirements. Then I will write the code. " +
            "The page needs a hero. It also needs pricing. Let me think about the structure carefully.\n";
        expect(recoverArtifactFromNarration(input, 'app/page.tsx')).toBeNull();
    });

    it('never strips prose artifacts (.md) — prose IS the content', () => {
        const input = "I'll write the README.\n\n# Title\n\nbody text that is long enough to be a doc artifact on its own.";
        expect(recoverArtifactFromNarration(input, 'README.md')).toBeNull();
    });

    it('does not salvage a few code lines from a giant monologue (minority-preamble cap)', () => {
        const longPreamble = Array.from({ length: 40 }, (_, i) => `Step ${i}: I think about the design here in detail.`).join('\n');
        const input = longPreamble + '\nexport const x = 1;\n';
        expect(recoverArtifactFromNarration(input, 'src/x.ts')).toBeNull();
    });
});

// ── sanitizePackageJson() (BPF-9) ────────────────────────────────────────────

describe('sanitizePackageJson()', () => {
    it('strips TypeScript path aliases from dependencies (the EINVALIDPACKAGENAME bug)', () => {
        const input = JSON.stringify({
            name: 'app',
            dependencies: {
                'next': '^16.0.0',
                'zod': '*',
                '@clerk/themes': '*',
                '@paralleldrive/cuid2': '*',
                '@/components': '*',
                '@/lib': '*',
                '@/app': '*',
            },
        });
        const out = JSON.parse(sanitizePackageJson(input));
        expect(Object.keys(out.dependencies).sort()).toEqual(
            ['@clerk/themes', '@paralleldrive/cuid2', 'next', 'zod'].sort()
        );
        expect(out.dependencies['@/components']).toBeUndefined();
        expect(out.dependencies['@/lib']).toBeUndefined();
        expect(out.dependencies['next']).toBe('^16.0.0');
    });

    it('also cleans devDependencies and preserves valid scoped names + version ranges', () => {
        const input = JSON.stringify({
            devDependencies: { '@types/node': '^22.0.0', 'vitest': '*', '@/app': '*' },
        });
        const out = JSON.parse(sanitizePackageJson(input));
        expect(out.devDependencies).toEqual({ '@types/node': '^22.0.0', 'vitest': '*' });
    });

    it('returns a clean manifest unchanged (no reformat when nothing stripped)', () => {
        const input = JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0' } });
        expect(sanitizePackageJson(input)).toBe(input);
    });

    it('returns non-JSON content verbatim (never corrupts an unparseable file)', () => {
        expect(sanitizePackageJson('not json {')).toBe('not json {');
    });

    it('rejects names with illegal characters (spaces, uppercase paths)', () => {
        const input = JSON.stringify({ dependencies: { 'bad name': '*', 'UPPER/Case': '*', ok: '1.0.0' } });
        const out = JSON.parse(sanitizePackageJson(input));
        expect(Object.keys(out.dependencies)).toEqual(['ok']);
    });
});

// ── BPF-38: no-op "file already exists" note guard ──
describe('isNoOpFileNote + no-op-note artifact guard (BPF-38)', () => {
    it('detects a "file already exists" note disguised as code (_(...)_)', () => {
        const note = '_(file already exists — full content shown in read above, lines 1–139)_\n\n**E2E tests** (new files written):';
        expect(isNoOpFileNote(note)).toBe(true);
    });
    it('detects parenthetical / no-changes no-op notes', () => {
        expect(isNoOpFileNote('(no changes needed)')).toBe(true);
        expect(isNoOpFileNote('No edits needed — left as is.')).toBe(true);
        expect(isNoOpFileNote('Already created in a previous task.')).toBe(true);
    });
    it('rejects a no-op note as artifact content for a .test.ts file (the Prism corruption)', () => {
        const note = '_(file already exists — full content shown in read above, lines 1–139)_';
        expect(isLikelyArtifactContent(note, 'tests/easing.test.ts')).toBe(false);
    });
    it('does NOT misfire on real code that merely mentions existence', () => {
        const code = "import * as fs from 'fs';\nif (fs.existsSync(p)) doThing();";
        expect(isNoOpFileNote(code)).toBe(false);
        expect(isLikelyArtifactContent(code, 'src/a.ts')).toBe(true);
    });
    it('is false for empty / whitespace content', () => {
        expect(isNoOpFileNote('   ')).toBe(false);
    });
});
