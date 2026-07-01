/**
 * BuildVerificationGate "verification teeth" (PR-2):
 *   - G5 module-load-init + G6 migration checks BLOCK by default (failedStep
 *     'static-check') and are dial-able to warn/off via KAGEOPS_GATE_*.
 *   - The generated Playwright e2e suite runs as an opt-in `e2e` step.
 *
 * Uses real temp dirs (the source scans walk the filesystem) with spawn,
 * the env materialiser, and the logger mocked for hermetic isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── Mocks ───────────────────────────────────────────

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

vi.mock('child_process', () => ({ spawn: spawnMock }));

vi.mock('../../src/orchestrator/materialize-deployment-env', () => ({
    materializeDeploymentEnv: vi.fn(async () => ({ status: 'skipped', varCount: 0, reason: 'test' })),
}));

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
    }),
}));

// db persistence is best-effort; stub it so no real connection is attempted.
vi.mock('../../src/db/client', () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

import {
    BuildVerificationGate,
    resolveE2eScript,
} from '../../src/orchestrator/build-verification-gate';
import { GATE_ENV } from '../../src/orchestrator/gate-modes';
import type { MockEventBus } from '../helpers/mock-event-bus';

function setupSpawnSequence(results: Array<{ code: number; stdout?: string; stderr?: string }>): void {
    let i = 0;
    spawnMock.mockImplementation(() => {
        const child = createMockChild();
        const r = results[i] ?? { code: 1, stderr: 'unexpected call' };
        i++;
        process.nextTick(() => {
            if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
            if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
            child.emit('close', r.code);
        });
        return child;
    });
}

function gateFor(eventBus: MockEventBus): BuildVerificationGate {
    return new BuildVerificationGate(eventBus as unknown as import('../../src/orchestrator/event-bus').EventBus);
}

describe('BuildVerificationGate — static deploy-readiness (G5/G6)', () => {
    let dir: string;
    const prevModule = process.env[GATE_ENV.moduleInit];
    const prevMigration = process.env[GATE_ENV.migration];
    const prevAutofix = process.env.KAGEOPS_AUTOFIX_MODULE_INIT;

    beforeEach(() => {
        spawnMock.mockReset();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-teeth-'));
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'app', scripts: { build: 'next build', test: 'vitest run' } }),
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        const restore = (k: string, v: string | undefined): void => {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        };
        restore(GATE_ENV.moduleInit, prevModule);
        restore(GATE_ENV.migration, prevMigration);
        restore('KAGEOPS_AUTOFIX_MODULE_INIT', prevAutofix);
    });

    function writeModuleLoadInit(): void {
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'stripe.ts'),
            `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\n`,
        );
    }

    it('BLOCKS on a module-load-time SDK init when autofix is OFF (failedStep static-check, no npm run)', async () => {
        delete process.env[GATE_ENV.moduleInit];
        // Pin the teeth proof to autofix-disabled — with BPF-27 autofix ON
        // (the default) this same shape is auto-deferred (next test).
        process.env.KAGEOPS_AUTOFIX_MODULE_INIT = '0';
        writeModuleLoadInit();
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-g5', dir);

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('static-check');
        // Short-circuits BEFORE the npm plan — nothing is spawned.
        expect(spawnMock).not.toHaveBeenCalled();
        const failEvent = eventBus.publishedEvents.find((e) => e.channel === 'build.verification.failed');
        expect(failEvent?.event.data.failedStep).toBe('static-check');
        expect(String(failEvent?.event.data.stderr)).toContain('module-load');
    });

    it('BPF-27: auto-DEFERS a module-load init by default — rewrites the file and proceeds to the npm plan', async () => {
        delete process.env[GATE_ENV.moduleInit];
        delete process.env[GATE_ENV.migration];
        delete process.env.KAGEOPS_AUTOFIX_MODULE_INIT; // default ON
        writeModuleLoadInit();
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }]);
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-g5fix', dir);

        // No static-check block — the eager init was rewritten lazy first.
        expect(result.passed).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(3); // install, build, test ran
        const failEvent = eventBus.publishedEvents.find((e) => e.channel === 'build.verification.failed');
        expect(failEvent).toBeUndefined();
        // The file on disk was actually deferred to the lazy-Proxy shape.
        const rewritten = fs.readFileSync(path.join(dir, 'lib', 'stripe.ts'), 'utf-8');
        expect(rewritten).toContain('new Proxy(');
        expect(rewritten).toContain('export const stripe:');
    });

    it('warn mode does NOT block — it warns and proceeds to the npm plan', async () => {
        process.env[GATE_ENV.moduleInit] = 'warn';
        delete process.env[GATE_ENV.migration];
        writeModuleLoadInit();
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }]);
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-g5w', dir);

        expect(result.passed).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(3); // install, build, test
        const warnEvent = eventBus.publishedEvents.find(
            (e) => e.channel === 'build.verification.warning'
                && e.event.data['kind'] === 'module-load-init',
        );
        expect(warnEvent).toBeDefined();
    });

    it('off mode skips the scan entirely (clean repo builds green)', async () => {
        process.env[GATE_ENV.moduleInit] = 'off';
        delete process.env[GATE_ENV.migration];
        writeModuleLoadInit();
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }]);
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-g5off', dir);

        expect(result.passed).toBe(true);
        const warnEvent = eventBus.publishedEvents.find(
            (e) => e.channel === 'build.verification.warning'
                && e.event.data['kind'] === 'module-load-init',
        );
        expect(warnEvent).toBeUndefined();
    });

    it('BLOCKS on a migration that fails a fresh apply (G6)', async () => {
        delete process.env[GATE_ENV.migration];
        delete process.env[GATE_ENV.moduleInit];
        fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
        // References an enum that is never declared — fails a fresh apply.
        fs.writeFileSync(
            path.join(dir, 'migrations', '0000_init.sql'),
            `CREATE TABLE refunds (id serial primary key, status refund_status not null);`,
        );
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-g6', dir);

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('static-check');
        const failEvent = eventBus.publishedEvents.find((e) => e.channel === 'build.verification.failed');
        expect(String(failEvent?.event.data.stderr).toLowerCase()).toContain('migration');
    });
});

describe('BuildVerificationGate — Playwright e2e step', () => {
    let dir: string;
    const prevE2e = process.env[GATE_ENV.e2e];

    beforeEach(() => {
        spawnMock.mockReset();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-e2e-'));
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                name: 'app',
                scripts: { build: 'next build', test: 'vitest run', 'test:e2e': 'playwright test' },
            }),
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (prevE2e === undefined) delete process.env[GATE_ENV.e2e];
        else process.env[GATE_ENV.e2e] = prevE2e;
    });

    it('does NOT run e2e when the gate is off (default)', async () => {
        delete process.env[GATE_ENV.e2e];
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }]);
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-e2e-off', dir);
        expect(result.passed).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(3); // no e2e step
    });

    it('runs e2e and BLOCKS when it fails in block mode', async () => {
        process.env[GATE_ENV.e2e] = 'block';
        // install, build, test pass; e2e fails.
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }, { code: 1, stderr: '1 e2e test failed' }]);
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-e2e-block', dir);

        expect(result.passed).toBe(false);
        expect(result.failedStep).toBe('e2e');
        expect(spawnMock).toHaveBeenCalledTimes(4);
        // the e2e step ran `npm run test:e2e`
        expect(spawnMock.mock.calls[3]![1]).toEqual(['run', 'test:e2e']);
    });

    it('warn mode runs e2e but does not block on failure', async () => {
        process.env[GATE_ENV.e2e] = 'warn';
        setupSpawnSequence([{ code: 0 }, { code: 0 }, { code: 0 }, { code: 1, stderr: 'flaky' }]);
        const eventBus = createMockEventBus();
        const result = await gateFor(eventBus).verify('proj-e2e-warn', dir);

        expect(result.passed).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(4);
        const warnEvent = eventBus.publishedEvents.find(
            (e) => e.channel === 'build.verification.warning' && e.event.data['kind'] === 'e2e',
        );
        expect(warnEvent).toBeDefined();
    });
});

describe('resolveE2eScript()', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-e2escript-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('prefers test:e2e', () => {
        fs.writeFileSync(path.join(dir, 'package.json'),
            JSON.stringify({ scripts: { 'test:e2e': 'playwright test', e2e: 'x' } }));
        expect(resolveE2eScript(dir)).toBe('test:e2e');
    });

    it('returns null when no e2e script exists', () => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
        expect(resolveE2eScript(dir)).toBeNull();
    });

    it('returns null when there is no package.json', () => {
        expect(resolveE2eScript(dir)).toBeNull();
    });
});
