/**
 * F-391 — content-aware `evidenceFromFiles` shape check.
 *
 * Tests the verifier blind-spot fix from #165 stage 2 smoke. Before
 * F-391, `evidenceFromFiles(paths)` only counted entries; passed was
 * `paths.length > 0`. That meant Forge writing 5 stub `.ts` files
 * yielded "Verified: 4/2 checks passed". After F-391, when `repoPath`
 * is provided, the verifier reads each file back and runs
 * `isLikelyArtifactContent` on the content — any failing file flips
 * the entire evidence to `passed: false`.
 *
 * Paired with F-390 (write-time guard) — F-390 prevents the stubs from
 * being written in the first place; F-391 is the defense-in-depth that
 * catches them if F-390 is bypassed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evidenceFromFiles } from '../../src/agents/verification-gate';

describe('evidenceFromFiles() — F-391 content-aware mode', () => {
    let tmpRepo: string;

    beforeEach(() => {
        tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-f391-'));
    });

    afterEach(() => {
        if (fs.existsSync(tmpRepo)) {
            fs.rmSync(tmpRepo, { recursive: true, force: true });
        }
    });

    function writeFile(rel: string, content: string): void {
        const abs = path.join(tmpRepo, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
    }

    it('passes when all files have real artifact content', () => {
        writeFile('backend/src/index.ts', "import express from 'express';\nexport const app = express();\n");
        writeFile('frontend/src/App.tsx', "import React from 'react';\nexport default function App() { return <div />; }\n");

        const evidence = evidenceFromFiles(
            ['backend/src/index.ts', 'frontend/src/App.tsx'],
            { repoPath: tmpRepo },
        );

        expect(evidence.passed).toBe(true);
        expect(evidence.kind).toBe('files_written');
        expect(evidence.summary).toMatch(/all pass shape check/);
    });

    it('fails when any file is prose stub (the exact 2026-05-21 Forge regression)', () => {
        writeFile(
            'backend/src/index.ts',
            'Express app with createApp() factory; Map<id,Vehicle> state; Zod validation for POST body;\n' +
                'WS snapshot-on-connect + broadcast on position_update; httpServer + WSS returned for test teardown.',
        );
        writeFile('frontend/src/App.tsx', "import React from 'react';\nexport default function App() { return <div />; }\n");

        const evidence = evidenceFromFiles(
            ['backend/src/index.ts', 'frontend/src/App.tsx'],
            { repoPath: tmpRepo },
        );

        expect(evidence.passed).toBe(false);
        expect(evidence.summary).toMatch(/F-391/);
        expect(evidence.summary).toMatch(/1 of 2 file\(s\) failed shape check/);
        expect(evidence.output).toContain('backend/src/index.ts');
        expect(evidence.output).toContain('Express app with createApp');
    });

    it('reports all stub files in the output when multiple fail', () => {
        writeFile('backend/src/index.ts', 'Express app description.');
        writeFile('frontend/src/App.tsx', 'React component description.');
        writeFile('frontend/src/index.tsx', 'createRoot bootstrap.');

        const evidence = evidenceFromFiles(
            ['backend/src/index.ts', 'frontend/src/App.tsx', 'frontend/src/index.tsx'],
            { repoPath: tmpRepo },
        );

        expect(evidence.passed).toBe(false);
        expect(evidence.summary).toMatch(/3 of 3 file\(s\) failed/);
        expect(evidence.output).toContain('backend/src/index.ts');
        expect(evidence.output).toContain('frontend/src/App.tsx');
        expect(evidence.output).toContain('frontend/src/index.tsx');
    });

    it('treats missing files as stubs (defensive)', () => {
        const evidence = evidenceFromFiles(['nope/missing.ts'], { repoPath: tmpRepo });

        expect(evidence.passed).toBe(false);
        expect(evidence.summary).toMatch(/F-391/);
        expect(evidence.output).toContain('(unreadable)');
    });

    it('legacy path-only mode is unchanged (no repoPath → passes when any paths)', () => {
        const evidence = evidenceFromFiles(['foo.ts', 'bar.ts']);

        expect(evidence.passed).toBe(true);
        expect(evidence.summary).toMatch(/2 file\(s\) written/);
    });

    it('legacy path-only mode fails on zero paths', () => {
        const evidence = evidenceFromFiles([]);

        expect(evidence.passed).toBe(false);
        expect(evidence.summary).toMatch(/0 file/);
    });

    it('content-aware mode passes on zero paths (same as legacy)', () => {
        const evidence = evidenceFromFiles([], { repoPath: tmpRepo });

        expect(evidence.passed).toBe(false);
        expect(evidence.summary).toMatch(/0 file/);
    });

    it('accepts absolute paths inside the repo (defensive)', () => {
        writeFile('a.ts', "import x from 'y';\nconst z = 1;\n");
        const absPath = path.join(tmpRepo, 'a.ts');

        const evidence = evidenceFromFiles([absPath], { repoPath: tmpRepo });
        expect(evidence.passed).toBe(true);
    });
});
