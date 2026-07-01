/**
 * KageOps Headless Pipeline — E2E Smoke Harness (B-023)
 *
 * Exercises the headless runner's programmatic API end-to-end in dry-run
 * mode. Asserts pipeline shape (Sensei-style decomposition, six-phase
 * traversal, gate verdicts, $0 spend) without firing any real AI calls.
 *
 * Postgres is NOT required for the dry-run path. The infrastructure probe
 * below is kept so that when a DATABASE_URL is available we can extend
 * this suite with a live-pipeline assertion later without changing shape.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    runHeadless,
    type HeadlessResult,
    type PipelineEvent,
} from '../../src/cli/headless-runner';
import { testConnection, closePool } from '../../src/db/client';
import { createLogger } from '../../src/shared/logger';

const log = createLogger('E2ESmoke');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COUNTER_SPEC =
    'Build a counter page with <h1 id="count"> and <button id="increment">';

const UUID_SHAPED_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── DB reachability probe ────────────────────────────────────────────────────
// The dry-run suite does NOT need Postgres, but we probe it anyway so future
// live-pipeline variants can be gated on `.skipIf(!dbReachable)`.

let dbReachable = false;

beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl === '') {
        log.info('DATABASE_URL not set — live-pipeline variants will skip.');
        return;
    }
    try {
        dbReachable = await testConnection({
            databaseUrl,
            maxRetries: 1,
            retryDelayMs: 0,
        });
    } catch (err) {
        dbReachable = false;
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'DB probe failed — live-pipeline variants will skip.'
        );
    } finally {
        // The probe opened a pool — close it so it does not leak across tests.
        try {
            await closePool();
        } catch {
            /* best effort */
        }
    }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface SmokeRunRecord {
    readonly result: HeadlessResult;
    readonly events: readonly PipelineEvent[];
    readonly wallClockMs: number;
}

async function runSmokeDryRun(): Promise<SmokeRunRecord> {
    const events: PipelineEvent[] = [];
    const started = Date.now();
    const result = await runHeadless({
        name: 'E2ESmokeCounter',
        description: COUNTER_SPEC,
        dryRun: true,
        budgetCapUsd: 0.01,
        onEvent: (event) => {
            events.push(event);
        },
    });
    return {
        result,
        events,
        wallClockMs: Date.now() - started,
    };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.concurrent('E2E — Headless Pipeline Smoke (dry-run)', () => {
    it.concurrent('infrastructure reachable check (informational)', () => {
        // Informational: DB is not required for dry-run. This test always
        // passes and reports the probe outcome for visibility in CI logs.
        log.info({ dbReachable }, 'DB reachability probe result');
        expect(typeof dbReachable).toBe('boolean');
    });

    it.concurrent('returns a well-shaped HeadlessResult', async () => {
        const { result } = await runSmokeDryRun();

        expect(result.projectId).toMatch(UUID_SHAPED_REGEX);
        expect(result.totalCostUsd).toBe(0);
        expect(result.tasksFailed).toBe(0);
        expect(result.tasksCompleted).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.durationMs).toBeLessThan(30_000);
        expect(result.finalPhase).toBe('launch-growth');
    });

    it.concurrent('traverses all six lifecycle phases', async () => {
        const { result } = await runSmokeDryRun();

        expect(result.phasesVisited).toContain('discovery');
        expect(result.phasesVisited).toContain('poc');
        expect(result.phasesVisited).toContain('business-viability');
        expect(result.phasesVisited).toContain('design-planning');
        expect(result.phasesVisited).toContain('development');
        expect(result.phasesVisited).toContain('launch-growth');
        expect(result.phasesVisited.length).toBe(6);
    });

    it.concurrent('records gate verdicts (skipped in dry-run)', async () => {
        const { result } = await runSmokeDryRun();

        expect(result.gateVerdicts.build).toBe('skipped');
        expect(result.gateVerdicts.acceptance).toBe('skipped');
    });

    it.concurrent('emits at least one task.created event', async () => {
        const { events } = await runSmokeDryRun();

        const taskCreated = events.filter((e) => e.channel === 'task.created');
        expect(taskCreated.length).toBeGreaterThan(0);

        // Each event carries the dry-run project id + a timestamp.
        for (const event of taskCreated) {
            expect(event.projectId.length).toBeGreaterThan(0);
            expect(typeof event.timestamp).toBe('string');
        }
    });

    it.concurrent('emits phase.transitioned events for every phase', async () => {
        const { events } = await runSmokeDryRun();

        const transitions = events.filter((e) => e.channel === 'phase.transitioned');
        expect(transitions.length).toBe(6);
    });

    it.concurrent('produces zero blocking escalations in dry-run', async () => {
        const { result } = await runSmokeDryRun();
        expect(result.escalations).toEqual([]);
    });

    it.concurrent('completes the full dry-run in under 30 seconds', async () => {
        const { wallClockMs, result } = await runSmokeDryRun();

        // Dry-run is offline and should finish in milliseconds — the 30s
        // ceiling is a generous upper bound consistent with the live-pipeline
        // smoke budget and the task description.
        expect(wallClockMs).toBeLessThan(30_000);
        expect(result.durationMs).toBeLessThan(30_000);
    });

    it.concurrent('is deterministic for the same project name', async () => {
        // Dry-run project IDs are derived from the name so repeated runs
        // produce the same id — this protects against accidentally
        // introducing non-determinism in the plan output.
        const first = await runSmokeDryRun();
        const second = await runSmokeDryRun();

        expect(second.result.projectId).toBe(first.result.projectId);
        expect(second.result.phasesVisited).toEqual(first.result.phasesVisited);
    });
});

// ── Live-pipeline placeholder ────────────────────────────────────────────────
//
// A live-pipeline smoke test (real Sensei boot, stubbed AI, actual gates)
// is intentionally deferred. When added, it will live here and gate on
// `.skipIf(!dbReachable)` using the probe from `beforeAll` above.

describe('E2E — Headless Pipeline Smoke (live)', () => {
    it.skipIf(!dbReachable)('reserved for live-pipeline run', () => {
        // Placeholder assertion kept minimal — present only to make the
        // skip status visible in CI output when DATABASE_URL is set but the
        // live variant has not yet been authored.
        expect(dbReachable).toBe(true);
    });
});
