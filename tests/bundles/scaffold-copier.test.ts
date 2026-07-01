/**
 * P2-02 — Bundle scaffold copier tests.
 *
 * Real-tempdir integration tests so the cross-platform path handling
 * (Windows backslashes, Unix forward slashes, dotfile basenames) is
 * exercised end-to-end. Mirrors tests/bundles/bundle-loader.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    copyBundleScaffold,
    substituteVars,
} from '../../src/bundles/scaffold-copier';
import type { LoadedBundle } from '../../src/bundles/types';

let workDir: string;

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-scaffold-'));
});

afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

function setupFakeBundle(files: ReadonlyArray<{ rel: string; content: string }>): LoadedBundle {
    const bundleDir = path.join(workDir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    for (const f of files) {
        const abs = path.join(bundleDir, f.rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.content);
    }
    return {
        directory: bundleDir,
        manifest: {
            schemaVersion: 1,
            name: 'fake',
            kind: 'stack',
            version: '1.0.0',
            description: 'fake bundle for tests',
            scaffold: {
                files: files.map((f) => f.rel),
            },
        },
    };
}

describe('substituteVars()', () => {
    it('replaces {{var}} with the matching value', () => {
        expect(substituteVars('Hello {{name}}', { name: 'World' })).toBe('Hello World');
    });

    it('handles multiple placeholders', () => {
        expect(
            substituteVars('{{a}} and {{b}}', { a: 'foo', b: 'bar' })
        ).toBe('foo and bar');
    });

    it('throws on missing var rather than silently emitting empty string', () => {
        expect(() => substituteVars('Hello {{name}}', {})).toThrow(/undefined vars: name/);
    });

    it('lists every missing var in the error message', () => {
        expect(() => substituteVars('{{a}} {{b}}', {})).toThrow(/a, b/);
    });

    it('leaves text without placeholders unchanged', () => {
        expect(substituteVars('plain text', { name: 'X' })).toBe('plain text');
    });
});

describe('copyBundleScaffold() — basic copy', () => {
    it('copies declared files into destDir, stripping the leading scaffold/ prefix', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/package.json', content: '{"name":"test"}' },
            { rel: 'scaffold/app/page.tsx', content: 'export default function Page() {}' },
        ]);
        const destDir = path.join(workDir, 'project');

        const result = await copyBundleScaffold({
            bundle,
            destDir,
            vars: {},
        });

        expect(result.filesCopied.sort()).toEqual(
            ['app/page.tsx', 'package.json'].sort()
        );
        expect(fs.existsSync(path.join(destDir, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(destDir, 'app', 'page.tsx'))).toBe(true);
        // The scaffold/ namespace should NOT exist in the destination
        expect(fs.existsSync(path.join(destDir, 'scaffold'))).toBe(false);
    });

    it('returns empty result when bundle has no scaffold block', async () => {
        const bundle: LoadedBundle = {
            directory: workDir,
            manifest: {
                schemaVersion: 1,
                name: 'no-scaffold',
                kind: 'stack',
                version: '1.0.0',
                description: 'x',
            },
        };
        const result = await copyBundleScaffold({
            bundle,
            destDir: path.join(workDir, 'project'),
            vars: {},
        });
        expect(result).toEqual({ filesCopied: [], filesSkipped: [] });
    });

    it('creates destDir if it does not exist', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/README.md', content: 'hello' },
        ]);
        const destDir = path.join(workDir, 'nested', 'project');
        expect(fs.existsSync(destDir)).toBe(false);

        await copyBundleScaffold({ bundle, destDir, vars: {} });

        expect(fs.existsSync(destDir)).toBe(true);
        expect(fs.readFileSync(path.join(destDir, 'README.md'), 'utf8')).toBe('hello');
    });
});

describe('copyBundleScaffold() — variable substitution', () => {
    it('substitutes {{title}} in markdown files', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/README.md', content: '# {{title}}\n\nDescription: {{description}}' },
        ]);
        const destDir = path.join(workDir, 'project');

        await copyBundleScaffold({
            bundle,
            destDir,
            vars: { title: 'My App', description: 'A great app' },
        });

        const content = fs.readFileSync(path.join(destDir, 'README.md'), 'utf8');
        expect(content).toBe('# My App\n\nDescription: A great app');
    });

    it('substitutes vars in package.json', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/package.json', content: '{"name":"{{slug}}"}' },
        ]);
        await copyBundleScaffold({
            bundle,
            destDir: path.join(workDir, 'project'),
            vars: { slug: 'my-app' },
        });
        const content = fs.readFileSync(
            path.join(workDir, 'project', 'package.json'),
            'utf8'
        );
        expect(content).toBe('{"name":"my-app"}');
    });

    it('substitutes vars in TSX scaffold files', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/app/page.tsx', content: '<h1>{{title}}</h1>' },
        ]);
        await copyBundleScaffold({
            bundle,
            destDir: path.join(workDir, 'project'),
            vars: { title: 'Welcome' },
        });
        const content = fs.readFileSync(
            path.join(workDir, 'project', 'app', 'page.tsx'),
            'utf8'
        );
        expect(content).toBe('<h1>Welcome</h1>');
    });

    it('substitutes vars in dotfiles like .env.example', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/.env.example', content: 'NAME={{title}}' },
        ]);
        await copyBundleScaffold({
            bundle,
            destDir: path.join(workDir, 'project'),
            vars: { title: 'X' },
        });
        const content = fs.readFileSync(
            path.join(workDir, 'project', '.env.example'),
            'utf8'
        );
        expect(content).toBe('NAME=X');
    });

    it('throws when a placeholder has no matching var', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/README.md', content: '{{missing}}' },
        ]);
        await expect(
            copyBundleScaffold({
                bundle,
                destDir: path.join(workDir, 'project'),
                vars: {},
            })
        ).rejects.toThrow(/undefined vars: missing/);
    });
});

describe('copyBundleScaffold() — overwrite + collision handling', () => {
    it('skips collisions by default', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/README.md', content: 'NEW' },
        ]);
        const destDir = path.join(workDir, 'project');
        fs.mkdirSync(destDir);
        fs.writeFileSync(path.join(destDir, 'README.md'), 'OLD');

        const result = await copyBundleScaffold({ bundle, destDir, vars: {} });

        expect(result.filesCopied).toEqual([]);
        expect(result.filesSkipped).toEqual(['README.md']);
        expect(fs.readFileSync(path.join(destDir, 'README.md'), 'utf8')).toBe('OLD');
    });

    it('overwrites when overwrite: true', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/README.md', content: 'NEW' },
        ]);
        const destDir = path.join(workDir, 'project');
        fs.mkdirSync(destDir);
        fs.writeFileSync(path.join(destDir, 'README.md'), 'OLD');

        const result = await copyBundleScaffold({
            bundle,
            destDir,
            vars: {},
            overwrite: true,
        });

        expect(result.filesCopied).toEqual(['README.md']);
        expect(fs.readFileSync(path.join(destDir, 'README.md'), 'utf8')).toBe('NEW');
    });
});

describe('copyBundleScaffold() — binary files', () => {
    it('copies non-text-like files byte-for-byte without parsing', async () => {
        const bundle = setupFakeBundle([
            { rel: 'scaffold/icon.png', content: 'fake-binary-{{would-throw}}' },
        ]);
        // ".png" is NOT in TEXTLIKE_EXTENSIONS, so {{would-throw}} should
        // NOT be substituted — copyFile should pass it through verbatim.
        const result = await copyBundleScaffold({
            bundle,
            destDir: path.join(workDir, 'project'),
            vars: {},
        });
        expect(result.filesCopied).toEqual(['icon.png']);
        const content = fs.readFileSync(
            path.join(workDir, 'project', 'icon.png'),
            'utf8'
        );
        expect(content).toBe('fake-binary-{{would-throw}}');
    });
});
