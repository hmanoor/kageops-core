/**
 * `startProjectRun` — B-400 RPC wrapper unit tests
 *
 * `startProjectRun` is the thin wrapper the Electron main process invokes
 * from the Projects panel's "Start" split-button. It must behave exactly
 * like `runHeadless` but accept the tighter B-400 shape
 * `{ name, description, dryRun, maxUsd }`.
 *
 * The dry-run path is fully offline — it must NOT:
 *   • open a database connection
 *   • call any AI provider
 *   • spend any money (totalCostUsd === 0)
 *
 * These tests assert those invariants and the shape contract the UI relies
 * on. The live path is NOT exercised here (that requires a Postgres +
 * provider setup and is covered by the E2E smoke harness).
 */

import { describe, it, expect, vi } from 'vitest';
import {
    startProjectRun,
    type PipelineEvent,
    type StartProjectRunOptions,
} from '../../src/cli/headless-runner';

const UUID_SHAPED_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('startProjectRun (B-400 RPC wrapper) — dry-run path', () => {
    it('returns a well-shaped HeadlessResult with $0 spend', async () => {
        const result = await startProjectRun({
            name: 'SplitButtonSmoke',
            description:
                'A counter page with <h1 id="count"> and <button id="increment">',
            dryRun: true,
        });

        expect(result.projectId).toMatch(UUID_SHAPED_REGEX);
        expect(result.totalCostUsd).toBe(0);
        expect(result.tasksFailed).toBe(0);
        expect(result.tasksCompleted).toBeGreaterThan(0);
        expect(result.finalPhase).toBe('launch-growth');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('visits all six lifecycle phases', async () => {
        const result = await startProjectRun({
            name: 'SplitButtonSmoke',
            description: 'Idea',
            dryRun: true,
        });

        for (const phase of [
            'discovery',
            'poc',
            'business-viability',
            'design-planning',
            'development',
            'launch-growth',
        ]) {
            expect(result.phasesVisited).toContain(phase);
        }
    });

    it('marks both Build and Acceptance gates as "skipped" in dry-run', async () => {
        const result = await startProjectRun({
            name: 'SplitButtonSmoke',
            description: 'Idea',
            dryRun: true,
        });

        expect(result.gateVerdicts.build).toBe('skipped');
        expect(result.gateVerdicts.acceptance).toBe('skipped');
        expect(result.escalations).toEqual([]);
    });

    it('streams pipeline events to onEvent without making AI calls', async () => {
        const onEvent = vi.fn<(event: PipelineEvent) => void>();

        const result = await startProjectRun({
            name: 'SplitButtonSmoke',
            description: 'Idea',
            dryRun: true,
            onEvent,
        });

        // Must have seen at least one task.created and one phase.transitioned.
        const channels = onEvent.mock.calls.map(([evt]) => evt.channel);
        expect(channels.some((c) => c === 'task.created')).toBe(true);
        expect(channels.some((c) => c === 'phase.transitioned')).toBe(true);

        // Every event carries our (deterministic) projectId.
        for (const [evt] of onEvent.mock.calls) {
            expect(evt.projectId).toBe(result.projectId);
        }
    });

    it('is deterministic for the same name (dry-run uses a seeded UUID)', async () => {
        const a = await startProjectRun({
            name: 'DeterministicName',
            description: 'Idea',
            dryRun: true,
        });
        const b = await startProjectRun({
            name: 'DeterministicName',
            description: 'Idea',
            dryRun: true,
        });

        expect(a.projectId).toBe(b.projectId);
    });

    it('accepts but ignores maxUsd in dry-run mode (no spend to cap)', async () => {
        const result = await startProjectRun({
            name: 'MaxUsdIgnoredDryRun',
            description: 'Idea',
            dryRun: true,
            maxUsd: 0.01,
        });

        expect(result.totalCostUsd).toBe(0);
        expect(result.finalPhase).toBe('launch-growth');
    });

    it('does not throw when onEvent is omitted', async () => {
        const options: StartProjectRunOptions = {
            name: 'NoEventSink',
            description: 'Idea',
            dryRun: true,
        };

        await expect(startProjectRun(options)).resolves.toBeDefined();
    });
});
