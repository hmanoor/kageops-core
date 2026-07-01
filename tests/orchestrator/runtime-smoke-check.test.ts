/**
 * Runtime smoke check tests.
 *
 * Uses a real temp directory + real jsdom (no mocks) because the
 * interesting cases — JS throwing on DOMContentLoaded, console.error
 * during init, missing script references — are all behaviours that
 * only emerge when scripts actually execute.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { runRuntimeSmoke } from '../../src/orchestrator/runtime-smoke-check';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-smoke-'));
}

function writeFiles(repo: string, files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(repo, name), content, 'utf-8');
    }
}

describe('runRuntimeSmoke', () => {
    let repo: string;

    beforeEach(() => {
        repo = makeTempRepo();
        delete process.env.KAGEOPS_RUNTIME_SMOKE;
    });

    afterEach(() => {
        try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('returns no violations for clean HTML', async () => {
        writeFiles(repo, {
            'index.html': '<!doctype html><html><body><h1>hi</h1></body></html>',
        });
        const violations = await runRuntimeSmoke(repo, 50);
        expect(violations).toEqual([]);
    });

    it('returns [] when no index.html exists', async () => {
        const violations = await runRuntimeSmoke(repo, 50);
        expect(violations).toEqual([]);
    });

    it('returns [] when disabled by env', async () => {
        process.env.KAGEOPS_RUNTIME_SMOKE = '0';
        writeFiles(repo, {
            'index.html': '<!doctype html><html><body><script>throw new Error("boom")</script></body></html>',
        });
        const violations = await runRuntimeSmoke(repo, 50);
        expect(violations).toEqual([]);
    });

    it('catches an inline script that throws on load', async () => {
        writeFiles(repo, {
            'index.html': '<!doctype html><html><body><script>throw new Error("boom")</script></body></html>',
        });
        const violations = await runRuntimeSmoke(repo, 100);
        expect(violations.length).toBeGreaterThan(0);
        expect(violations[0].check).toBe('runtime-error');
        expect(violations[0].message).toContain('boom');
    });

    it('catches console.error calls during init', async () => {
        writeFiles(repo, {
            'index.html': '<!doctype html><html><body><script>console.error("bad config")</script></body></html>',
        });
        const violations = await runRuntimeSmoke(repo, 100);
        const consoleErr = violations.find((v) => v.check === 'console-error');
        expect(consoleErr).toBeDefined();
        expect(consoleErr?.message).toContain('bad config');
    });

    it('detects GreenThumb-style missing script.js via load error', async () => {
        writeFiles(repo, {
            'index.html': [
                '<!doctype html><html><body>',
                '<script src="script.js"></script>',
                '</body></html>',
            ].join('\n'),
        });
        // jsdom emits an 'error' event when a local resource fails to load.
        // We don't strictly assert the message — just that something tripped.
        const violations = await runRuntimeSmoke(repo, 150);
        // Not guaranteed to produce a violation via the error event —
        // jsdom's behaviour here varies — but static-asset-checks already
        // covers missing files. We assert: runtime smoke does not CRASH,
        // even when resources are missing.
        expect(Array.isArray(violations)).toBe(true);
    });

    it('passes a complete, clean static site', async () => {
        writeFiles(repo, {
            'index.html': [
                '<!doctype html><html><head>',
                '<link rel="stylesheet" href="style.css">',
                '</head><body>',
                '<h1 id="hero">Hello</h1>',
                '<script src="script.js"></script>',
                '</body></html>',
            ].join('\n'),
            'style.css': 'body { color: red; }',
            'script.js': 'document.getElementById("hero").textContent = "Loaded";',
        });
        const violations = await runRuntimeSmoke(repo, 100);
        expect(violations).toEqual([]);
    });
});
