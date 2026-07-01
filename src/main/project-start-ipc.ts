/**
 * KageOps Project Start IPC (B-400)
 *
 * Registers the main-process handlers for the Projects panel's "Start"
 * split-button — Dry Run and Live Run. Isolated from `main.ts` to keep
 * that entry point manageable under the CLAUDE.md 400-LOC budget.
 *
 *  • Dry Run  → `startProjectRun({ dryRun: true })` (offline, zero AI).
 *  • Live Run → existing orchestrator's `sensei.startProject()`
 *               (does NOT double-bootstrap a parallel stack).
 *
 * Streams progress back to the Command Center renderer on
 * `project:run-progress` so the UI can show lifecycle feedback.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { OrchestratorHandles } from './orchestrator-bootstrap';
import {
    startProjectRun,
    type HeadlessResult,
    type PipelineEvent,
} from '../cli/headless-runner';
import { createLogger } from '../shared/logger';

const log = createLogger('ProjectStartIPC');

// ── Types ────────────────────────────────────────────

export interface DryRunArgs {
    readonly name: string;
    readonly description: string;
}

export interface LiveRunArgs {
    readonly name: string;
    readonly description: string;
    readonly maxUsd?: number;
    readonly preset?: string;
    readonly trustLevel?: 'low' | 'medium' | 'high';
}

export interface DryRunResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly result?: HeadlessResult;
}

export interface LiveRunResponse {
    readonly success: boolean;
    readonly error?: string;
    readonly projectId?: string;
    readonly maxUsd?: number;
}

export interface ProjectStartDeps {
    /** Resolves to the currently booted orchestrator, or null if absent. */
    readonly getOrchestrator: () => OrchestratorHandles | null;
    /** Resolves to the Command Center window so events can be pushed. */
    readonly getCommandCenterWindow: () => BrowserWindow | null;
}

// ── Helpers ──────────────────────────────────────────

const DEFAULT_MAX_USD = 0.25;

function coerceName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

function coerceDescription(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return raw.trim();
}

function coerceMaxUsd(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_MAX_USD;
    }
    return raw;
}

function coerceTrust(raw: unknown): 'low' | 'medium' | 'high' {
    if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
    return 'low';
}

function pushProgress(
    deps: ProjectStartDeps,
    payload: Readonly<{
        readonly kind: 'event' | 'complete' | 'error' | 'started';
        readonly mode: 'dry-run' | 'live';
        readonly projectId?: string;
        readonly event?: PipelineEvent;
        readonly result?: HeadlessResult;
        readonly error?: string;
    }>,
): void {
    const win = deps.getCommandCenterWindow();
    if (win === null || win.isDestroyed()) return;
    try {
        win.webContents.send(IPC.PROJECT_RUN_PROGRESS, payload);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'Failed to push run-progress event');
    }
}

// ── Registration ─────────────────────────────────────

/**
 * Register both Dry Run and Live Run IPC handlers. Idempotent — safe to
 * call once at startup from `main.ts`.
 */
export function registerProjectStartHandlers(deps: ProjectStartDeps): void {
    ipcMain.handle(IPC.PROJECT_START_DRY_RUN, async (_event, rawArgs: unknown) => {
        return handleDryRun(deps, rawArgs);
    });

    ipcMain.handle(IPC.PROJECT_START_LIVE_RUN, async (_event, rawArgs: unknown) => {
        return handleLiveRun(deps, rawArgs);
    });
}

// ── Handlers (exported for testing) ──────────────────

export async function handleDryRun(
    deps: ProjectStartDeps,
    rawArgs: unknown,
): Promise<DryRunResponse> {
    const args = (typeof rawArgs === 'object' && rawArgs !== null)
        ? rawArgs as Record<string, unknown>
        : {};
    const name = coerceName(args['name']);
    if (name === null) {
        return { success: false, error: 'Project name is required.' };
    }
    const description = coerceDescription(args['description']);

    log.info({ name }, 'Starting dry run');
    pushProgress(deps, { kind: 'started', mode: 'dry-run' });

    try {
        const result = await startProjectRun({
            name,
            description,
            dryRun: true,
            onEvent: (event) => {
                pushProgress(deps, {
                    kind: 'event',
                    mode: 'dry-run',
                    projectId: event.projectId,
                    event,
                });
            },
        });
        pushProgress(deps, { kind: 'complete', mode: 'dry-run', result });
        return { success: true, result };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, name }, 'Dry run failed');
        pushProgress(deps, { kind: 'error', mode: 'dry-run', error: msg });
        return { success: false, error: msg };
    }
}

export async function handleLiveRun(
    deps: ProjectStartDeps,
    rawArgs: unknown,
): Promise<LiveRunResponse> {
    const args = (typeof rawArgs === 'object' && rawArgs !== null)
        ? rawArgs as Record<string, unknown>
        : {};
    const name = coerceName(args['name']);
    if (name === null) {
        return { success: false, error: 'Project name is required.' };
    }
    const description = coerceDescription(args['description']);
    const maxUsd = coerceMaxUsd(args['maxUsd']);
    const trustLevel = coerceTrust(args['trustLevel']);

    const orchestrator = deps.getOrchestrator();
    if (orchestrator === null) {
        return {
            success: false,
            error: 'Orchestrator is not running — cannot start a live run.',
        };
    }

    // Apply the budget cap via env before starting. The budget-kill watcher
    // inside Sensei reads KAGEOPS_MAX_RUN_USD at the project's first poll
    // tick, so setting it here takes effect for this run.
    process.env['KAGEOPS_MAX_RUN_USD'] = maxUsd.toString();

    const preset = args['preset'];
    if (typeof preset === 'string' && preset !== '') {
        process.env['KAGEOPS_PRESET'] = preset;
    }

    log.info({ name, maxUsd, trustLevel }, 'Starting live run');
    pushProgress(deps, { kind: 'started', mode: 'live' });

    try {
        const projectId = await orchestrator.sensei.startProject(
            name,
            description,
            trustLevel,
        );
        orchestrator.sensei.setFocusProject(projectId);
        pushProgress(deps, {
            kind: 'complete',
            mode: 'live',
            projectId,
        });
        return { success: true, projectId, maxUsd };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, name }, 'Live run failed');
        pushProgress(deps, { kind: 'error', mode: 'live', error: msg });
        return { success: false, error: msg };
    }
}
