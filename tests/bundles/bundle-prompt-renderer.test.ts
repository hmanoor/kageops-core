/**
 * P1-11 — Bundle prompt renderer tests.
 *
 * Two layers:
 *
 *   1. Pure unit tests for `substituteVars` (no I/O).
 *   2. Tempdir-backed tests for `renderBundlePrompt` (loads .md files
 *      from a fake bundle).
 *
 * The character-level equivalence test against the inline Forge
 * prompts lives in `vanilla-html-bundle.test.ts` to keep this file
 * focused on the renderer mechanics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    renderBundlePrompt,
    substituteVars,
} from '../../src/bundles/bundle-prompt-renderer';
import type { LoadedBundle } from '../../src/bundles/types';

// ── substituteVars ──

describe('substituteVars()', () => {
    it('substitutes {{name}} placeholders', () => {
        expect(substituteVars('Hello {{who}}', { who: 'world' })).toBe('Hello world');
    });

    it('substitutes multiple distinct placeholders', () => {
        expect(
            substituteVars('Title: {{title}}\nDescription: {{description}}', {
                title: 'Solarsizer',
                description: 'A solar calculator.',
            })
        ).toBe('Title: Solarsizer\nDescription: A solar calculator.');
    });

    it('substitutes repeated placeholders (all instances replaced)', () => {
        expect(substituteVars('{{x}} + {{x}} = {{x}}{{x}}', { x: '2' })).toBe('2 + 2 = 22');
    });

    it('leaves text without placeholders unchanged', () => {
        expect(substituteVars('No placeholders here.', {})).toBe('No placeholders here.');
    });

    it('throws when a placeholder has no matching var', () => {
        expect(() => substituteVars('Hello {{name}}', {})).toThrow(/undefined vars: name/);
    });

    it('throws naming all missing vars (sorted) when multiple', () => {
        expect(() =>
            substituteVars('{{c}} {{a}} {{b}}', {})
        ).toThrow(/undefined vars: a, b, c/);
    });

    it('does not substitute placeholders with invalid identifier chars (e.g. spaces)', () => {
        // `{{ x }}` (with spaces) is not a placeholder per the regex.
        const result = substituteVars('{{ space }} {{ok}}', { ok: 'yes', ' space ': 'no' });
        expect(result).toBe('{{ space }} yes');
    });

    it('accepts vars whose values contain {{ }} — does not recursively substitute', () => {
        // Output of one substitution is NOT scanned for further placeholders.
        expect(substituteVars('Wrapper: {{inner}}', { inner: '{{recurse}}' })).toBe(
            'Wrapper: {{recurse}}'
        );
    });
});

// ── renderBundlePrompt (with tempdir bundles) ──

let bundleDir: string;

beforeEach(() => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bundle-render-'));
    fs.mkdirSync(path.join(bundleDir, 'prompts'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
});

function makeFakeBundle(overrides: Partial<LoadedBundle['manifest']> = {}): LoadedBundle {
    return {
        directory: bundleDir,
        manifest: {
            schemaVersion: 1,
            name: 'fake',
            kind: 'stack',
            version: '1.0.0',
            description: 'fake',
            prompts: {
                hello: 'prompts/hello.md',
            },
            ...overrides,
        },
    };
}

describe('renderBundlePrompt()', () => {
    it('loads + renders a template file', async () => {
        fs.writeFileSync(
            path.join(bundleDir, 'prompts', 'hello.md'),
            'Hello {{name}}, you said: {{message}}'
        );
        const bundle = makeFakeBundle();
        const out = await renderBundlePrompt(bundle, {
            promptKey: 'hello',
            vars: { name: 'world', message: 'hi' },
        });
        expect(out).toBe('Hello world, you said: hi');
    });

    it('strips a single trailing newline from the template file', async () => {
        // Markdown files conventionally end with \n. Inline JS strings don't.
        // Renderer normalises away the difference.
        fs.writeFileSync(path.join(bundleDir, 'prompts', 'hello.md'), 'Last line.\n');
        const out = await renderBundlePrompt(makeFakeBundle(), {
            promptKey: 'hello',
            vars: {},
        });
        expect(out).toBe('Last line.');
    });

    it('strips only ONE trailing newline (preserves intentional blank trailers)', async () => {
        // Two newlines = author wanted one blank line at the end.
        fs.writeFileSync(path.join(bundleDir, 'prompts', 'hello.md'), 'Last line.\n\n');
        const out = await renderBundlePrompt(makeFakeBundle(), {
            promptKey: 'hello',
            vars: {},
        });
        expect(out).toBe('Last line.\n');
    });

    it('normalises CRLF line endings to LF (cross-platform safety)', async () => {
        // Simulates git autocrlf having rewritten the .md file to CRLF
        // when the bundle author committed on Windows.
        fs.writeFileSync(
            path.join(bundleDir, 'prompts', 'hello.md'),
            'first line\r\nsecond line\r\n'
        );
        const out = await renderBundlePrompt(makeFakeBundle(), {
            promptKey: 'hello',
            vars: {},
        });
        // Expect LF-only output with the single trailing LF stripped.
        expect(out).toBe('first line\nsecond line');
        expect(out).not.toContain('\r');
    });

    it('throws when the prompt key is missing from the manifest', async () => {
        const bundle = makeFakeBundle({ prompts: { other: 'prompts/other.md' } });
        await expect(
            renderBundlePrompt(bundle, { promptKey: 'hello', vars: {} })
        ).rejects.toThrow(/has no prompt "hello"/);
    });

    it('throws when the prompt file is missing on disk', async () => {
        const bundle = makeFakeBundle();
        await expect(
            renderBundlePrompt(bundle, { promptKey: 'hello', vars: {} })
        ).rejects.toThrow();
    });

    it('throws if vars are missing for placeholders in the template', async () => {
        fs.writeFileSync(path.join(bundleDir, 'prompts', 'hello.md'), 'Hi {{name}}');
        await expect(
            renderBundlePrompt(makeFakeBundle(), { promptKey: 'hello', vars: {} })
        ).rejects.toThrow(/undefined vars: name/);
    });
});
