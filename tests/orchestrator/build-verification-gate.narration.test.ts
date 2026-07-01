/**
 * BuildVerificationGate — narration-leak regression (real disk).
 *
 * The 2026-06 Next.js boot failure: an agent wrote 374 lines of its own
 * reasoning into `app/layout.tsx` instead of code, so EVERY route 500'd
 * because the app would not compile. This test proves the build gate
 * actually catches a non-compiling App-Router layout: it builds a real
 * temp project on disk whose `layout.tsx` is leaked narration and runs
 * the REAL gate (real `npm`, real `tsc`). The gate must FAIL at the
 * build step — never skip, never pass.
 *
 * Uses `tsc --noEmit` as the build script (Next is not a dev dep here)
 * and a no-op install (no dependencies) so the run stays fast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildVerificationGate } from '../../src/orchestrator/build-verification-gate';
import { createMockEventBus, type MockEventBus } from '../helpers/mock-event-bus';
import type { EventBus } from '../../src/orchestrator/event-bus';

const NARRATION_LAYOUT = [
    'Let me read them all systematically. I have several files to look at',
    'before I can write the layout. Actually, I need to just read the files',
    'and understand the structure first.',
    '',
    'The root layout should wrap everything. Here is roughly what it needs:',
    '',
    'export default function RootLayout({ children }) {',
    '  return <html><body>{children}</body></html>;',
    '}',
    '',
    'But wait, I should double-check the metadata export and the font setup.',
].join('\n');

const REAL_LAYOUT = [
    'export default function RootLayout(props: { children: unknown }) {',
    '  return props.children;',
    '}',
].join('\n');

// Absolute path to THIS repo's TypeScript compiler entrypoint, so the
// temp project can run `tsc` without an `npm install typescript` (kept
// fast + offline). Forward slashes work in package.json scripts on every
// OS once we JSON-stringify.
const REPO_TSC = path
    .resolve(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc')
    .replace(/\\/g, '/');

function writeProject(repoPath: string, layoutSource: string): void {
    fs.mkdirSync(path.join(repoPath, 'src', 'app'), { recursive: true });
    fs.writeFileSync(
        path.join(repoPath, 'package.json'),
        JSON.stringify({
            name: 'narration-regression',
            version: '1.0.0',
            scripts: {
                // `npm install` with no deps is a fast no-op; running this
                // repo's tsc via an absolute path is our stand-in for
                // `next build` — both fail on a syntactically broken layout.
                build: `node "${REPO_TSC}" --noEmit`,
            },
        }),
        'utf-8',
    );
    fs.writeFileSync(
        path.join(repoPath, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                jsx: 'react-jsx',
                noEmit: true,
                strict: true,
                module: 'esnext',
                target: 'es2020',
                moduleResolution: 'node',
                skipLibCheck: true,
            },
            include: ['src'],
        }),
        'utf-8',
    );
    fs.writeFileSync(path.join(repoPath, 'src', 'app', 'layout.tsx'), layoutSource, 'utf-8');
}

describe('BuildVerificationGate — narration layout regression (real tsc)', () => {
    let tmpRoot: string;
    let eventBus: MockEventBus;
    let gate: BuildVerificationGate;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-narration-'));
        eventBus = createMockEventBus();
        gate = new BuildVerificationGate(eventBus as unknown as EventBus);
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* best-effort cleanup */
        }
    });

    it('FAILS the gate (does not skip) when layout.tsx is leaked narration', async () => {
        const repoPath = path.join(tmpRoot, 'narration-app');
        writeProject(repoPath, NARRATION_LAYOUT);

        const result = await gate.verify('proj-narration', repoPath);

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('build');
        // It must have actually RUN the build (not skipped it).
        expect(result.steps.some((s) => s.step === 'build')).toBe(true);
    }, 120_000);

    it('PASSES the same project once layout.tsx is real code (control)', async () => {
        const repoPath = path.join(tmpRoot, 'real-app');
        writeProject(repoPath, REAL_LAYOUT);

        const result = await gate.verify('proj-real', repoPath);

        expect(result.passed).toBe(true);
        expect(result.failedStep).toBeNull();
    }, 120_000);
});
