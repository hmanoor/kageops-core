/**
 * BuildVerificationGate tests
 *
 * Mocks child_process.spawn to simulate npm install/build/test steps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── Mock child_process ──────────────────────────────

interface MockChild extends EventEmitter {
    readonly stdout: EventEmitter;
    readonly stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChild {
    const child = new EventEmitter() as MockChild;
    (child as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
    return child;
}

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

// Simulate a repo with package.json containing build + test scripts so that
// resolveBuildPlan produces all 3 steps. Individual tests can override by
// re-mocking fs before calling verify().
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() =>
            JSON.stringify({
                name: 'test-project',
                scripts: { build: 'tsc', test: 'vitest run' },
            })
        ),
        readdirSync: vi.fn(() => ['index.ts']),
    };
});

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
    }),
}));

// ── Import after mocks ─────────────────────────────

import {
    BuildVerificationGate,
    resolveBuildPlan,
    parseUnresolvablePackages,
    pruneUnresolvablePackages,
} from '../../src/orchestrator/build-verification-gate';
import * as fs from 'fs';
import type { MockEventBus } from '../helpers/mock-event-bus';

// ── Helpers ─────────────────────────────────────────

function setupSpawnSequence(results: Array<{ code: number; stdout?: string; stderr?: string }>): void {
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
        const child = createMockChild();
        const result = results[callIndex] ?? { code: 1, stderr: 'unexpected call' };
        callIndex++;

        process.nextTick(() => {
            if (result.stdout) {
                child.stdout.emit('data', Buffer.from(result.stdout));
            }
            if (result.stderr) {
                child.stderr.emit('data', Buffer.from(result.stderr));
            }
            child.emit('close', result.code);
        });

        return child;
    });
}

// ── Tests ───────────────────────────────────────────

describe('BuildVerificationGate', () => {
    let eventBus: MockEventBus;
    let gate: BuildVerificationGate;

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new BuildVerificationGate(eventBus as unknown as import('../../src/orchestrator/event-bus').EventBus);
        spawnMock.mockReset();
    });

    it('passes when all 3 steps succeed', async () => {
        setupSpawnSequence([
            { code: 0, stdout: 'install ok' },
            { code: 0, stdout: 'build ok' },
            { code: 0, stdout: 'test ok' },
        ]);

        const result = await gate.verify('proj-1', '/repo');

        expect(result.passed).toBe(true);
        expect(result.failedStep).toBeNull();
        expect(result.steps).toHaveLength(3);
        expect(result.steps[0].step).toBe('install');
        expect(result.steps[0].passed).toBe(true);
        expect(result.steps[1].step).toBe('build');
        expect(result.steps[1].passed).toBe(true);
        expect(result.steps[2].step).toBe('test');
        expect(result.steps[2].passed).toBe(true);

        expect(eventBus.publish).toHaveBeenCalledWith(
            'build.verification.passed',
            expect.objectContaining({ projectId: 'proj-1' })
        );
    });

    it('stops on install failure and reports failedStep', async () => {
        setupSpawnSequence([
            { code: 1, stderr: 'npm ERR! install failed' },
        ]);

        const result = await gate.verify('proj-2', '/repo');

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('install');
        expect(result.steps).toHaveLength(1);
        expect(spawnMock).toHaveBeenCalledTimes(1);

        expect(eventBus.publish).toHaveBeenCalledWith(
            'build.verification.failed',
            expect.objectContaining({
                projectId: 'proj-2',
                data: expect.objectContaining({ failedStep: 'install' }),
            })
        );
    });

    it('stops on build failure after install succeeds', async () => {
        setupSpawnSequence([
            { code: 0, stdout: 'install ok' },
            { code: 1, stderr: 'tsc error' },
        ]);

        const result = await gate.verify('proj-3', '/repo');

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('build');
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].passed).toBe(true);
        expect(result.steps[1].passed).toBe(false);
        expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('stops on test failure after build succeeds', async () => {
        setupSpawnSequence([
            { code: 0, stdout: 'install ok' },
            { code: 0, stdout: 'build ok' },
            { code: 1, stderr: '3 tests failed' },
        ]);

        const result = await gate.verify('proj-4', '/repo');

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('test');
        expect(result.steps).toHaveLength(3);
        expect(result.steps[0].passed).toBe(true);
        expect(result.steps[1].passed).toBe(true);
        expect(result.steps[2].passed).toBe(false);
    });

    it('handles spawn timeout by killing the process', async () => {
        vi.useFakeTimers();

        spawnMock.mockImplementation(() => {
            const child = createMockChild();

            // Simulate: process never closes on its own, timeout kills it
            child.kill.mockImplementation(() => {
                // After kill, emit close with non-zero code
                process.nextTick(() => {
                    child.emit('close', null);
                });
            });

            return child;
        });

        const verifyPromise = gate.verify('proj-5', '/repo');

        // Advance past the 5-minute timeout
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

        const result = await verifyPromise;

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('install');
        expect(result.steps[0].stderr).toContain('Timeout');

        vi.useRealTimers();
    });

    it('handles spawn error (e.g. npm not found)', async () => {
        spawnMock.mockImplementation(() => {
            const child = createMockChild();

            process.nextTick(() => {
                child.emit('error', new Error('spawn npm ENOENT'));
            });

            return child;
        });

        const result = await gate.verify('proj-6', '/repo');

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('install');
        expect(result.steps[0].stderr).toContain('ENOENT');
    });

    it('publishes build.verification.failed event with correct data', async () => {
        setupSpawnSequence([
            { code: 0, stdout: 'ok' },
            { code: 2, stderr: 'compilation error' },
        ]);

        await gate.verify('proj-7', '/repo');

        const failEvent = eventBus.publishedEvents.find(
            (e) => e.channel === 'build.verification.failed'
        );

        expect(failEvent).toBeDefined();
        expect(failEvent!.event.projectId).toBe('proj-7');
        expect(failEvent!.event.data.failedStep).toBe('build');
        expect(failEvent!.event.data.stderr).toBe('compilation error');
    });

    it('publishes build.verification.passed event on success', async () => {
        setupSpawnSequence([
            { code: 0 },
            { code: 0 },
            { code: 0 },
        ]);

        await gate.verify('proj-8', '/repo');

        const passEvent = eventBus.publishedEvents.find(
            (e) => e.channel === 'build.verification.passed'
        );

        expect(passEvent).toBeDefined();
        expect(passEvent!.event.projectId).toBe('proj-8');
    });

    it('captures stdout and stderr in step results', async () => {
        setupSpawnSequence([
            { code: 0, stdout: 'added 100 packages', stderr: 'npm warn deprecated' },
            { code: 0, stdout: 'built successfully' },
            { code: 0, stdout: '42 tests passed' },
        ]);

        const result = await gate.verify('proj-9', '/repo');

        expect(result.steps[0].stdout).toBe('added 100 packages');
        expect(result.steps[0].stderr).toBe('npm warn deprecated');
        expect(result.steps[2].stdout).toBe('42 tests passed');
    });

    // ── Agent Terminal wiring (B-497) ────────────────
    it('publishes subprocess.output events for stdout/stderr chunks', async () => {
        setupSpawnSequence([
            { code: 0, stdout: 'install line', stderr: 'install warn' },
            { code: 0, stdout: 'build line' },
            { code: 0, stdout: 'test ok' },
        ]);

        await gate.verify('proj-term', '/repo');

        const subprocessEvents = eventBus.publishedEvents.filter(
            (e) => e.channel === 'subprocess.output'
        );
        // We expect at least one stdout + one stderr chunk for the install
        // step plus stdout chunks for build and test.
        expect(subprocessEvents.length).toBeGreaterThanOrEqual(4);

        const sources = new Set(subprocessEvents.map((e) => e.event.data['source']));
        expect(sources.has('build-verification')).toBe(true);

        const projectIds = new Set(subprocessEvents.map((e) => e.event.projectId));
        expect(projectIds).toEqual(new Set(['proj-term']));

        const streams = new Set(subprocessEvents.map((e) => e.event.data['stream']));
        expect(streams.has('stdout')).toBe(true);
        expect(streams.has('stderr')).toBe(true);
    });

    it('passes cwd to spawn (npm.cmd + shell:true on Windows, npm + shell:false elsewhere)', async () => {
        setupSpawnSequence([
            { code: 0 },
            { code: 0 },
            { code: 0 },
        ]);

        await gate.verify('proj-10', '/my/repo');

        const isWindows = process.platform === 'win32';
        expect(spawnMock).toHaveBeenCalledWith(
            isWindows ? 'npm.cmd' : 'npm',
            ['install'],
            expect.objectContaining({ cwd: '/my/repo', shell: isWindows })
        );
    });

    it('strips dangerous env vars from spawned process', async () => {
        const originalEnv = process.env;
        process.env = { ...originalEnv, LD_PRELOAD: '/evil.so', PATH: '/usr/bin' };

        setupSpawnSequence([
            { code: 0 },
            { code: 0 },
            { code: 0 },
        ]);

        await gate.verify('proj-11', '/repo');

        const passedEnv = spawnMock.mock.calls[0][2].env;
        expect(passedEnv.LD_PRELOAD).toBeUndefined();
        expect(passedEnv.PATH).toBe('/usr/bin');

        process.env = originalEnv;
    });

    it('skips verification entirely for static-only projects (no package.json)', async () => {
        // No package.json on disk: the BPF-9b pre-install sanitize check and
        // resolveBuildPlan both see existsSync === false.
        vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false);

        const result = await gate.verify('proj-static', '/static-repo');

        expect(result.passed).toBe(true);
        expect(result.steps).toHaveLength(0);
        expect(result.failedStep).toBeNull();
        expect(spawnMock).not.toHaveBeenCalled();

        const passEvent = eventBus.publishedEvents.find(
            (e) => e.channel === 'build.verification.passed'
        );
        expect(passEvent!.event.data.skipped).toBe(true);
    });

    it('BPF-9b: sanitizes a stale package.json with invalid dep names before install', async () => {
        // Simulate a leftover manifest a weak model wrote with TS path aliases
        // as dependencies — npm install would fail EINVALIDPACKAGENAME otherwise.
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({
                name: 'clubhub',
                scripts: { build: 'tsc', test: 'vitest run' },
                dependencies: { react: '^18.0.0', '@/components': '*', '@/lib': '*' },
            })
        );
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }]);

        await gate.verify('proj-bpf9b', '/repo-stale');

        expect(writeSpy).toHaveBeenCalled();
        const written = String(writeSpy.mock.calls[0][1]);
        expect(written).not.toContain('@/components');
        expect(written).not.toContain('@/lib');
        expect(written).toContain('react');
        writeSpy.mockRestore();
    });

    it('records durationMs for each step', async () => {
        setupSpawnSequence([
            { code: 0 },
            { code: 0 },
            { code: 0 },
        ]);

        const result = await gate.verify('proj-12', '/repo');

        for (const step of result.steps) {
            expect(typeof step.durationMs).toBe('number');
            expect(step.durationMs).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('resolveBuildPlan', () => {
    it('skips when no package.json exists', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(false);
        const plan = resolveBuildPlan('/no-pkg');
        expect(plan.skip).toBe(true);
        expect(plan.steps).toHaveLength(0);
    });

    it('skips when package.json is unparseable', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce('{ not json');
        const plan = resolveBuildPlan('/bad-pkg');
        expect(plan.skip).toBe(true);
    });

    it('skips when no build or test scripts exist', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ name: 'x' }));
        const plan = resolveBuildPlan('/no-scripts');
        expect(plan.skip).toBe(true);
    });

    it('skips when only stub test script is present', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({
                scripts: { test: 'echo "Error: no test specified" && exit 1' },
            })
        );
        const plan = resolveBuildPlan('/stub-test');
        expect(plan.skip).toBe(true);
    });

    it('includes only install + build when test is missing', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ scripts: { build: 'tsc' } })
        );
        const plan = resolveBuildPlan('/build-only');
        expect(plan.skip).toBe(false);
        expect(plan.steps.map((s) => s.name)).toEqual(['install', 'build']);
    });

    it('includes all 3 steps when both build and test exist', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } })
        );
        const plan = resolveBuildPlan('/full');
        expect(plan.skip).toBe(false);
        expect(plan.steps.map((s) => s.name)).toEqual(['install', 'build', 'test']);
    });

    it('skips tsc build step when src/ has no .ts files (static-site scaffold)', () => {
        vi.mocked(fs.existsSync)
            .mockReturnValueOnce(true)   // package.json exists
            .mockReturnValueOnce(true);  // src/ exists
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run --passWithNoTests' } })
        );
        vi.mocked(fs.readdirSync).mockReturnValueOnce(
            ['README.md', 'data.json'] as unknown as ReturnType<typeof fs.readdirSync>
        );
        const plan = resolveBuildPlan('/static-site');
        expect(plan.skip).toBe(false);
        expect(plan.steps.map((s) => s.name)).toEqual(['install', 'test']);
    });

    it('skips entirely when tsc is only script and no .ts sources', () => {
        vi.mocked(fs.existsSync)
            .mockReturnValueOnce(true)   // package.json exists
            .mockReturnValueOnce(false); // src/ does NOT exist
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ scripts: { build: 'tsc' } })
        );
        const plan = resolveBuildPlan('/pure-static');
        expect(plan.skip).toBe(true);
    });

    it('keeps non-tsc build script even without .ts sources', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ scripts: { build: 'webpack --mode production' } })
        );
        const plan = resolveBuildPlan('/webpack-proj');
        expect(plan.skip).toBe(false);
        expect(plan.steps.map((s) => s.name)).toEqual(['install', 'build']);
    });

    // 2026-06 regression: a Next.js App Router project (build = `next build`)
    // must NEVER be skipped — the live failure was a narration `layout.tsx`
    // that only a real build would catch. The tsc-skip heuristic must not
    // swallow a `next build` project.
    it('does NOT skip a Next.js App Router project (build = next build)', () => {
        vi.mocked(fs.existsSync).mockReturnValueOnce(true);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ scripts: { build: 'next build', test: 'vitest run' } })
        );
        const plan = resolveBuildPlan('/nextjs-app');
        expect(plan.skip).toBe(false);
        expect(plan.steps.map((s) => s.name)).toContain('build');
    });
});

// ── BPF-11b — install-resilience (E404 recovery) ─────

describe('parseUnresolvablePackages()', () => {
    const E404 = [
        'npm error code E404',
        'npm error 404 Not Found - GET https://registry.npmjs.org/@neondatabase%2fneon - Not found',
        'npm error 404',
        "npm error 404  The requested resource '@neondatabase/neon@*' could not be found or you do not have permission to access it.",
    ].join('\n');

    it('extracts the package name from both the URL and resource forms', () => {
        expect(parseUnresolvablePackages(E404)).toEqual(['@neondatabase/neon']);
    });

    it('url-decodes the scoped slash', () => {
        const s = 'npm error 404 Not Found - GET https://registry.npmjs.org/@stripe%2fstripe-node - Not found';
        expect(parseUnresolvablePackages(s)).toContain('@stripe/stripe-node');
    });

    it('returns [] when there is no E404 marker', () => {
        expect(parseUnresolvablePackages('npm error ETIMEDOUT')).toEqual([]);
        expect(parseUnresolvablePackages('')).toEqual([]);
    });
});

describe('pruneUnresolvablePackages()', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ name: 'test-project', scripts: { build: 'tsc', test: 'vitest run' } })
        );
    });

    const STDERR =
        "npm error code E404\nnpm error 404  The requested resource '@neondatabase/neon@*' could not be found or you do not have permission to access it.";

    it('removes the E404 package from package.json and rewrites it', () => {
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({
                name: 'app',
                dependencies: {
                    '@neondatabase/serverless': '^0.10.0',
                    '@neondatabase/neon': '*',
                    react: '^19.0.0',
                },
            })
        );

        const removed = pruneUnresolvablePackages('/repo', STDERR);

        expect(removed).toEqual(['@neondatabase/neon']);
        const written = String(writeSpy.mock.calls[0][1]);
        expect(written).not.toContain('@neondatabase/neon"');
        expect(written).toContain('@neondatabase/serverless');
        expect(written).toContain('react');
    });

    it('also prunes from devDependencies', () => {
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ name: 'app', devDependencies: { '@neondatabase/neon': '*', vitest: '^2.0.0' } })
        );

        const removed = pruneUnresolvablePackages('/repo', STDERR);

        expect(removed).toEqual(['@neondatabase/neon']);
        expect(String(writeSpy.mock.calls[0][1])).toContain('vitest');
    });

    it('does nothing (no write) when the E404 package is not in the manifest', () => {
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
        vi.mocked(fs.readFileSync).mockReturnValueOnce(
            JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0' } })
        );

        const removed = pruneUnresolvablePackages('/repo', STDERR);

        expect(removed).toEqual([]);
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it('returns [] when stderr has no E404', () => {
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
        expect(pruneUnresolvablePackages('/repo', 'npm error ETIMEDOUT')).toEqual([]);
        expect(writeSpy).not.toHaveBeenCalled();
    });
});
