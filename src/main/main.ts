import { app, ipcMain, Notification, shell } from 'electron';
import * as path from 'path';
import * as os from 'os';

// Required for transparent windows on some Windows systems where GPU compositing fails
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('enable-transparent-visuals');
import { createCommandCenterWindow, getCommandCenterWindow } from './command-center-window';
import { loadCommercialExtensions, registerCommercialPreReadySchemes } from './commercial-loader';
import { registerAppScheme, registerAppProtocol } from './app-protocol';
import { registerDeployKeyHandlers } from './deploy-keys-handlers';
import { applyAutoHosting, isHostingExplicitlySet } from '../shared/hosting-mode';
import { noopCommercialExtensions } from './commercial-extensions';
import type { AuthSessionLike, CommercialExtensions } from './commercial-extensions';
import { createTray, setSignOutHandler } from './tray-menu';
import { loadSettings, getSettings, updateSettings } from './settings-store';
import { IPC } from '../shared/ipc-channels';
import * as shellManager from './shell-manager';
import {
    bootstrapOrchestrator,
    shutdownOrchestrator,
    getLastBootstrapError,
    OrchestratorHandles,
} from './orchestrator-bootstrap';
import { registerProjectStartHandlers } from './project-start-ipc';
import { registerProjectLifecycleHandlers } from './project-lifecycle-ipc';
import {
  registerProjectGitHubPushHandler,
  ensureCommitted as githubPushEnsureCommitted,
  getCurrentBranch as githubPushGetCurrentBranch,
} from './project-github-push';
import {
    registerArtifactBrowserHandlers,
    registerArtifactSchemesAsPrivileged,
} from './artifact-browser-ipc';
import { createHeadlessServer, broadcastEvent } from './headless-server';
import { getApiKeyStatus, setApiKey, deleteSecret } from './secret-store';
import { getPool } from '../db/client';
import type { AiProvider } from '../agents/ai-adapter';
import { createLogger } from '../shared/logger';
import {
    ApproveGateArgsSchema,
    DenyGateArgsSchema,
    StartProjectArgsSchema,
    SenseiMessageArgsSchema,
    SetApiKeyArgsSchema,
    DeleteApiKeyArgsSchema,
    GetOperationalCostsArgsSchema,
    GetGraphStatusArgsSchema,
    SetAgentModelArgsSchema,
    TestAgentModelArgsSchema,
    SaveDeploymentArgsSchema,
    DeleteDeploymentArgsSchema,
    DbQueryArgsSchema,
    LogErrorArgsSchema,
} from '../shared/ipc-schemas';
import {
    loadAppAgentConfig,
    setAgentModelConfig,
    listPresets,
    getActivePreset,
    setActivePreset,
    createPreset,
    deletePreset,
    ensurePresetFiles,
    PresetName,
    PRESET_NAMES,
    listDesignProviders,
    getActiveDesignProvider,
    setActiveDesignProvider,
    DESIGN_PROVIDER_IDS,
    type DesignProviderId,
} from './app-config-store';
import {
    listPromptOptimizations,
    getPromptOptimization,
    markOptimizationAccepted,
    markOptimizationRolledBack,
} from '../learning/optimization-record';
import { applyWinner } from '../learning/apply-winner';
import type { PromptOptimizationStatus } from '../learning/types';
import {
    startApoScheduler,
    type SchedulerHandle,
    type ApoSchedulerDeps,
    type ApoRunReport,
} from '../learning/apo-scheduler';
import { loadGoldenTasks } from '../learning/golden-tasks';
import { sendPrompt as aiSendPrompt } from '../agents/ai-adapter';
import { SYSTEM_PROMPT as SCOUT_SYSTEM_PROMPT } from '../agents/specialists/scout';
import { SYSTEM_PROMPT as HERALD_SYSTEM_PROMPT } from '../agents/specialists/herald';
import { SYSTEM_PROMPT as PIXEL_SYSTEM_PROMPT } from '../agents/specialists/pixel';
import { OnboardingStore } from '../onboarding/onboarding-store';
import {
    createOnboardingMachine,
    OnboardingInput,
    OnboardingMachine,
    ProviderConfig,
    TrustLevel,
} from '../onboarding/onboarding-state';

const log = createLogger('Main');

// EPIPE swallower (v0.1.37) — when the dev shell that launched the app
// dies before Electron does (Playwright launch crash, dev terminal
// closed mid-session, parent process killed), every subsequent
// console.log inside the main process tries to write to a now-closed
// stdout pipe and throws EPIPE. Electron's default uncaughtException
// handler then pops a JS-error dialog ("EPIPE: broken pipe, write")
// over the Command Center. PGlite's internal logging is verbose and
// re-triggers the dialog on every tick, making the app unusable.
//
// We only swallow EPIPE on the standard streams. Any other uncaught
// exception still goes to the logger + Electron's default crash path
// — silencing those would hide real bugs.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
        // Best-effort: don't even log it (the logger writes to the
        // same dead pipe). Drop on the floor.
        return;
    }
    try { log.error({ err: err.message, stack: err.stack }, '[Main] uncaughtException'); }
    catch { /* logger may itself be broken on the same dead pipe */ }
    // Re-throw asynchronously so Electron's default handler fires
    // for everything that isn't a benign pipe close.
    setImmediate(() => { throw err; });
});

// Same treatment for unhandled promise rejections that surface as EPIPE
// (the PGlite write-stream uses promises in some code paths).
process.on('unhandledRejection', (reason: unknown) => {
    if (reason instanceof Error && (reason as NodeJS.ErrnoException).code === 'EPIPE') {
        return;
    }
    try {
        log.error({ reason: reason instanceof Error ? reason.message : String(reason) },
                  '[Main] unhandledRejection');
    } catch { /* logger may be broken */ }
});

// Register privileged custom protocol schemes BEFORE `app.whenReady`.
// Electron refuses to register privileged schemes once the app is ready,
// so this must run at module load time. The `kageops-artifact://` scheme
// backs the sandboxed HTML iframe preview in the Artifact Browser (B-422).
registerArtifactSchemesAsPrivileged();

// CORE — register the kageops:// scheme as privileged in EVERY build. The
// splash/welcome windows load `kageops://…`, so the open build must own this
// scheme in-process; otherwise loadURL falls through to the OS-registered
// handler and spawns a second, unrelated app. MUST run BEFORE app.whenReady.
registerAppScheme();

// Phase 3 — Auth (commercial; no-op in the open build): registers the device-
// flow OS protocol handler + takes the single-instance lock so a second launch
// via kageops:// forwards the URL to this process instead of spawning a new app.
registerCommercialPreReadySchemes();

// ── APO Scheduler singleton ──────────────────────────

let apoScheduler: SchedulerHandle | null = null;

// Pillar 2.4 / PR-I — Cloud Burst idle reaper stop handle. Set when the
// reaper starts (alongside the cloud-burst handlers); cleared on quit.
let stopBurstIdleReaper: (() => void) | null = null;

/**
 * Start the nightly APO loop if `KAGEOPS_APO_ENABLED=1`. Off by default —
 * APO makes live LLM calls and must be opted into explicitly per cost
 * guardrails (CLAUDE.md).
 *
 * Model selection: `KAGEOPS_APO_EVAL_MODEL` (default `openrouter/openai/gpt-4o-mini`).
 * A missing agent in `golden-tasks.json` is treated as "skip" rather than
 * "error" so a partial corpus never aborts the whole nightly run.
 */
/**
 * P1-01f helper. Surface a compact per-op metadata projection for the
 * renderer's checkpoint timeline so we don't ship full payloads or
 * cached askAI responses (potentially KB-sized) across IPC for every
 * row. The shape varies by op_type per the plan doc:
 *   - askai → { model, tokensIn, tokensOut, costUsd }    (from output_json)
 *   - write → { filePath, bytes }                         (from payload_json)
 *   - exec  → { command, exitCode, durationMs }          (from payload+output)
 *   - other → {}
 */
function pickCheckpointMeta(
    opType: 'askai' | 'write' | 'exec' | 'other',
    payloadJson: unknown,
    outputJson: unknown,
): Record<string, unknown> {
    const payload = (payloadJson ?? {}) as Record<string, unknown>;
    const output = (outputJson ?? {}) as Record<string, unknown>;
    switch (opType) {
        case 'askai':
            return {
                model: output['model'] ?? payload['model'] ?? null,
                tokensIn: output['tokensIn'] ?? null,
                tokensOut: output['tokensOut'] ?? null,
                costUsd: output['costUsd'] ?? null,
            };
        case 'write':
            return {
                filePath: payload['filePath'] ?? null,
                bytes: payload['bytes'] ?? output['bytesWritten'] ?? null,
            };
        case 'exec':
            return {
                command: payload['command'] ?? null,
                args: Array.isArray(payload['args']) ? (payload['args'] as unknown[]).join(' ') : null,
                exitCode: output['exitCode'] ?? null,
                durationMs: output['durationMs'] ?? null,
            };
        default:
            return {};
    }
}

function bootstrapApoScheduler(): void {
    if (process.env['KAGEOPS_APO_ENABLED'] !== '1') {
        log.info('APO scheduler disabled (set KAGEOPS_APO_ENABLED=1 to enable).');
        return;
    }

    const model = process.env['KAGEOPS_APO_EVAL_MODEL'] ?? 'openrouter/openai/gpt-4o-mini';
    const baselines: Record<string, string> = {
        scout: SCOUT_SYSTEM_PROMPT,
        herald: HERALD_SYSTEM_PROMPT,
        pixel: PIXEL_SYSTEM_PROMPT,
    };

    const deps: ApoSchedulerDeps = {
        loadBaselinePrompt: (agentName) => baselines[agentName] ?? null,
        loadGoldenTasks: (agentName) => {
            try {
                return loadGoldenTasks(agentName);
            } catch (err) {
                log.warn(
                    { agentName, err: err instanceof Error ? err.message : String(err) },
                    'APO: golden tasks unavailable for agent — skipping'
                );
                return [];
            }
        },
        sendPrompt: aiSendPrompt,
        model,
    };

    apoScheduler = startApoScheduler(deps, {
        runImmediately: false,
        onRunComplete: (report: ApoRunReport) => {
            const persisted = report.outcomes.filter((o) => o.status === 'persisted').length;
            const errors = report.outcomes.filter((o) => o.status === 'error').length;
            log.info(
                { startedAt: report.startedAt, finishedAt: report.finishedAt, persisted, errors },
                'APO: nightly run complete'
            );
        },
    });
    log.info({ model }, 'APO scheduler started.');
}

// ── Onboarding singleton ─────────────────────────────

const onboardingStore = new OnboardingStore();
let onboardingMachine: OnboardingMachine | null = null;

async function getOnboardingMachine(): Promise<OnboardingMachine> {
    if (onboardingMachine === null) {
        const seed = await onboardingStore.read();
        onboardingMachine = createOnboardingMachine(seed);
    }
    return onboardingMachine;
}

const VALID_ONBOARDING_INPUT_TYPES = new Set([
    'begin',
    'select-preset',
    'select-trust',
    'set-providers',
    'set-budget',
    'back',
]);

const VALID_TRUST_LEVELS_SET: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const VALID_PROVIDER_NAMES_SET: ReadonlySet<string> = new Set([
    'claude',
    'openrouter',
    'ollama',
    'openai',
    'gemini',
]);

// Mirrors VALID_PRESET_NAME_PATTERN in src/onboarding/onboarding-state.ts.
// Defensive check at the IPC boundary; the pure state machine validates again.
const VALID_PRESET_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_PRESET_NAME_LENGTH = 64;

function parseOnboardingInput(raw: unknown): OnboardingInput {
    if (raw === null || typeof raw !== 'object') {
        throw new Error('onboarding input must be an object');
    }
    const obj = raw as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== 'string' || !VALID_ONBOARDING_INPUT_TYPES.has(type)) {
        throw new Error(`unknown onboarding input type: ${String(type)}`);
    }
    switch (type) {
        case 'begin':
            return { type: 'begin' };
        case 'back':
            return { type: 'back' };
        case 'select-preset': {
            const preset = obj.preset;
            if (typeof preset !== 'string' || preset.length === 0) {
                throw new Error('preset must be a non-empty string');
            }
            if (preset.length > MAX_PRESET_NAME_LENGTH) {
                throw new Error(`preset name too long (max ${MAX_PRESET_NAME_LENGTH})`);
            }
            if (!VALID_PRESET_NAME_PATTERN.test(preset)) {
                throw new Error(
                    `invalid preset name '${preset}': only alphanumeric, hyphen, underscore`
                );
            }
            return { type: 'select-preset', preset };
        }
        case 'select-trust': {
            const trustLevel = obj.trustLevel;
            if (typeof trustLevel !== 'string' || !VALID_TRUST_LEVELS_SET.has(trustLevel)) {
                throw new Error(`invalid trustLevel: ${String(trustLevel)}`);
            }
            return { type: 'select-trust', trustLevel: trustLevel as TrustLevel };
        }
        case 'set-providers': {
            const providers = obj.providers;
            if (!Array.isArray(providers)) {
                throw new Error('providers must be an array');
            }
            const parsed: ProviderConfig[] = providers.map((p, i) => {
                if (p === null || typeof p !== 'object') {
                    throw new Error(`providers[${i}] must be an object`);
                }
                const entry = p as Record<string, unknown>;
                const name = entry.name;
                const apiKeyConfigured = entry.apiKeyConfigured;
                if (typeof name !== 'string' || !VALID_PROVIDER_NAMES_SET.has(name)) {
                    throw new Error(`providers[${i}].name invalid: ${String(name)}`);
                }
                if (typeof apiKeyConfigured !== 'boolean') {
                    throw new Error(`providers[${i}].apiKeyConfigured must be boolean`);
                }
                return { name: name as ProviderConfig['name'], apiKeyConfigured };
            });
            return { type: 'set-providers', providers: parsed };
        }
        case 'set-budget': {
            const budgetCapUsd = obj.budgetCapUsd;
            if (typeof budgetCapUsd !== 'number' || !Number.isFinite(budgetCapUsd)) {
                throw new Error('budgetCapUsd must be a finite number');
            }
            return { type: 'set-budget', budgetCapUsd };
        }
        default:
            // Guarded by the set check above
            throw new Error(`unreachable: ${type}`);
    }
}

function setupOnboardingIPC(): void {
    ipcMain.handle(IPC.ONBOARDING_GET_STATE, async () => {
        try {
            const machine = await getOnboardingMachine();
            return { ok: true, state: machine.getState(), complete: machine.isComplete() };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err }, 'onboarding:get-state failed');
            return { ok: false, error: msg };
        }
    });

    ipcMain.handle(IPC.ONBOARDING_ADVANCE, async (_event, input: unknown) => {
        try {
            const parsed = parseOnboardingInput(input);
            const machine = await getOnboardingMachine();
            const next = machine.advance(parsed);
            await onboardingStore.write(next);

            // CRITICAL: when the wizard picks a preset, also write it to
            // active-preset.txt and reload live agent configs. Without this,
            // agent-config.ts falls back to the default preset (Claude/Sonnet)
            // and the user's wizard choice (e.g. ollama) is silently ignored.
            if (parsed.type === 'select-preset') {
                try {
                    setActivePreset(parsed.preset);
                    orchestrator?.agentRegistry.reloadAgentConfigsFromPreset();
                } catch (presetErr) {
                    const msg = presetErr instanceof Error ? presetErr.message : String(presetErr);
                    log.warn({ err: msg, preset: parsed.preset }, 'onboarding select-preset: setActivePreset failed');
                }
            }

            return { ok: true, state: next, complete: machine.isComplete() };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'onboarding:advance rejected');
            return { ok: false, error: msg };
        }
    });

    // ── Quickflow defaults ──
    // Returns the most recent project's preset/budget/trust so the New
    // Project modal can prefill them. Falls back to the wizard's saved
    // onboarding state if there are no projects yet.
    ipcMain.handle(IPC.QUICKFLOW_GET_DEFAULTS, async () => {
        try {
            const pool = getPool();
            const res = await pool.query<{
                agent_config_preset: string | null;
                trust_level: string;
                budget_usd: string | null;
            }>(
                `SELECT agent_config_preset, trust_level, budget_usd::text
                 FROM projects
                 ORDER BY created_at DESC
                 LIMIT 1`,
                []
            );
            if (res.rows.length > 0) {
                const r = res.rows[0]!;
                const budget = r.budget_usd === null ? null : Number.parseFloat(r.budget_usd);
                return {
                    ok: true,
                    source: 'last-project' as const,
                    defaults: {
                        preset: r.agent_config_preset,
                        trustLevel: r.trust_level,
                        budgetCapUsd: Number.isFinite(budget) ? budget : null,
                    },
                };
            }
            // Fall back to wizard saved state
            const machine = await getOnboardingMachine();
            const s = machine.getState();
            return {
                ok: true,
                source: 'wizard-defaults' as const,
                defaults: {
                    preset: s.preset,
                    trustLevel: s.trustLevel,
                    budgetCapUsd: s.budgetCapUsd,
                },
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'quickflow:get-defaults failed');
            return { ok: false, error: msg };
        }
    });
}

// ── State ────────────────────────────────────────────

// Orchestrator (null if database unavailable or --no-orchestrator flag)
let orchestrator: OrchestratorHandles | null = null;

// OSS-split seam: commercial extensions registry. Assigned at whenReady from
// the commercial loader (open build → {}). Module-level so setupCommandCenterIPC
// handlers (registered before whenReady completes) can reach the cloud batch.
let commercialExtensions: CommercialExtensions = noopCommercialExtensions;

// ── Helpers ──────────────────────────────────────────

function isOptimizationStatus(v: unknown): v is PromptOptimizationStatus {
  return v === 'proposed' || v === 'accepted' || v === 'rolled_back';
}

// ── IPC Setup ────────────────────────────────────────

function setupIPC(): void {
  // Database Queries (GreenThumb v0.11 Phase 3)
  ipcMain.handle(IPC.DB_QUERY, async (_event, args: unknown): Promise<unknown> => {
    const parsed = DbQueryArgsSchema.safeParse(args);
    if (!parsed.success) {
      log.error({ errors: parsed.error.flatten() }, '[DB] Invalid query args');
      throw new Error('Invalid database query arguments');
    }

    const { sql, params } = parsed.data;

    // Reject queries with dangerous patterns (comment injection, wildcard SQL, etc.)
    if (sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
      log.error({ sql: sql.substring(0, 100) }, '[DB] Suspicious SQL pattern detected');
      throw new Error('Suspicious SQL pattern detected');
    }

    try {
      const pool = getPool();
      const result = await pool.query(sql, params);
      return { rows: result.rows };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sql: sql.substring(0, 100), error: msg }, '[DB] Query failed');
      throw new Error(`Database query failed: ${msg}`);
    }
  });

  // Error Logging from Renderer (GreenThumb v0.11 Phase 3)
  ipcMain.on(IPC.LOG_ERROR, (_event, args: unknown) => {
    const parsed = LogErrorArgsSchema.safeParse(args);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, '[LogError] Invalid args');
      return;
    }

    const { context, message, error } = parsed.data;
    log.error({ context, message, error }, '[GreenThumb Renderer]');
  });

  // Interactive Shell Manager (B-510) — child-process sessions for the
  // Command Center inline terminal. Handlers are fire-and-forget; output
  // streams back via SHELL_OUTPUT pushes from shell-manager.
  ipcMain.on(IPC.SHELL_SPAWN, (event, sessionId: unknown, shellType: unknown, cwd: unknown) => {
    if (typeof sessionId !== 'string' || typeof shellType !== 'string') {
      log.warn('[ShellManager] invalid spawn args');
      return;
    }
    if (shellType !== 'powershell' && shellType !== 'bash' && shellType !== 'cmd') {
      log.warn({ shellType }, '[ShellManager] unsupported shell type');
      return;
    }
    const result = shellManager.spawnSession({
      sessionId,
      shellType,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      webContents: event.sender,
    });
    if (!result.ok) {
      log.warn({ sessionId, error: result.error }, '[ShellManager] spawn failed');
    }
  });

  ipcMain.on(IPC.SHELL_INPUT, (_event, sessionId: unknown, line: unknown) => {
    if (typeof sessionId !== 'string' || typeof line !== 'string') return;
    shellManager.writeToSession(sessionId, line);
  });

  ipcMain.on(IPC.SHELL_KILL, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return;
    shellManager.killSession(sessionId);
  });

  ipcMain.handle('shell:open-path', async (_event, args: unknown) => {
    // Accept either a plain string (legacy) or { projectId, filePath }
    let filePath: string;
    let projectId: string | null = null;
    if (typeof args === 'string') {
      filePath = args;
    } else if (typeof args === 'object' && args !== null) {
      const a = args as Record<string, unknown>;
      if (typeof a['filePath'] !== 'string') return;
      filePath = a['filePath'];
      projectId = typeof a['projectId'] === 'string' ? a['projectId'] : null;
    } else {
      return;
    }

    // If the path looks relative and we have a projectId, resolve via repo_path
    if (projectId !== null && !path.isAbsolute(filePath)) {
      try {
        const { getOne } = await import('../db/client');
        const row = await getOne<{ repo_path: string }>(
          'SELECT repo_path FROM projects WHERE id = $1',
          [projectId],
        );
        if (row !== null && row.repo_path) {
          filePath = path.join(row.repo_path, filePath);
        }
      } catch {
        // fall through with original path
      }
    }

    await shell.openPath(filePath);
  });
}

function setupCommandCenterIPC(): void {
  // ── Projects ──────────────────────────────────
  ipcMain.handle('command-center:get-projects', async () => {
    try {
      if (orchestrator !== null) {
        return await orchestrator.sensei.getAllProjectsStatus();
      }
      // Fallback: direct DB query
      const { getMany } = await import('../db/client');
      return await getMany(
        'SELECT id, name, phase, status, trust_level FROM projects WHERE status != $1 ORDER BY created_at DESC',
        ['completed']
      );
    } catch {
      return [];
    }
  });

  // ── iteration:get-history (P1-05b) ───────────
  // Returns the full iteration history for a project (oldest first).
  // Iteration 0 = original build; 1+ = reopen cycles. Used by the
  // project card's iteration history side-panel. Read-only; empty
  // array on legacy pre-026 data dirs (which is harmless — UI just
  // hides the panel when the array is empty).
  ipcMain.handle('iteration:get-history', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string' || projectId === '') return [];
    try {
      const { iterationRepository } = await import('../db/iteration-repo');
      const rows = await iterationRepository.listForProject(projectId);
      return rows.map((r) => ({
        id: r.id,
        iterationIndex: r.iterationIndex,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        requirementText: r.requirementText,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[main] iteration:get-history failed for ${projectId}: ${msg}`);
      return [];
    }
  });

  // ── iteration:list-proposed (P1-08b) ─────────
  // Returns the staged revision proposal for a (projectId, taskId) —
  // file paths + their proposed/current sha256 + unchanged flag +
  // the actual file contents (read from staging dir + workspace) so
  // the chat-side diff renderer can compute the per-line diff
  // without a follow-up roundtrip. Returns null when nothing is
  // staged. Independent of KAGEOPS_FEATURE_REVISIONS — if the
  // operator queries a project that never staged anything, they get
  // a null back.
  ipcMain.handle('iteration:list-proposed', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return null;
    const { projectId, taskId } = args as { projectId?: unknown; taskId?: unknown };
    if (typeof projectId !== 'string' || typeof taskId !== 'string') return null;
    try {
      const { listProposed, stagingDirFor } = await import('../agents/revision-staging');
      const { getOne } = await import('../db/client');
      const fs = await import('fs');
      const path = await import('path');

      const project = await getOne<{ repo_path: string }>(
        'SELECT repo_path FROM projects WHERE id = $1',
        [projectId]
      );
      if (project === null) return null;
      const proposal = listProposed(projectId, taskId, project.repo_path);
      if (proposal === null) return null;

      // Inline content for each file so the renderer can show the
      // diff without N more roundtrips. Capped at 64 KB per file —
      // anything larger is rendered as "(file too large to preview;
      // open the staging path in your editor)".
      const PREVIEW_CAP = 64 * 1024;
      const stagingRoot = stagingDirFor(projectId, taskId);
      const files = proposal.files.map((f) => {
        const stagedAbs = path.join(stagingRoot, f.path);
        const liveAbs = path.resolve(project.repo_path, f.path);
        const readSafe = (abs: string): string | null => {
          try {
            const buf = fs.readFileSync(abs, 'utf-8');
            return buf.length > PREVIEW_CAP ? null : buf;
          } catch { return null; }
        };
        return {
          path: f.path,
          sizeBytes: f.sizeBytes,
          proposedSha256: f.proposedSha256,
          currentSha256: f.currentSha256,
          unchanged: f.unchanged,
          proposedContent: readSafe(stagedAbs),
          currentContent: readSafe(liveAbs),
        };
      });

      return {
        projectId: proposal.projectId,
        taskId: proposal.taskId,
        createdAt: proposal.createdAt,
        files,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[main] iteration:list-proposed failed for ${String(projectId)}/${String(taskId)}: ${msg}`);
      return null;
    }
  });

  // ── iteration:accept-proposal (P1-08b) ───────
  // Move staged files into the live workspace via the standard
  // writeFile path (the P1-01c sha256 cache + sanitisation + stream
  // events all run). Unchanged files are skipped. Staging dir is
  // cleaned up on success. Returns { accepted: string[] }.
  ipcMain.handle('iteration:accept-proposal', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { ok: false, error: 'invalid args' };
    const { projectId, taskId } = args as { projectId?: unknown; taskId?: unknown };
    if (typeof projectId !== 'string' || typeof taskId !== 'string') {
      return { ok: false, error: 'projectId + taskId required' };
    }
    try {
      const { acceptProposal } = await import('../agents/revision-staging');
      const { getOne } = await import('../db/client');
      const project = await getOne<{ repo_path: string }>(
        'SELECT repo_path FROM projects WHERE id = $1',
        [projectId]
      );
      if (project === null) return { ok: false, error: 'project not found' };

      // Writer: bypass autonaut-agent (it's a class with a lot of
      // dependencies) and call fs.writeFileSync directly. The P1-01c
      // sha256 caching belongs to checkpoint-aware agent writes; an
      // operator-driven accept is a direct workspace write.
      const fs = await import('fs');
      const path = await import('path');
      const writer = async (rel: string, content: string): Promise<void> => {
        const abs = path.resolve(project.repo_path, rel);
        if (!abs.startsWith(path.resolve(project.repo_path))) {
          throw new Error(`Path traversal detected: ${rel}`);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
      };

      const accepted = await acceptProposal(projectId, taskId, project.repo_path, writer);

      // Emit a domain event so the operator UI + any future
      // listeners can update without polling.
      if (orchestrator !== null) {
        await orchestrator.eventBus.publish('revision.accepted' as never, {
          projectId,
          taskId,
          agent: 'human',
          data: { projectId, taskId, acceptedFiles: accepted, acceptedAt: new Date().toISOString() },
        });
      }
      return { ok: true, accepted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[main] iteration:accept-proposal failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  // ── iteration:reject-proposal (P1-08b) ───────
  // Delete the staging dir. Idempotent. Emits `revision.rejected`.
  ipcMain.handle('iteration:reject-proposal', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { ok: false, error: 'invalid args' };
    const { projectId, taskId } = args as { projectId?: unknown; taskId?: unknown };
    if (typeof projectId !== 'string' || typeof taskId !== 'string') {
      return { ok: false, error: 'projectId + taskId required' };
    }
    try {
      const { rejectProposal } = await import('../agents/revision-staging');
      rejectProposal(projectId, taskId);
      if (orchestrator !== null) {
        await orchestrator.eventBus.publish('revision.rejected' as never, {
          projectId,
          taskId,
          agent: 'human',
          data: { projectId, taskId, rejectedAt: new Date().toISOString() },
        });
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // Knowledge Base browses historical work — include completed projects
  // (exclude only archived). Active-only callers use get-projects above.
  ipcMain.handle('command-center:get-knowledge-base-projects', async () => {
    try {
      if (orchestrator !== null) {
        return await orchestrator.sensei.getAllProjectsStatus({ exclude: ['archived'] });
      }
      const { getMany } = await import('../db/client');
      return await getMany(
        'SELECT id, name, phase, status, trust_level FROM projects WHERE status != $1 ORDER BY created_at DESC',
        ['archived']
      );
    } catch {
      return [];
    }
  });

  // ── Agents ────────────────────────────────────
  ipcMain.handle('command-center:get-agents', async () => {
    try {
      const appConfig = loadAppAgentConfig();
      if (orchestrator !== null) {
        // Layer DB-derived busy state on top of the in-memory agent.status.
        // The in-memory flag goes idle between askAI calls and is empty after
        // an Electron restart, so the Autonauts list under-counted active
        // agents. The tasks table is the source of truth — any agent with an
        // assigned/in-progress row is genuinely working a task right now.
        const { getMany } = await import('../db/client');
        const busyRows = await getMany<{ assigned_agent: string; title: string | null }>(
          `SELECT DISTINCT ON (LOWER(assigned_agent))
                  assigned_agent, title
           FROM tasks
           WHERE assigned_agent IS NOT NULL
             AND status IN ('assigned', 'in-progress')
           ORDER BY LOWER(assigned_agent), started_at DESC NULLS LAST, created_at DESC`
        ).catch(() => [] as { assigned_agent: string; title: string | null }[]);
        const dbBusy = new Map<string, string | null>();
        for (const row of busyRows) {
          dbBusy.set(row.assigned_agent.toLowerCase(), row.title);
        }

        return orchestrator.agentRegistry.getAllAgents().map((a) => {
          const agentCfg = appConfig.agents[a.name];
          const dbTitle = dbBusy.get(a.name.toLowerCase());
          const status = dbTitle !== undefined && a.status !== 'error' ? 'busy' : a.status;
          return {
            name: a.name,
            role: a.role,
            status,
            currentTaskTitle: a.currentTaskTitle ?? dbTitle ?? null,
            model: agentCfg?.model ?? null,
            provider: agentCfg?.provider ?? null,
          };
        });
      }
      // Fallback: hardcoded placeholder
      return [
        { name: 'scout', role: 'strategist', status: 'idle', currentTaskTitle: null, model: null, provider: null },
        { name: 'blueprint', role: 'architect', status: 'idle', currentTaskTitle: null, model: null, provider: null },
        { name: 'forge', role: 'engineer', status: 'idle', currentTaskTitle: null, model: null, provider: null },
        { name: 'vigil', role: 'quality-guardian', status: 'idle', currentTaskTitle: null, model: null, provider: null },
        { name: 'aegis', role: 'platform-engineer', status: 'idle', currentTaskTitle: null, model: null, provider: null },
      ];
    } catch {
      return [];
    }
  });

  // ── Approvals ─────────────────────────────────
  ipcMain.handle('command-center:get-approvals', async () => {
    try {
      if (orchestrator !== null) {
        return await orchestrator.sensei.getApprovalQueue();
      }
      const { getMany } = await import('../db/client');
      return await getMany(
        'SELECT id, name, phase, status FROM projects WHERE status = $1',
        ['awaiting-approval']
      );
    } catch {
      return [];
    }
  });

  // ── Approval Details ───────────────────────────
  ipcMain.handle('command-center:get-approval-details', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return null;
    try {
      const { getOne, getMany } = await import('../db/client');

      const project = await getOne<{ id: string; name: string; description: string | null; phase: string }>(
        'SELECT id, name, description, phase FROM projects WHERE id = $1',
        [projectId]
      );
      if (project === null) return null;

      const currentPhase = project.phase;

      // Get tasks for the current phase
      const tasks = await getMany<{
        title: string;
        task_type: string | null;
        assigned_agent: string | null;
        status: string;
        quality_score: number | null;
      }>(
        `SELECT title, task_type, assigned_agent, status, quality_score
         FROM tasks WHERE project_id = $1 AND phase = $2
         ORDER BY completed_at DESC NULLS LAST, created_at ASC`,
        [projectId, currentPhase]
      );

      const PHASE_ORDER = ['discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth'];
      const PHASE_DESCRIPTIONS: Record<string, string> = {
        'discovery': 'Research, market analysis, and concept validation by Scout and Blueprint.',
        'poc': 'Proof of concept build — Forge creates a working prototype with Blueprint architecture.',
        'business-viability': 'Business model validation — Scout and Herald assess market fit and monetization.',
        'design-planning': 'Full design and architecture — Scout, Pixel, and Blueprint plan the product.',
        'development': 'Full build — Forge, Cipher, Aegis, Vigil, and Pixel implement the product.',
        'launch-growth': 'Deployment, testing, marketing — Aegis, Vigil, Herald, and Scout launch the product.',
      };

      const currentIdx = PHASE_ORDER.indexOf(currentPhase);
      const nextPhase = currentIdx >= 0 && currentIdx < PHASE_ORDER.length - 1
        ? PHASE_ORDER[currentIdx + 1]
        : null;

      return {
        projectId: project.id,
        currentPhase,
        nextPhase,
        description: project.description,
        completedTasks: tasks.map((t) => ({
          title: t.title,
          taskType: t.task_type,
          assignedAgent: t.assigned_agent,
          status: t.status,
          qualityScore: t.quality_score,
        })),
        phaseDescription: PHASE_DESCRIPTIONS[currentPhase] ?? 'Phase work completed.',
        nextPhaseDescription: nextPhase !== null
          ? (PHASE_DESCRIPTIONS[nextPhase] ?? 'Next phase of development.')
          : '',
      };
    } catch (err) {
      log.error({ err }, 'Failed to load approval details');
      return null;
    }
  });

  // ── Approval History ──────────────────────────
  ipcMain.handle('command-center:get-approval-history', async () => {
    try {
      const { getMany } = await import('../db/client');
      // Include `metadata` (the JSONB payload) so the renderer can show
      // the actual reason, phase context, and required-id list for each
      // historical entry — not just a flat status row.
      return await getMany<{
        id: string;
        event_type: string;
        agent: string;
        project_id: string;
        project_name: string;
        phase: string;
        created_at: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT
           al.id,
           al.event_type,
           al.agent,
           al.project_id,
           COALESCE(p.name, 'Unknown') AS project_name,
           COALESCE(p.phase, '') AS phase,
           al.created_at::text,
           al.metadata
         FROM agent_logs al
         LEFT JOIN projects p ON al.project_id = p.id
         WHERE al.event_type IN ('approval.required', 'approval.granted', 'approval.denied')
         ORDER BY al.created_at DESC
         LIMIT 50`
      );
    } catch {
      return [];
    }
  });

  // ── Approve gate ──────────────────────────────
  ipcMain.handle('command-center:approve-gate', async (_event, projectId: unknown) => {
    const parsed = ApproveGateArgsSchema.safeParse({ projectId });
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid approve-gate args — ignoring');
      return;
    }
    try {
      if (orchestrator !== null) {
        await orchestrator.sensei.approveGate(parsed.data.projectId);
        return;
      }
      // Fallback: direct DB update
      const { query } = await import('../db/client');
      await query('UPDATE projects SET status = $1 WHERE id = $2', ['active', parsed.data.projectId]);
    } catch (err) {
      log.error({ err }, 'Approve gate failed');
    }
  });

  // ── Deny gate ─────────────────────────────────
  ipcMain.handle('command-center:deny-gate', async (_event, projectId: unknown, reason?: unknown) => {
    const parsed = DenyGateArgsSchema.safeParse({
      projectId,
      reason: typeof reason === 'string' ? reason : undefined,
    });
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid deny-gate args — ignoring');
      return;
    }
    try {
      if (orchestrator !== null) {
        await orchestrator.sensei.denyGate(parsed.data.projectId, parsed.data.reason);
        return;
      }
      const { query } = await import('../db/client');
      await query('UPDATE projects SET status = $1 WHERE id = $2', ['active', parsed.data.projectId]);
    } catch (err) {
      log.error({ err }, 'Deny gate failed');
    }
  });

  // ── Title-bar overlay (theme-driven repaint) ──────
  ipcMain.handle('command-center:set-title-bar-overlay', (_event, args: unknown) => {
    if (process.platform !== 'win32') return { ok: true };
    if (typeof args !== 'object' || args === null) return { ok: false };
    const a = args as Record<string, unknown>;
    const color = typeof a['color'] === 'string' ? a['color'] : undefined;
    const symbolColor = typeof a['symbolColor'] === 'string' ? a['symbolColor'] : undefined;
    if (color === undefined || symbolColor === undefined) return { ok: false };
    try {
      const win = getCommandCenterWindow();
      if (win === null) return { ok: false };
      win.setTitleBarOverlay({ color, symbolColor });
      return { ok: true };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'setTitleBarOverlay failed');
      return { ok: false };
    }
  });

  // ── Start project ─────────────────────────────
  ipcMain.handle('command-center:start-project', async (_event, name: unknown, description: unknown) => {
    const parsed = StartProjectArgsSchema.safeParse({ name, description });
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid start-project args — ignoring');
      return { id: null, error: 'Invalid project name or description.' };
    }
    try {
      if (orchestrator !== null) {
        const id = await orchestrator.sensei.startProject(parsed.data.name, parsed.data.description, 'low');
        return { id, error: null };
      }
      // Fallback: direct DB insert — with duplicate check (legacy code path
      // when the orchestrator isn't bootstrapped, e.g. during smoke tests).
      // Fallback: direct DB insert — with duplicate check
      const { query } = await import('../db/client');
      const existing = await query(
        'SELECT id FROM projects WHERE lower(name) = lower($1) LIMIT 1',
        [parsed.data.name]
      );
      if (existing.rows.length > 0) {
        return { id: existing.rows[0].id ?? null, error: null };
      }
      const result = await query(
        'INSERT INTO projects (name, description, repo_path, phase, trust_level, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [parsed.data.name, parsed.data.description, `projects/${parsed.data.name.toLowerCase().replace(/\s+/g, '-')}`, 'discovery', 'low', 'active']
      );
      return { id: result.rows[0]?.id ?? null, error: null };
    } catch (err) {
      // F-314: surface tier limits as a structured response so the UI can
      // show an upgrade CTA instead of a generic toast.
      const { TierLimitError } = await import('../shared/tier-limit-error');
      if (TierLimitError.is(err)) {
        log.info({ feature: err.feature, plan: err.plan }, 'Project create blocked by tier limit');
        return {
          id: null,
          error: err.message,
          tierLimit: { plan: err.plan, feature: err.feature, requiredPlan: err.requiredPlan },
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Start project failed');
      return { id: null, error: msg };
    }
  });

  // ── Start project (advanced onboarding) ────────
  // Accepts the full New Project form: trust level, enabled phases,
  // tech stack, goal, project type, budget cap. Stored on the project
  // row so agents can read them as additional context instead of
  // guessing from the description alone.
  ipcMain.handle('command-center:start-project-advanced', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { id: null, error: 'Invalid arguments' };
    }
    const a = args as Record<string, unknown>;
    const name = typeof a['name'] === 'string' ? a['name'].trim() : '';
    const description = typeof a['description'] === 'string' ? a['description'] : '';
    if (name === '' || description.trim() === '') {
      return { id: null, error: 'Name and description are required.' };
    }
    const trustLevel = a['trustLevel'] === 'medium' || a['trustLevel'] === 'high' ? a['trustLevel'] : 'low';
    const enabledPhases = Array.isArray(a['enabledPhases'])
      ? (a['enabledPhases'] as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined;
    const projectType = typeof a['projectType'] === 'string' && a['projectType'] !== ''
      ? a['projectType']
      : undefined;
    const techStack = typeof a['techStack'] === 'string' && a['techStack'].trim() !== ''
      ? a['techStack'].trim()
      : undefined;
    const goal = typeof a['goal'] === 'string' && a['goal'].trim() !== ''
      ? a['goal'].trim()
      : undefined;
    const budgetUsdRaw = a['budgetUsd'];
    const budgetUsd = typeof budgetUsdRaw === 'number' && Number.isFinite(budgetUsdRaw) && budgetUsdRaw > 0
      ? Math.min(budgetUsdRaw, 100)
      : undefined;
    // Pillar 2.2 PR-E — operator-picked bundle from the Project Type
    // dropdown. Validated as a bare bundle name (lowercase + digits +
    // hyphens); reject anything else so a poisoned IPC payload can't
    // sneak SQL fragments through.
    const selectedBundleRaw = a['selectedBundle'];
    const selectedBundle = typeof selectedBundleRaw === 'string'
      && /^[a-z0-9][a-z0-9-]*$/.test(selectedBundleRaw.trim())
      ? selectedBundleRaw.trim()
      : undefined;
    // #165 stage 2 — operator-picked per-phase task allowlist. Validated to
    // a plain `Record<string, string[]>` so a bad renderer payload can't
    // poison the JSONB column. Empty arrays are dropped (would otherwise
    // block decomposition for that phase). `null`/missing = legacy.
    const phaseTaskSelections: Record<string, readonly string[]> | undefined = (() => {
      const raw = a['phaseTaskSelections'];
      if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const out: Record<string, string[]> = {};
      for (const [phaseKey, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof phaseKey !== 'string') continue;
        if (!Array.isArray(value)) continue;
        const tasks = value.filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (tasks.length === 0) continue;
        out[phaseKey] = tasks;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })();

    try {
      if (orchestrator === null) {
        return { id: null, error: 'Orchestrator not running' };
      }
      const id = await orchestrator.sensei.startProject(name, description, {
        trustLevel: trustLevel as 'low' | 'medium' | 'high',
        ...(enabledPhases !== undefined ? { enabledPhases: enabledPhases as never[] } : {}),
        ...(projectType !== undefined ? { projectType } : {}),
        ...(techStack !== undefined ? { techStack } : {}),
        ...(goal !== undefined ? { goal } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(phaseTaskSelections !== undefined ? { phaseTaskSelections } : {}),
        ...(selectedBundle !== undefined ? { selectedBundle } : {}),
      });
      return { id, error: null };
    } catch (err) {
      const { TierLimitError } = await import('../shared/tier-limit-error');
      if (TierLimitError.is(err)) {
        log.info({ feature: err.feature, plan: err.plan }, 'Project create blocked by tier limit (advanced)');
        return {
          id: null,
          error: err.message,
          tierLimit: { plan: err.plan, feature: err.feature, requiredPlan: err.requiredPlan },
        };
      }
      // Pillar 2.2 PR-H — surface duplicate-name errors with the existing
      // project id so the renderer can show a clear modal error (and
      // eventually offer an "Open existing project" CTA).
      const { DuplicateProjectError } = await import('../orchestrator/sensei');
      if (DuplicateProjectError.is(err)) {
        log.info(
          { existingId: err.existingId, projectName: err.projectName, existingStatus: err.existingStatus },
          'Project create blocked: duplicate name'
        );
        return {
          id: null,
          error: err.message,
          duplicate: { existingId: err.existingId, status: err.existingStatus },
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'start-project-advanced failed');
      return { id: null, error: msg };
    }
  });

  // ── Sensei message ────────────────────────────
  ipcMain.handle('command-center:sensei-message', async (_event, args: unknown) => {
    // Backwards-compat: callers used to invoke this IPC with a bare string.
    // PR B of F-302 V1 expanded the contract to an object with optional
    // projectId + author attribution. Accept both shapes so older preloads
    // (e.g. an Electron window that wasn't reloaded after upgrade) keep working.
    const argsObject: unknown = typeof args === 'string'
      ? { message: args }
      : args;
    const parsed = SenseiMessageArgsSchema.safeParse(argsObject);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid sensei-message args — ignoring');
      return 'Invalid message format.';
    }
    try {
      if (orchestrator !== null) {
        orchestrator.activityBridge.pushActivity({
          agent: 'User',
          message: `Asked Sensei: "${parsed.data.message.slice(0, 80)}${parsed.data.message.length > 80 ? '...' : ''}"`,
          channel: 'sensei.chat',
        });

        // Project channels enable persistent shared chat (PR B of F-302).
        // Without a project, fall through to the legacy in-memory channel.
        const channelId = parsed.data.projectId !== undefined
          ? `project:${parsed.data.projectId}`
          : 'command-center';

        const reply = await orchestrator.sensei.handleUserMessage(
          parsed.data.message,
          channelId,
          {
            authorUserId: parsed.data.authorUserId ?? null,
            authorName:   parsed.data.authorName,
            authorRole:   parsed.data.authorRole ?? null,
          },
        );

        orchestrator.activityBridge.pushActivity({
          agent: 'Sensei',
          message: `Responded: "${reply.slice(0, 100)}${reply.length > 100 ? '...' : ''}"`,
          channel: 'sensei.chat',
        });

        return reply;
      }
      return `Sensei is offline (database unavailable). Your message: "${parsed.data.message}"`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Sensei message failed');
      return `Sorry, I encountered an error: ${msg}`;
    }
  });

  // ── Plan Window — re-open from Command Center "Manage plan" item ───
  // After first sign-in the plan window auto-closes once the user picks
  // a tier; this IPC re-opens it on demand so users can upgrade /
  // downgrade / cancel any time. Idempotent re-open is handled inside
  // showPlanWindow (focuses existing instance if already open).
  ipcMain.handle('plan:reopen', async () => {
    // Commercial (plan/billing) — delegated to the registry. Absent in the
    // open build, where there's no plan window to reopen.
    const reopen = commercialExtensions.reopenPlanWindow;
    if (reopen === undefined) {
      return { ok: false, error: 'Plan management is not available in this build' };
    }
    return reopen();
  });

  // ── Speciality Matrix ──────────────────────────
  ipcMain.handle('command-center:get-matrix', async () => {
    try {
      const { SpecialityMatrix } = await import('../orchestrator/speciality-matrix');
      const matrix = new SpecialityMatrix();
      return await matrix.getMatrix();
    } catch {
      return [];
    }
  });

  // ── API Key Management ────────────────────────
  ipcMain.handle('command-center:get-api-key-status', async () => {
    try {
      return await getApiKeyStatus();
    } catch {
      return {};
    }
  });

  ipcMain.handle('command-center:set-api-key', async (_event, provider: unknown, key: unknown) => {
    const parsed = SetApiKeyArgsSchema.safeParse({ provider, key });
    if (!parsed.success) {
      const msg = parsed.error.flatten().fieldErrors.provider?.join(', ') ??
        parsed.error.flatten().fieldErrors.key?.join(', ') ??
        'Invalid provider or key';
      return { success: false, error: msg };
    }
    try {
      await setApiKey(parsed.data.provider as AiProvider, parsed.data.key);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('command-center:delete-api-key', async (_event, provider: unknown) => {
    const parsed = DeleteApiKeyArgsSchema.safeParse({ provider });
    if (!parsed.success) {
      const msg = parsed.error.flatten().fieldErrors.provider?.join(', ') ?? 'Invalid provider';
      return { success: false, error: msg };
    }
    try {
      const accountMap: Record<string, string> = {
        claude: 'anthropic-api-key',
        openrouter: 'openrouter-api-key',
        openai: 'openai-api-key',
        gemini: 'gemini-api-key',
      };
      const account = accountMap[parsed.data.provider];
      if (account !== undefined) {
        await deleteSecret('kageops', account);
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });

  // ── Cost Tracker ─────────────────────────────
  ipcMain.handle('command-center:get-costs', async () => {
    try {
      const { getMany } = await import('../db/client');
      const entries = await getMany<{
        agent: string;
        total_cost: string;
        tokens_in: string;
        tokens_out: string;
        request_count: string;
      }>(
        `SELECT agent,
                SUM(cost_usd) AS total_cost,
                SUM(tokens_in) AS tokens_in,
                SUM(tokens_out) AS tokens_out,
                COUNT(*) AS request_count
         FROM agent_logs
         WHERE action = 'ai-request'
         GROUP BY agent
         ORDER BY SUM(cost_usd) DESC`
      );

      const byAgent = entries.map((e) => ({
        agent: e.agent,
        totalCost: parseFloat(e.total_cost) || 0,
        tokensIn: parseInt(e.tokens_in, 10) || 0,
        tokensOut: parseInt(e.tokens_out, 10) || 0,
        requestCount: parseInt(e.request_count, 10) || 0,
      }));

      return {
        byAgent,
        totalCost: byAgent.reduce((sum, a) => sum + a.totalCost, 0),
        totalTokensIn: byAgent.reduce((sum, a) => sum + a.tokensIn, 0),
        totalTokensOut: byAgent.reduce((sum, a) => sum + a.tokensOut, 0),
        totalRequests: byAgent.reduce((sum, a) => sum + a.requestCount, 0),
      };
    } catch {
      return { byAgent: [], totalCost: 0, totalTokensIn: 0, totalTokensOut: 0, totalRequests: 0 };
    }
  });

  // ── Build Status ─────────────────────────────
  ipcMain.handle('command-center:get-builds', async () => {
    try {
      const { getMany } = await import('../db/client');
      return await getMany(
        `SELECT id, project_id, pipeline, run_id, status, branch, commit_sha,
                url, log_summary, started_at, completed_at
         FROM build_status
         ORDER BY created_at DESC
         LIMIT 20`
      );
    } catch {
      return [];
    }
  });

  // ── Operational Cost Intelligence (v0.7) ─────
  ipcMain.handle('command-center:get-operational-costs', async (_event, windowDays: unknown) => {
    const parsed = GetOperationalCostsArgsSchema.safeParse({ windowDays: windowDays ?? 30 });
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid get-operational-costs args — using defaults');
    }
    const days = parsed.success ? parsed.data.windowDays : 30;
    try {
      if (orchestrator !== null) {
        return await orchestrator.operationalCostTracker.getOperationalSummary(days);
      }
      // Return empty summary when orchestrator is unavailable
      return {
        totalToday: 0,
        totalThisWeek: 0,
        totalThisMonth: 0,
        byAgent: [],
        byProvider: [],
        byProject: [],
        lastSyncAt: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get operational costs');
      return null;
    }
  });

  commercialExtensions.registerCloudHandlers?.({
    getEventBus: () => orchestrator?.eventBus ?? null,
    setBurstIdleReaperStop: (stop) => { stopBurstIdleReaper = stop; },
  });

  // ── Run Budgets (B-449) — per-project cap + live spend ──
  //
  // Returns one row per active/paused project with the DB-persisted cap
  // and the current spend sourced from agent_logs. The cost poller in
  // headless-runner reads the same column (projects.budget_usd) each
  // tick, so edits made here take effect within ~3 seconds without a
  // restart.
  ipcMain.handle(IPC.GET_RUN_BUDGETS, async () => {
    try {
      const { getMany } = await import('../db/client');
      return await getMany<{
        projectId: string;
        projectName: string;
        status: string;
        capUsd: number | null;
        spentUsd: number;
        tokensOut: number;
      }>(
        `SELECT p.id           AS "projectId",
                p.name         AS "projectName",
                p.status       AS "status",
                p.budget_usd::float8 AS "capUsd",
                COALESCE((SELECT SUM(cost_usd) FROM agent_logs WHERE project_id = p.id), 0)::float8 AS "spentUsd",
                COALESCE((SELECT SUM(tokens_out) FROM agent_logs WHERE project_id = p.id), 0)::float8 AS "tokensOut"
           FROM projects p
          WHERE p.status IN ('active', 'paused')
          ORDER BY p.updated_at DESC
          LIMIT 20`
      );
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'get-run-budgets failed');
      return [];
    }
  });

  ipcMain.handle(IPC.SET_PROJECT_BUDGET, async (_event, args: unknown) => {
    const obj = (args ?? {}) as { projectId?: unknown; capUsd?: unknown };
    const projectId = typeof obj.projectId === 'string' ? obj.projectId : '';
    const capUsd = typeof obj.capUsd === 'number' ? obj.capUsd : NaN;
    if (projectId.length === 0) {
      return { ok: false, error: 'projectId is required' };
    }
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      return { ok: false, error: 'capUsd must be a positive finite number' };
    }
    // Clamp to a sane ceiling so a fat-finger "100" stays bounded without
    // us having to invent an operator-level approval flow.
    const MAX_CAP = 100;
    const clamped = Math.min(capUsd, MAX_CAP);
    try {
      const { query } = await import('../db/client');
      await query(
        `UPDATE projects SET budget_usd = $1 WHERE id = $2`,
        [clamped, projectId]
      );
      return { ok: true, capUsd: clamped, clamped: clamped < capUsd };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, projectId }, 'set-project-budget failed');
      return { ok: false, error: msg };
    }
  });

  // ── Code Graph Status (v0.8) ──────────────────
  ipcMain.handle('command-center:get-graph-status', async (_event, repoPath: unknown) => {
    const parsed = GetGraphStatusArgsSchema.safeParse({ repoPath });
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid get-graph-status args');
      return null;
    }
    try {
      if (orchestrator !== null) {
        return orchestrator.codeGraphBridge.getStatus(parsed.data.repoPath);
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get graph status');
      return null;
    }
  });

  ipcMain.handle('command-center:get-graph-statuses', async () => {
    try {
      return orchestrator !== null ? orchestrator.codeGraphBridge.getAllStatuses() : [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get graph statuses');
      return [];
    }
  });

  // ── Graphify Knowledge Graphs ─────────────────────
  // Scans each project's repo_path for graphify-out/graph.json and returns stats.
  ipcMain.handle('command-center:get-graphify-graphs', async () => {
    try {
      const { getMany: _getMany } = await import('../db/client');
      const rows = await _getMany<{ id: string; name: string; repo_path: string }>(
        `SELECT id, name, repo_path FROM projects WHERE repo_path IS NOT NULL AND repo_path != '' ORDER BY created_at DESC`,
        [],
      );
      const fs = await import('node:fs');
      return rows.map((row: { id: string; name: string; repo_path: string }) => {
        const graphPath = path.join(row.repo_path, 'graphify-out', 'graph.json');
        const htmlPath  = path.join(row.repo_path, 'graphify-out', 'graph.html');
        const hasGraph = fs.existsSync(graphPath);
        if (!hasGraph) {
          return { projectId: row.id, projectName: row.name, repoPath: row.repo_path,
                   hasGraph: false, htmlPath: null, nodeCount: 0, edgeCount: 0, builtAt: null };
        }
        try {
          const raw = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as Record<string, unknown>;
          const nodes = Array.isArray((raw as { nodes?: unknown }).nodes)
            ? (raw as { nodes: unknown[] }).nodes.length : 0;
          // graphify's to_json shifted from `links` (NetworkX legacy) to
          // `edges` (current). The manual fallback writer also uses `edges`.
          // Accept either so the badge stops reporting "0 edges" forever.
          const edgesRaw = raw as { edges?: unknown; links?: unknown };
          const edges = Array.isArray(edgesRaw.edges)
            ? (edgesRaw.edges as unknown[]).length
            : Array.isArray(edgesRaw.links)
            ? (edgesRaw.links as unknown[]).length
            : 0;
          const stat = fs.statSync(graphPath);
          return { projectId: row.id, projectName: row.name, repoPath: row.repo_path,
                   hasGraph: true, htmlPath: fs.existsSync(htmlPath) ? htmlPath : null,
                   nodeCount: nodes, edgeCount: edges, builtAt: stat.mtime.toISOString() };
        } catch {
          return { projectId: row.id, projectName: row.name, repoPath: row.repo_path,
                   hasGraph: false, htmlPath: null, nodeCount: 0, edgeCount: 0, builtAt: null };
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get graphify graphs');
      return [];
    }
  });

  // Track active graphify child processes to avoid duplicate builds
  const activeGraphifyBuilds = new Map<string, import('node:child_process').ChildProcess>();

  ipcMain.handle('command-center:run-graphify', async (event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { ok: false, error: 'invalid args' };
    const { projectId, repoPath } = args as Record<string, unknown>;
    if (typeof projectId !== 'string' || typeof repoPath !== 'string') {
      return { ok: false, error: 'invalid args' };
    }

    // Validate repoPath belongs to a known project (path traversal guard)
    try {
      const { getMany: _gm } = await import('../db/client');
      const rows = await _gm<{ id: string }>(
        `SELECT id FROM projects WHERE id = $1 AND repo_path = $2`,
        [projectId, repoPath],
      );
      if (rows.length === 0) return { ok: false, error: 'project not found' };
    } catch {
      return { ok: false, error: 'db error' };
    }

    if (activeGraphifyBuilds.has(projectId)) {
      return { ok: false, error: 'already building' };
    }

    const GRAPHIFY_SCRIPT = `
import sys, traceback
from pathlib import Path

def emit(msg):
    print(msg, flush=True)

try:
    repo = Path(sys.argv[1]).resolve()
    if not repo.exists():
        emit("ERROR: repo path does not exist: " + str(repo))
        sys.exit(1)

    from graphify.detect import detect
    emit("Detecting files...")
    result = detect(repo)
    code_files = result.get("files", {}).get("code", [])
    total = result.get("total_files", 0)
    emit("Found " + str(total) + " files (" + str(len(code_files)) + " code)")

    from graphify.extract import collect_files, extract
    collected = []
    for f in code_files:
        fp = Path(f)
        if fp.is_dir():
            collected.extend(collect_files(fp))
        else:
            collected.append(fp)
    if collected:
        emit("Extracting " + str(len(collected)) + " code files...")
        extracted = extract(collected)
        emit("  " + str(len(extracted["nodes"])) + " nodes, " + str(len(extracted["edges"])) + " edges from AST")
    else:
        emit("No code files — building empty graph")
        extracted = {"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}

    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    emit("Building graph...")
    G = build_from_json(extracted)
    # graphify API (current): cluster() returns dict[int, list[str]] of
    # community memberships; score_all(G, communities) returns dict[int, float].
    # Older versions mutated G in-place — we now attach attributes ourselves so
    # downstream consumers (graphify-bridge.ts) can still read node.community.
    communities = cluster(G)
    scores = score_all(G, communities)
    for _cid, _members in communities.items():
        for _nid in _members:
            if _nid in G.nodes:
                G.nodes[_nid]["community"] = _cid
    for _cid, _score in scores.items():
        # Stamp the community-level score onto every member node for the bridge
        for _nid in communities.get(_cid, []):
            if _nid in G.nodes:
                G.nodes[_nid]["community_score"] = _score
    n = len(G.nodes)
    e = len(G.edges)
    emit("Graph: " + str(n) + " nodes, " + str(e) + " edges")

    out = repo / "graphify-out"
    out.mkdir(parents=True, exist_ok=True)

    # graphify's export API has shifted across versions. Older releases
    # accept to_json(G, output_path) positionally; newer ones require a
    # keyword argument output_path= (TypeError: missing 1 required
    # positional argument: 'output_path'). Try both before giving up.
    from graphify.export import to_json
    _graph_path = out / "graph.json"
    try:
        to_json(G, _graph_path)
    except TypeError:
        try:
            to_json(G, output_path=_graph_path)
        except TypeError:
            # Last-resort manual write so the graph is at least loadable.
            import json as _json
            _payload = {
                "nodes": [{"id": n, **(G.nodes[n] if n in G.nodes else {})} for n in G.nodes],
                "edges": [{"source": u, "target": v, **(G.edges[u, v] if (u, v) in G.edges else {})} for u, v in G.edges],
            }
            _graph_path.write_text(_json.dumps(_payload), encoding="utf-8")
    emit("Saved graph.json")

    # Same hedge for to_html — graphify renames keep happening here too.
    # The .viz submodule ships as an optional extra (graphify[viz]); when
    # the operator only has the base install we just skip the HTML render.
    # graph.json is already written above — that's what the IPC handler
    # consumes anyway. Don't fail the whole bridge over a missing optional.
    try:
        from graphify.viz import to_html
        _html_path = out / "graph.html"
        try:
            to_html(G, _html_path, title=repo.name)
        except TypeError:
            try:
                to_html(G, output_path=_html_path, title=repo.name)
            except TypeError:
                emit("WARN: graphify.viz.to_html signature unrecognised — skipping graph.html")
        emit("Saved graph.html")
    except ImportError:
        emit("INFO: graphify.viz not installed — skipping graph.html (graph.json was saved)")

    try:
        from graphify.report import generate
        report = generate(G, repo)
        (out / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    except Exception:
        pass

    emit("DONE:" + str(n) + ":" + str(e))
    sys.exit(0)
except Exception as ex:
    emit("ERROR: " + str(ex))
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(2)
`;

    const { spawn } = await import('node:child_process');
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(pythonBin, ['-c', GRAPHIFY_SCRIPT, repoPath], {
      cwd: repoPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      shell: false,
      windowsHide: true,
    });
    activeGraphifyBuilds.set(projectId, child);

    const wc = event.sender;
    let buffer = '';
    let nodeCount = 0;
    let edgeCount = 0;
    let hasError = false;
    let errorMsg = '';

    const sendLine = (line: string): void => {
      if (line.startsWith('DONE:')) {
        const parts = line.split(':');
        nodeCount = parseInt(parts[1] ?? '0', 10) || 0;
        edgeCount = parseInt(parts[2] ?? '0', 10) || 0;
        return;
      }
      if (line.startsWith('ERROR:')) {
        hasError = true;
        errorMsg = line.slice(6).trim();
      }
      if (!wc.isDestroyed()) {
        wc.send('graphify-progress', { projectId, line, done: false, error: null });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) sendLine(l);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim();
      if (msg && !wc.isDestroyed()) {
        wc.send('graphify-progress', { projectId, line: msg, done: false, error: null });
      }
    });

    child.on('close', async (code) => {
      activeGraphifyBuilds.delete(projectId);
      if (buffer.trim()) sendLine(buffer.trim());
      const ok = code === 0 && !hasError;

      // v0.1.33 — if graphify.viz didn't write graph.html (which is the
      // common case since graphify is private and many installs are
      // missing the viz submodule), render our own from the JSON. This
      // removes the Python dependency for visualisation entirely.
      let renderedFallbackHtml = false;
      if (ok) {
        try {
          const fs2 = await import('node:fs');
          const graphJsonPath = path.join(repoPath, 'graphify-out', 'graph.json');
          const graphHtmlPath = path.join(repoPath, 'graphify-out', 'graph.html');
          if (fs2.existsSync(graphJsonPath) && !fs2.existsSync(graphHtmlPath)) {
            const { renderGraphHtmlFromJson } = await import('./graph-html-renderer');
            const jsonText = fs2.readFileSync(graphJsonPath, 'utf-8');
            const projectName = path.basename(repoPath);
            const html = renderGraphHtmlFromJson(jsonText, projectName);
            if (html !== null) {
              fs2.writeFileSync(graphHtmlPath, html, 'utf-8');
              renderedFallbackHtml = true;
            }
          }
        } catch (err) {
          // Non-fatal — viewer just won't open, panel hint handles it
          log.warn(
            { err: err instanceof Error ? err.message : String(err), projectId },
            'Fallback graph.html render failed',
          );
        }
      }

      if (!wc.isDestroyed()) {
        if (renderedFallbackHtml) {
          wc.send('graphify-progress', {
            projectId,
            line: 'Rendered graph.html via built-in viewer (graphify.viz not required)',
            done: false,
            error: null,
          });
        }
        wc.send('graphify-progress', {
          projectId,
          line: ok
            ? `Done — ${nodeCount} nodes, ${edgeCount} edges`
            : `Failed (exit ${code ?? '?'})`,
          done: true,
          error: ok ? null : (errorMsg || `exit ${code}`),
          nodeCount: ok ? nodeCount : undefined,
          edgeCount: ok ? edgeCount : undefined,
        });
      }
    });

    child.on('error', (err) => {
      activeGraphifyBuilds.delete(projectId);
      const msg = err.message.includes('ENOENT')
        ? `Python not found — install Python 3.10+ and ensure it is on PATH`
        : err.message;
      if (!wc.isDestroyed()) {
        wc.send('graphify-progress', { projectId, line: msg, done: true, error: msg });
      }
    });

    return { ok: true };
  });

  ipcMain.handle('command-center:read-graph-html', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') return { ok: false, error: 'invalid path' };
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.endsWith('graphify-out/graph.html')) {
      return { ok: false, error: 'invalid file' };
    }
    try {
      const fs = await import('node:fs');
      if (!fs.existsSync(filePath)) return { ok: false, error: 'not found' };
      const content = fs.readFileSync(filePath, 'utf-8');
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || url.trim() === '') return;
    await shell.openExternal(url);
  });

  // ── GitHub Integration (v0.9) ─────────────────
  ipcMain.handle('settings:set-github-token', async (_event, token: unknown) => {
    if (typeof token !== 'string' || token.trim() === '') {
      return { success: false, error: 'Invalid token' };
    }
    try {
      const { setApiKey } = await import('../main/secret-store');
      await setApiKey('github', token.trim());
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to save GitHub token');
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('settings:get-github-status', async () => {
    try {
      const { hasApiKey } = await import('../main/secret-store');
      const hasToken = await hasApiKey('github');
      return { hasToken };
    } catch {
      return { hasToken: false };
    }
  });

  ipcMain.handle('command-center:set-project-github', async (_event, projectId: unknown, owner: unknown, repo: unknown) => {
    if (typeof projectId !== 'string' || typeof owner !== 'string' || typeof repo !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    try {
      const { query } = await import('../db/client');
      await query(
        'UPDATE projects SET github_owner = $1, github_repo = $2 WHERE id = $3',
        [owner.trim() || null, repo.trim() || null, projectId]
      );
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to set project GitHub config');
      return { success: false, error: msg };
    }
  });

  // ── Project Lifecycle (B-401 / B-402 / B-403) ────
  // Registers cancel / pause / resume / archive / restore / delete /
  // retry-failed / list-projects-filtered. Backed by Sensei methods;
  // see `project-lifecycle-ipc.ts` for input validation and shapes.
  registerProjectLifecycleHandlers({
    getOrchestrator: () => orchestrator,
  });

  // ── Project push-to-GitHub (B-427) ────────────
  registerProjectGitHubPushHandler({
    getProjectRow: async (projectId) => {
      const { getOne } = await import('../db/client');
      return getOne<{ github_owner: string | null; github_repo: string | null; repo_path: string | null }>(
        'SELECT github_owner, github_repo, repo_path FROM projects WHERE id = $1',
        [projectId],
      );
    },
    getGitHubToken: async () => {
      const { getApiKey } = await import('./secret-store');
      return getApiKey('github');
    },
    getGitHubClient: () => {
      const { getGitHubClient } = require('../github/github-client') as typeof import('../github/github-client');
      return getGitHubClient();
    },
    ensureCommitted: githubPushEnsureCommitted,
    getCurrentBranch: githubPushGetCurrentBranch,
    getEventBus: () => orchestrator?.eventBus ?? null,
  });

  // ── Artifact Browser (v2.4) ───────────────────
  const artifactService = (() => {
    const { ArtifactService } = require('../workspace/artifact-service') as typeof import('../workspace/artifact-service');
    return new ArtifactService();
  })();

  ipcMain.handle('command-center:artifact-list', async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const projectId = typeof a['projectId'] === 'string' ? a['projectId'] : '';
    const subPath = typeof a['subPath'] === 'string' ? a['subPath'] : '';
    if (projectId === '') return { success: false, error: 'Invalid projectId', nodes: [] };
    try {
      const nodes = await artifactService.listFiles(projectId, subPath);
      return { success: true, nodes };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), nodes: [] };
    }
  });

  ipcMain.handle('command-center:artifact-read', async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const projectId = typeof a['projectId'] === 'string' ? a['projectId'] : '';
    const relPath = typeof a['relPath'] === 'string' ? a['relPath'] : '';
    if (projectId === '' || relPath === '') return { success: false, error: 'Invalid arguments' };
    try {
      const preview = await artifactService.readPreview(projectId, relPath);
      return { success: true, preview };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:artifact-download-zip', async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const projectId = typeof a['projectId'] === 'string' ? a['projectId'] : '';
    if (projectId === '') return { success: false, error: 'Invalid projectId' };
    try {
      const zipPath = await artifactService.downloadZip(projectId);
      // Prompt the user to save the zip via Electron dialog.
      const { dialog } = await import('electron');
      const fs = await import('fs');
      const path = await import('path');
      const defaultName = path.default.basename(zipPath);
      const result = await dialog.showSaveDialog({
        title: 'Save project zip',
        defaultPath: defaultName,
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Cancelled' };
      }
      fs.default.copyFileSync(zipPath, result.filePath);
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Artifact Browser — list-tree / read-file + protocol (B-420/421/422) ──
  // Registers `artifacts:list-tree`, `artifacts:read-file`, and the
  // `kageops-artifact://` file protocol used by the sandboxed HTML preview.
  registerArtifactBrowserHandlers({
    lookupProjectRoot: (projectId) => artifactService.getProjectRootPublic(projectId),
  });

  // ── Artifact Browser — live preview server (B-425) ───
  // At most one live server per project. The renderer owns lifecycle:
  // start returns the URL, stop tears it down on panel close.
  const liveServers = new Map<string, { url: string; port: number; stop: () => Promise<void> }>();

  ipcMain.handle(IPC.ARTIFACT_LIVE_START, async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const projectId = typeof a['projectId'] === 'string' ? a['projectId'] : '';
    if (projectId === '') return { success: false, error: 'Invalid projectId' };
    try {
      const existing = liveServers.get(projectId);
      if (existing !== undefined) {
        return { success: true, url: existing.url, port: existing.port };
      }
      const root = await artifactService.getProjectRootPublic(projectId);
      if (root === null) return { success: false, error: 'Project not found' };
      const { startLiveServer } = await import('./artifact-live-server');
      const handle = await startLiveServer(root);
      liveServers.set(projectId, handle);
      return { success: true, url: handle.url, port: handle.port };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.ARTIFACT_DELETE, async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const projectId = typeof a['projectId'] === 'string' ? a['projectId'] : '';
    const relPath = typeof a['relPath'] === 'string' ? a['relPath'] : '';
    const recursive = a['recursive'] === true;
    if (projectId === '' || relPath === '') {
      return { success: false, error: 'Invalid arguments' };
    }
    try {
      const result = await artifactService.deletePath(projectId, relPath, { recursive });
      return { success: true, kind: result.kind };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.ARTIFACT_LIVE_STOP, async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const projectId = typeof a['projectId'] === 'string' ? a['projectId'] : '';
    if (projectId === '') return { success: false, error: 'Invalid projectId' };
    const handle = liveServers.get(projectId);
    if (handle === undefined) return { success: true };
    try {
      await handle.stop();
    } finally {
      liveServers.delete(projectId);
    }
    return { success: true };
  });

  // ── APO History / Diff (v0.11) ────────────────────
  ipcMain.handle(IPC.APO_LIST_OPTIMIZATIONS, async (_event, args: unknown) => {
    const a = (typeof args === 'object' && args !== null) ? args as Record<string, unknown> : {};
    const agentName = typeof a['agentName'] === 'string' && a['agentName'] !== '' ? a['agentName'] : undefined;
    const status = isOptimizationStatus(a['status']) ? a['status'] : undefined;
    const rawLimit = typeof a['limit'] === 'number' ? a['limit'] : undefined;
    try {
      const records = await listPromptOptimizations({ agentName, status, limit: rawLimit });
      return { success: true, records };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), records: [] };
    }
  });

  ipcMain.handle(IPC.APO_GET_OPTIMIZATION, async (_event, args: unknown) => {
    const id = typeof args === 'string'
      ? args
      : (typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>)['id'] === 'string')
        ? (args as Record<string, string>)['id']
        : '';
    if (id === '') return { success: false, error: 'Invalid id', record: null };
    try {
      const record = await getPromptOptimization(id);
      return { success: true, record };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), record: null };
    }
  });

  // ── APO Accept / Reject (v0.12 P4 — human-in-the-loop) ─────────────
  //
  // Accept: loads the proposed record, writes the optimized prompt into
  // the active preset JSON via applyWinner(), then flips status to
  // 'accepted'. A backup snapshot of the preset is created before the
  // write (see apply-winner.ts) — rollback stays possible via the APO
  // Rollback panel.
  //
  // Reject: flips status to 'rolled_back' without touching the preset.
  // The proposal never mutated a file, so there is nothing to undo.
  ipcMain.handle(IPC.APO_ACCEPT_OPTIMIZATION, async (_event, args: unknown) => {
    const id = typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>)['id'] === 'string'
      ? (args as Record<string, string>)['id']
      : typeof args === 'string' ? args : '';
    if (id === '') return { success: false, error: 'Invalid id', record: null };
    try {
      const record = await getPromptOptimization(id);
      if (record === null) {
        return { success: false, error: `Optimization ${id} not found`, record: null };
      }
      if (record.status !== 'proposed') {
        return {
          success: false,
          error: `Cannot accept optimization in status '${record.status}' — only 'proposed' rows can be accepted`,
          record,
        };
      }
      applyWinner({ agentName: record.agentName, winner: record.optimizedPrompt });
      const accepted = await markOptimizationAccepted(id);
      return { success: true, record: accepted };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), record: null };
    }
  });

  ipcMain.handle(IPC.APO_REJECT_OPTIMIZATION, async (_event, args: unknown) => {
    const id = typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>)['id'] === 'string'
      ? (args as Record<string, string>)['id']
      : typeof args === 'string' ? args : '';
    if (id === '') return { success: false, error: 'Invalid id', record: null };
    try {
      const record = await getPromptOptimization(id);
      if (record === null) {
        return { success: false, error: `Optimization ${id} not found`, record: null };
      }
      if (record.status !== 'proposed') {
        return {
          success: false,
          error: `Cannot reject optimization in status '${record.status}' — only 'proposed' rows can be rejected`,
          record,
        };
      }
      const rejected = await markOptimizationRolledBack(id);
      return { success: true, record: rejected };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), record: null };
    }
  });

  ipcMain.handle('command-center:project-dry-run', async (_event, name: unknown, description: unknown) => {
    if (typeof name !== 'string' || typeof description !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    // Dry-run path: invoke the CLI's preview logic without touching the DB.
    // The full heuristic lives in src/cli/headless-runner.ts; for MVP we
    // surface a minimal placeholder and let the existing CLI remain the
    // authoritative preview until the dry-run extraction (v0.9 phase 2).
    try {
      const lines: string[] = [
        `Dry run preview — ${name}`,
        `Description: ${description.slice(0, 200)}`,
        '',
        'Note: full cost preview is still CLI-only. Run:',
        `  npx tsx src/cli/headless-runner.ts --dry-run --name "${name}" --description "${description.replace(/"/g, '\\"')}"`,
      ];
      return { success: true, preview: lines.join('\n') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });

  // ── Project Start Split-Button (B-400) ────────────
  // Registers `project:start-dry-run` and `project:start-live-run`.
  // Streams progress to the renderer on `project:run-progress`.
  registerProjectStartHandlers({
    getOrchestrator: () => orchestrator,
    getCommandCenterWindow: () => getCommandCenterWindow(),
  });

  // ── Notifications ────────────────────────────
  ipcMain.handle('command-center:get-notifications', async () => {
    try {
      const { getMany } = await import('../db/client');
      const logs = await getMany<{
        id: string;
        agent: string;
        action: string;
        project_id: string | null;
        project_name: string | null;
        output_summary: string | null;
        event_type: string | null;
        created_at: string;
      }>(
        `SELECT a.id,
                a.agent,
                a.action,
                a.project_id,
                p.name AS project_name,
                a.output_summary,
                a.event_type,
                a.created_at
         FROM agent_logs a
         LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.event_type IN (
                 'task.completed', 'task.failed',
                 'approval.required', 'approval.granted',
                 'project.completed', 'project.cancelled'
               )
         ORDER BY a.created_at DESC
         LIMIT 50`
      );

      const titleFor = (eventType: string | null, agent: string): string => {
        const cap = (s: string): string => s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
        switch (eventType) {
          case 'task.completed':    return `${cap(agent)} finished a task`;
          case 'task.failed':       return `${cap(agent)} task failed`;
          case 'approval.required': return 'Approval needed';
          case 'approval.granted':  return 'Approval granted';
          case 'project.completed': return 'Project completed';
          case 'project.cancelled': return 'Project cancelled';
          default:                  return cap(agent);
        }
      };
      const typeFor = (eventType: string | null): 'info' | 'success' | 'warning' | 'error' => {
        switch (eventType) {
          case 'task.failed':       return 'error';
          case 'approval.required': return 'warning';
          case 'project.cancelled': return 'warning';
          case 'task.completed':
          case 'approval.granted':
          case 'project.completed': return 'success';
          default:                  return 'info';
        }
      };

      return logs.map((l) => ({
        id: l.id,
        type: typeFor(l.event_type),
        eventType: l.event_type,
        title: titleFor(l.event_type, l.agent),
        message: (l.output_summary ?? '').trim() !== ''
            ? l.output_summary!
            : l.action,
        agent: l.agent,
        projectId: l.project_id,
        projectName: l.project_name,
        timestamp: l.created_at,
        read: false,
      }));
    } catch {
      return [];
    }
  });

  // ── Model Config (v1.0) ───────────────────────

  ipcMain.handle('command-center:get-agent-model-configs', () => {
    try {
      const config = loadAppAgentConfig();
      return Object.entries(config.agents).map(([agentName, entry]) => ({
        name: agentName,
        model: entry.model,
        provider: entry.provider,
        fallbackModels: [...entry.fallbackModels],
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get agent model configs');
      return [];
    }
  });

  ipcMain.handle('command-center:set-agent-model', (_event, args: unknown) => {
    const parsed = SetAgentModelArgsSchema.safeParse(args);
    if (!parsed.success) {
      const msg = parsed.error.flatten().fieldErrors.agentName?.join(', ') ??
        parsed.error.flatten().fieldErrors.model?.join(', ') ??
        'Invalid arguments';
      return { success: false, error: msg };
    }
    try {
      const { agentName, model, provider, fallbackModels } = parsed.data;
      setAgentModelConfig(agentName, model, provider, fallbackModels);
      if (orchestrator !== null) {
        orchestrator.agentRegistry.reconfigureAgent(agentName, model, provider);
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to set agent model');
      return { success: false, error: msg };
    }
  });

  // ── Preset switcher (v1.6) ───────────────────────

  ipcMain.handle('command-center:list-presets', () => {
    try {
      return { presets: listPresets(), active: getActivePreset() };
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list presets');
      return { presets: [], active: null };
    }
  });

  ipcMain.handle('command-center:set-active-preset', (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null || !('preset' in args)) {
      return { success: false, error: 'Invalid arguments' };
    }
    const raw = (args as { preset: unknown }).preset;
    if (raw !== null && typeof raw !== 'string') {
      return { success: false, error: `Unknown preset: ${String(raw)}` };
    }
    // Reject names that aren't built-in AND have no preset file on disk —
    // protects against typos but still allows user-created presets.
    if (raw !== null && raw !== '') {
      const isBuiltIn = (PRESET_NAMES as readonly string[]).includes(raw);
      const presets = listPresets();
      const exists = presets.some((p) => p.name === raw && p.exists);
      if (!isBuiltIn && !exists) {
        return { success: false, error: `Preset "${raw}" does not exist.` };
      }
    }
    try {
      setActivePreset(raw === null || raw === '' ? null : raw);
      // Refresh every live agent's modelConfig so the preset switch takes
      // effect without an Electron restart. Sensei re-resolves per call via
      // its config closure, but specialists were constructed with a captured
      // modelConfig and need an explicit update.
      try {
        orchestrator?.agentRegistry.reloadAgentConfigsFromPreset();
      } catch (refreshErr) {
        const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        log.warn({ err: msg }, 'Preset changed but live agent refresh failed');
      }
      return { success: true, active: raw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to set active preset');
      return { success: false, error: msg };
    }
  });

  // ── Custom preset CRUD ─────────────────────────
  ipcMain.handle('command-center:create-preset', (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { success: false, error: 'Invalid arguments' };
    }
    const a = args as Record<string, unknown>;
    const name = typeof a['name'] === 'string' ? a['name'].trim() : '';
    const overwrite = a['overwrite'] === true;
    const agentsRaw = a['agents'];
    if (typeof agentsRaw !== 'object' || agentsRaw === null) {
      return { success: false, error: 'Missing agents map' };
    }

    // Normalise the agents payload — each entry must have model + provider.
    const agents: Record<string, { model: string; provider: string; fallbackModels: readonly string[] }> = {};
    for (const [k, v] of Object.entries(agentsRaw as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const e = v as Record<string, unknown>;
      const model = typeof e['model'] === 'string' ? e['model'].trim() : '';
      const provider = typeof e['provider'] === 'string' ? e['provider'].trim() : '';
      if (model === '' || provider === '') continue;
      const fallbackModels = Array.isArray(e['fallbackModels'])
        ? (e['fallbackModels'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      agents[k] = { model, provider, fallbackModels };
    }

    if (Object.keys(agents).length === 0) {
      return { success: false, error: 'At least one agent must be specified' };
    }

    const result = createPreset(name, { agents }, { overwrite });
    if (!result.ok) {
      return { success: false, error: result.error };
    }
    return { success: true, name };
  });

  ipcMain.handle('command-center:delete-preset', (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { success: false, error: 'Invalid arguments' };
    }
    const name = (args as Record<string, unknown>)['name'];
    if (typeof name !== 'string' || name === '') {
      return { success: false, error: 'Missing preset name' };
    }
    const result = deletePreset(name);
    if (!result.ok) return { success: false, error: result.error };
    // If the active preset was deleted (cleared inside deletePreset), live
    // agents should also drop back to defaults on next dispatch.
    try { orchestrator?.agentRegistry.reloadAgentConfigsFromPreset(); } catch { /* ignore */ }
    return { success: true };
  });

  // Read a single preset's agents map (for "duplicate from existing").
  ipcMain.handle('command-center:get-preset', async (_event, args: unknown) => {
    const name = typeof args === 'object' && args !== null
      ? (args as Record<string, unknown>)['name']
      : args;
    if (typeof name !== 'string' || name === '') {
      return { success: false, error: 'Missing preset name' };
    }
    try {
      const filePath = path.join(
        process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops'),
        `agent-config.${name}.json`,
      );
      const fs = await import('fs');
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `Preset "${name}" does not exist.` };
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return { success: true, config: parsed };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Design provider switcher (v2.5) ──────────────
  //
  // The "claude-ui" provider is our own Sonnet-with-design-prompt wrapper,
  // distinct from Anthropic's claude.ai/design product (web-only, no API).
  // Switching providers only affects newly-constructed Pixel instances —
  // existing agents keep their provider until next restart.

  ipcMain.handle('command-center:list-design-providers', () => {
    try {
      return { providers: listDesignProviders(), active: getActiveDesignProvider() };
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list design providers');
      return { providers: [], active: 'in-house' };
    }
  });

  ipcMain.handle('command-center:set-active-design-provider', (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null || !('providerId' in args)) {
      return { success: false, error: 'Invalid arguments' };
    }
    const raw = (args as { providerId: unknown }).providerId;
    if (typeof raw !== 'string' || !(DESIGN_PROVIDER_IDS as readonly string[]).includes(raw)) {
      return { success: false, error: `Unknown design provider: ${String(raw)}` };
    }
    try {
      setActiveDesignProvider(raw as DesignProviderId);
      return { success: true, active: raw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to set active design provider');
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('command-center:test-agent-model', (_event, args: unknown) => {
    const parsed = TestAgentModelArgsSchema.safeParse(args);
    if (!parsed.success) {
      const msg = parsed.error.flatten().fieldErrors.agentName?.join(', ') ??
        parsed.error.flatten().fieldErrors.model?.join(', ') ??
        'Invalid arguments';
      return { success: false, error: msg };
    }
    // Real connectivity ping is a future enhancement — return mock success
    return { success: true, latencyMs: 0 };
  });

  // ── Deployments (v1.1) ───────────────────────

  ipcMain.handle('deployments:get', () => {
    return getSettings().deployments ?? [];
  });

  ipcMain.handle('deployments:save', (_event, target: unknown) => {
    const parsed = SaveDeploymentArgsSchema.safeParse(target);
    if (!parsed.success) {
      const msg = Object.values(parsed.error.flatten().fieldErrors).flat().join(', ') || 'Invalid deployment target';
      log.warn({ errors: parsed.error.flatten() }, 'Invalid deployments:save args — rejecting');
      return { success: false, error: msg };
    }
    try {
      const current = getSettings().deployments ?? [];
      const existing = current.findIndex((d) => d.id === parsed.data.id);
      const updated = existing >= 0
        ? [...current.slice(0, existing), parsed.data, ...current.slice(existing + 1)]
        : [...current, parsed.data];
      updateSettings({ deployments: updated });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to save deployment target');
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('deployments:delete', (_event, args: unknown) => {
    const parsed = DeleteDeploymentArgsSchema.safeParse(args);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.flatten() }, 'Invalid deployments:delete args — rejecting');
      return { success: false, error: 'Invalid id' };
    }
    try {
      const current = getSettings().deployments ?? [];
      const updated = current.filter((d) => d.id !== parsed.data.id);
      updateSettings({ deployments: updated });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to delete deployment target');
      return { success: false, error: msg };
    }
  });

  // ── Bundle discovery (Pillar 2.2 PR-B.2 / D-A) ─────────
  //
  // Renderer needs the bundle list to populate the New-Project type
  // picker + drive the Deployment Configuration section. Slimmed-down
  // projection so prompt/scaffold internals don't cross the IPC boundary.
  ipcMain.handle(IPC.LIST_BUNDLES, async () => {
    try {
      const { loadBundles } = await import('../bundles/bundle-loader');
      const result = await loadBundles();
      const bundles = result.bundles.map((b) => ({
        name: b.manifest.name,
        kind: b.manifest.kind,
        description: b.manifest.description,
        deployment: b.manifest.deployment ?? null,
      }));
      return { success: true, bundles };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'bundles:list failed');
      return { success: false, error: msg, bundles: [] };
    }
  });

  // CORE — Vercel token (keychain) + vendor-URL deploy-key handlers, so the
  // New Project modal's deployment section works in the open build too.
  registerDeployKeyHandlers();
  // COMMERCIAL — encrypted deployment_config app-secret store (no-op in open).
  commercialExtensions.registerDeployConfigHandlers?.();

  // ── APO Rollback (B-478) ─────────────────────

  ipcMain.handle('apo:list-backups', async () => {
    try {
      const { listApoBackups } = await import('../learning/rollback');
      const entries = listApoBackups();
      return { success: true, entries };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to list APO backups');
      return { success: false, error: msg, entries: [] };
    }
  });

  ipcMain.handle('apo:restore-backup', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) {
      return { success: false, error: 'Invalid args' };
    }
    const backupPath = (args as Record<string, unknown>)['backupPath'];
    if (typeof backupPath !== 'string' || backupPath === '') {
      return { success: false, error: 'backupPath is required' };
    }
    try {
      const { restoreApoBackup } = await import('../learning/rollback');
      const result = restoreApoBackup({ backupPath });
      return { success: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, backupPath }, 'Failed to restore APO backup');
      return { success: false, error: msg };
    }
  });

  // ── Task Output Viewer (v0.9) ─────────────────

  ipcMain.handle('command-center:get-project-tasks', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return [];
    try {
      const { getMany } = await import('../db/client');
      return await getMany<{
        id: string; title: string; task_type: string; assigned_agent: string;
        status: string; output_path: string | null; response_text: string | null;
        phase: string; priority: number; completed_at: string | null;
      }>(
        `SELECT id, title, task_type, assigned_agent, status, output_path,
                response_text, phase, priority, completed_at
         FROM tasks WHERE project_id = $1 ORDER BY priority DESC, created_at ASC`,
        [projectId]
      );
    } catch {
      return [];
    }
  });

  ipcMain.handle('command-center:get-task-output', async (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') return null;
    try {
      const { getOne } = await import('../db/client');
      const task = await getOne<{
        output_path: string | null; assigned_agent: string; title: string;
        response_text: string | null;
      }>(
        'SELECT output_path, assigned_agent, title, response_text FROM tasks WHERE id = $1',
        [taskId]
      );
      if (task === null) return null;

      // Prefer output file content; fall back to stored response_text (B3)
      if (task.output_path !== null) {
        // output_path is relative to the project repo — find the project
        const taskWithProject = await getOne<{ repo_path: string }>(
          `SELECT p.repo_path FROM projects p
           JOIN tasks t ON t.project_id = p.id
           WHERE t.id = $1`,
          [taskId]
        );
        if (taskWithProject !== null) {
          try {
            const fs = await import('fs/promises');
            const path = await import('path');
            const absPath = path.join(taskWithProject.repo_path, task.output_path);
            const content = await fs.readFile(absPath, 'utf-8');
            return { title: task.title, agent: task.assigned_agent, path: task.output_path, content };
          } catch {
            // File not readable — fall through to response_text
          }
        }
      }

      // Fall back to stored AI response text
      if (task.response_text !== null) {
        return { title: task.title, agent: task.assigned_agent, path: null, content: task.response_text };
      }

      return null;
    } catch {
      return null;
    }
  });

  // ── Task Checkpoints (P1-01f) ─────────────────
  // Read-only: returns the per-op checkpoint timeline for a task so
  // the Autonauts detail panel can render it. Safe to call when
  // checkpoints are disabled — the table may simply return [].
  ipcMain.handle('command-center:get-task-checkpoints', async (_event, taskId: unknown) => {
    if (typeof taskId !== 'string' || taskId === '') return [];
    try {
      const { taskCheckpointRepository } = await import('../db/task-checkpoint-repo');
      const rows = await taskCheckpointRepository.listForTask(taskId);
      // Strip the JSONB payload/output bodies — they can be large
      // (full askAI responses for askai rows) and the timeline only
      // needs the metadata. Callers that want the body can fetch via
      // a future detail endpoint.
      return rows.map((r) => ({
        id: r.id,
        opIndex: r.opIndex,
        opType: r.opType,
        status: r.status,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        errorText: r.errorText,
        // Only surface a small metadata projection per op_type so the
        // UI can render context (filePath for write, command for exec,
        // model for askai) without shipping kilobytes per row.
        meta: pickCheckpointMeta(r.opType, r.payloadJson, r.outputJson),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[main] get-task-checkpoints failed for ${taskId}: ${msg}`);
      return [];
    }
  });

  // ── Agent Stream History ──────────────────────
  // Seed the Live Intercept panel with recent ai-exchange events when
  // the user clicks an agent — without this the panel sits on the
  // "Waiting for agent output…" placeholder until the next live tick.
  ipcMain.handle('command-center:get-agent-stream-history', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return [];
    const a = args as Record<string, unknown>;
    const agent = typeof a['agent'] === 'string' ? a['agent'] : '';
    const taskId = typeof a['taskId'] === 'string' ? a['taskId'] : null;
    const limit = typeof a['limit'] === 'number' && a['limit'] > 0 ? Math.min(Math.floor(a['limit']), 200) : 50;
    if (agent === '') return [];
    try {
      const { getMany } = await import('../db/client');
      const rows = await getMany<{
        agent: string;
        action: string;
        task_id: string | null;
        project_id: string | null;
        event_type: string | null;
        output_summary: string | null;
        metadata: unknown;
        created_at: string;
      }>(
        `SELECT agent, action, task_id, project_id, event_type, output_summary,
                metadata, created_at
         FROM agent_logs
         WHERE LOWER(agent) = LOWER($1)
           AND ($2::uuid IS NULL OR task_id = $2)
           AND event_type IN ('agent.stream', 'task.completed', 'task.started', 'task.failed', 'review.passed', 'review.failed')
         ORDER BY created_at DESC
         LIMIT $3`,
        [agent, taskId, limit],
      );
      // Newest-first → reverse so the panel shows oldest first (chronological).
      const sorted = rows.slice().reverse();
      return sorted.map((r) => {
        let meta: Record<string, unknown> = {};
        if (typeof r.metadata === 'string') {
          try { meta = JSON.parse(r.metadata) as Record<string, unknown>; } catch { /* ignore */ }
        } else if (typeof r.metadata === 'object' && r.metadata !== null) {
          meta = r.metadata as Record<string, unknown>;
        }
        return {
          time: r.created_at,
          agent: r.agent,
          taskId: r.task_id,
          projectId: r.project_id,
          data: {
            type: typeof meta['type'] === 'string' ? meta['type'] : (r.event_type ?? 'event'),
            ...meta,
            message: meta['message'] ?? r.output_summary,
          },
        };
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'get-agent-stream-history failed');
      return [];
    }
  });

  // ── Agent Detail Panel (v1.1) ─────────────────

  ipcMain.handle('command-center:get-agent-detail', async (_event, agentName: unknown, projectId: unknown) => {
    if (typeof agentName !== 'string') return null;
    try {
      const { getOne, getMany } = await import('../db/client');

      // Get agent status from registry
      const agent = orchestrator?.agentRegistry.getAgent(agentName) ?? undefined;
      if (agent === undefined) return null;

      // Resolve project scope — explicit projectId > current task's project >
      // latest non-archived project. Agent activity is always scoped to a project
      // so stale archived runs don't leak into the detail view.
      let scopeProjectId: string | null = typeof projectId === 'string' && projectId !== '' ? projectId : null;
      if (scopeProjectId === null && agent.currentTask !== null) {
        const cur = await getOne<{ project_id: string }>(
          'SELECT project_id FROM tasks WHERE id = $1',
          [agent.currentTask.id]
        );
        scopeProjectId = cur?.project_id ?? null;
      }
      if (scopeProjectId === null) {
        const latest = await getOne<{ id: string }>(
          `SELECT id FROM projects
           WHERE status NOT IN ('archived', 'expired')
           ORDER BY created_at DESC LIMIT 1`
        );
        scopeProjectId = latest?.id ?? null;
      }

      // Current task
      const currentTaskRow = agent.currentTask !== null
        ? await getOne<{
            id: string; title: string; task_type: string; phase: string;
            status: string; started_at: string | null; output_path: string | null;
          }>(
            `SELECT id, title, task_type, phase, status, started_at, output_path
             FROM tasks WHERE id = $1`,
            [agent.currentTask.id]
          )
        : null;

      const currentTask = currentTaskRow !== null ? {
        id: currentTaskRow.id,
        title: currentTaskRow.title,
        taskType: currentTaskRow.task_type,
        phase: currentTaskRow.phase,
        status: currentTaskRow.status,
        startedAt: currentTaskRow.started_at,
        completedAt: null,
        qualityScore: null,
        hasOutput: false,
        responseText: null,
        outputPath: currentTaskRow.output_path,
      } : null;

      // Recent completed/failed tasks (last 10) — scoped to current project
      const recentRows = scopeProjectId !== null
        ? await getMany<{
            id: string; title: string; task_type: string; phase: string;
            status: string; started_at: string | null; completed_at: string | null;
            quality_score: number | null; output_path: string | null;
            response_text: string | null;
          }>(
            `SELECT id, title, task_type, phase, status, started_at, completed_at,
                    quality_score, output_path, response_text
             FROM tasks
             WHERE assigned_agent = $1
               AND project_id = $2
               AND status IN ('completed', 'failed')
             ORDER BY completed_at DESC NULLS LAST
             LIMIT 10`,
            [agentName, scopeProjectId]
          )
        : [];

      const recentTasks = recentRows.map((r) => ({
        id: r.id,
        title: r.title,
        taskType: r.task_type,
        phase: r.phase,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        qualityScore: r.quality_score !== null ? Number(r.quality_score) : null,
        hasOutput: r.response_text !== null || r.output_path !== null,
        responseText: r.response_text,
        outputPath: r.output_path,
      }));

      // Stats — scoped to current project when known
      const statsRow = scopeProjectId !== null
        ? await getOne<{
            total_completed: string; total_failed: string; avg_quality: string | null;
          }>(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'completed') AS total_completed,
               COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
               AVG(quality_score) FILTER (WHERE status = 'completed') AS avg_quality
             FROM tasks WHERE assigned_agent = $1 AND project_id = $2`,
            [agentName, scopeProjectId]
          )
        : null;

      const agentCfg = loadAppAgentConfig().agents[agentName];
      return {
        name: agent.name,
        role: agent.role,
        status: agent.status,
        model: agentCfg?.model ?? null,
        provider: agentCfg?.provider ?? null,
        currentTask,
        recentTasks,
        stats: {
          totalCompleted: parseInt(statsRow?.total_completed ?? '0', 10),
          totalFailed: parseInt(statsRow?.total_failed ?? '0', 10),
          avgQualityScore: statsRow?.avg_quality !== null && statsRow?.avg_quality !== undefined
            ? parseFloat(statsRow.avg_quality)
            : null,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get agent detail');
      return null;
    }
  });

  // ── Team Members (C1) ─────────────────────────

  ipcMain.handle('command-center:get-team-members', async () => {
    try {
      const { getMany } = await import('../db/client');
      return await getMany<{ id: string; name: string; email: string; role: string; status: string; avatar_url: string | null; created_at: string }>(
        `SELECT id, name, email, role, status, avatar_url, created_at FROM team_members WHERE status = 'active' ORDER BY name`
      );
    } catch { return []; }
  });

  ipcMain.handle('command-center:add-team-member', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { name, email, role } = args as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') return { success: false, error: 'Name required' };
    if (typeof email !== 'string' || !email.includes('@')) return { success: false, error: 'Valid email required' };
    const safeRole = typeof role === 'string' && ['member', 'lead', 'observer'].includes(role) ? role : 'member';
    try {
      const { getOne } = await import('../db/client');
      const row = await getOne<{ id: string }>(
        `INSERT INTO team_members (name, email, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET name = $1, role = $3, status = 'active' RETURNING id`,
        [name.trim(), email.trim().toLowerCase(), safeRole]
      );
      return { success: true, id: row?.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to add team member');
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('command-center:remove-team-member', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { success: false, error: 'Invalid id' };
    try {
      const { query } = await import('../db/client');
      await query(`UPDATE team_members SET status = 'inactive' WHERE id = $1`, [id]);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to remove team member');
      return { success: false, error: msg };
    }
  });

  // ── Agent Management (C2) ─────────────────────

  ipcMain.handle('command-center:get-agent-configs', async () => {
    try {
      if (orchestrator === null) return [];
      const { loadAppAgentConfig } = await import('../main/app-config-store');
      const appConfig = loadAppAgentConfig();
      return orchestrator.agentRegistry.getAllAgents().map((a) => {
        const mc = appConfig.agents[a.name];
        return {
          name: a.name,
          role: a.role,
          status: a.status,
          model: mc?.model ?? 'ollama/gpt-oss:120b-cloud',
          enabled: true,
        };
      });
    } catch { return []; }
  });

  ipcMain.handle('command-center:set-agent-enabled', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false };
    const { agentName, enabled } = args as Record<string, unknown>;
    if (typeof agentName !== 'string' || typeof enabled !== 'boolean') return { success: false };
    try {
      const { query } = await import('../db/client');
      await query(
        `INSERT INTO speciality_matrix (agent, skill, score, enabled)
         VALUES ($1, 'general', 5.0, $2)
         ON CONFLICT (agent, skill) DO UPDATE SET enabled = $2`,
        [agentName, enabled]
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Agent Intercept (v2.3) ─────────────────────

  ipcMain.handle('command-center:pause-agent', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { agentName, taskId } = args as Record<string, unknown>;
    if (typeof agentName !== 'string' || typeof taskId !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (orchestrator === null) return { success: false, error: 'Orchestrator not running' };
    try {
      await orchestrator.sensei.pauseAgent(agentName, taskId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:resume-agent', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { agentName, taskId } = args as Record<string, unknown>;
    if (typeof agentName !== 'string' || typeof taskId !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (orchestrator === null) return { success: false, error: 'Orchestrator not running' };
    try {
      await orchestrator.sensei.resumeAgent(agentName, taskId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:inject-guidance', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { agentName, taskId, guidance } = args as Record<string, unknown>;
    if (typeof agentName !== 'string' || typeof taskId !== 'string' || typeof guidance !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (guidance.length > 6000) {
      return { success: false, error: 'Guidance too long (max 6000 chars)' };
    }
    if (orchestrator === null) return { success: false, error: 'Orchestrator not running' };
    try {
      await orchestrator.sensei.injectGuidance(agentName, taskId, guidance);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:takeover-task', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { agentName, taskId } = args as Record<string, unknown>;
    if (typeof agentName !== 'string' || typeof taskId !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (orchestrator === null) return { success: false, error: 'Orchestrator not running' };
    try {
      await orchestrator.sensei.takeoverTask(agentName, taskId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:handback-task', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { taskId, agentName, guidance } = args as Record<string, unknown>;
    if (typeof taskId !== 'string' || typeof agentName !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (orchestrator === null) return { success: false, error: 'Orchestrator not running' };
    try {
      await orchestrator.sensei.handbackTask(
        taskId,
        agentName,
        typeof guidance === 'string' ? guidance : undefined,
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Document Upload (E1) ───────────────────────

  ipcMain.handle('command-center:get-project-documents', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return [];
    try {
      const { getMany, getOne } = await import('../db/client');
      const dbDocs = await getMany<{ id: string; file_name: string; file_path: string; file_size: number; mime_type: string; created_at: string }>(
        `SELECT id, file_name, file_path, file_size, mime_type, created_at
         FROM project_documents WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId]
      );

      // Auto-discover markdown docs produced by agents on the filesystem so
      // the KB doesn't look empty when the project has only written artifacts
      // (no explicit uploads). These live under {repo_path}/docs/**/*.md and
      // are surfaced with synthetic fs:<relPath> ids.
      const project = await getOne<{ repo_path: string | null }>(
        'SELECT repo_path FROM projects WHERE id = $1', [projectId]
      );
      const fsDocs: { id: string; file_name: string; file_path: string; file_size: number; mime_type: string; created_at: string }[] = [];
      if (project !== null && project.repo_path !== null) {
        try {
          const nodeFs = await import('fs');
          const nodePath = await import('path');
          const docsRoot = nodePath.join(project.repo_path, 'docs');

          const walk = async (dir: string, relBase: string): Promise<void> => {
            let entries: import('fs').Dirent[];
            try {
              entries = await nodeFs.promises.readdir(dir, { withFileTypes: true });
            } catch { return; }
            for (const entry of entries) {
              const abs = nodePath.join(dir, entry.name);
              const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
              if (entry.isDirectory()) {
                // Skip uploads — already tracked in project_documents.
                if (rel === 'uploads' || rel.startsWith('uploads/')) continue;
                await walk(abs, rel);
              } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                try {
                  const stat = await nodeFs.promises.stat(abs);
                  fsDocs.push({
                    id: `fs:docs/${rel}`,
                    file_name: entry.name,
                    file_path: `docs/${rel}`,
                    file_size: stat.size,
                    mime_type: 'text/markdown',
                    created_at: stat.mtime.toISOString(),
                  });
                } catch { /* skip unreadable */ }
              }
            }
          };
          await walk(docsRoot, '');
        } catch { /* no docs dir yet — fine */ }
      }

      // Newest first: merge + sort by created_at desc.
      return [...dbDocs, ...fsDocs].sort((a, b) => b.created_at.localeCompare(a.created_at));
    } catch { return []; }
  });

  ipcMain.handle('command-center:get-project-document-content', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { projectId, documentId } = args as Record<string, unknown>;
    if (typeof projectId !== 'string' || typeof documentId !== 'string') {
      return { success: false, error: 'projectId and documentId required' };
    }
    try {
      const { getOne } = await import('../db/client');
      const project = await getOne<{ repo_path: string | null }>(
        'SELECT repo_path FROM projects WHERE id = $1', [projectId]
      );
      if (project === null || project.repo_path === null) {
        return { success: false, error: 'Project not found or has no workspace' };
      }

      const nodeFs = await import('fs');
      const nodePath = await import('path');

      // Two id shapes: uuid → project_documents row; fs:<relPath> → filesystem.
      let relPath: string;
      if (documentId.startsWith('fs:')) {
        relPath = documentId.slice('fs:'.length);
      } else {
        const row = await getOne<{ file_path: string; mime_type: string }>(
          'SELECT file_path, mime_type FROM project_documents WHERE id = $1 AND project_id = $2',
          [documentId, projectId]
        );
        if (row === null) return { success: false, error: 'Document not found' };
        if (!row.mime_type.startsWith('text/') && row.mime_type !== 'application/json') {
          return { success: false, error: 'binary', mimeType: row.mime_type };
        }
        relPath = row.file_path;
      }

      // Path traversal guard — resolved file must live under repo_path.
      const abs = nodePath.resolve(project.repo_path, relPath);
      const repoAbs = nodePath.resolve(project.repo_path);
      if (!abs.startsWith(repoAbs + nodePath.sep) && abs !== repoAbs) {
        return { success: false, error: 'path outside workspace' };
      }

      const content = await nodeFs.promises.readFile(abs, 'utf8');
      return { success: true, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('command-center:upload-document', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { projectId, fileName, fileData, mimeType } = args as Record<string, unknown>;
    if (typeof projectId !== 'string' || typeof fileName !== 'string' || typeof fileData !== 'string') {
      return { success: false, error: 'projectId, fileName, and fileData required' };
    }
    const allowed = ['.pdf', '.md', '.txt', '.docx', '.csv', '.json'];
    const nodePath = await import('path');
    const ext = nodePath.extname(fileName).toLowerCase();
    if (!allowed.includes(ext)) {
      return { success: false, error: `File type ${ext} not allowed. Allowed: ${allowed.join(', ')}` };
    }
    try {
      const { getOne, query: dbQuery } = await import('../db/client');
      const project = await getOne<{ repo_path: string }>(
        'SELECT repo_path FROM projects WHERE id = $1', [projectId]
      );
      if (project === null) return { success: false, error: 'Project not found' };

      const nodeFs = await import('fs');
      const docsDir = nodePath.join(project.repo_path, 'docs', 'uploads');
      await nodeFs.promises.mkdir(docsDir, { recursive: true });
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = nodePath.join(docsDir, safeName);
      const buffer = Buffer.from(fileData, 'base64');
      await nodeFs.promises.writeFile(destPath, buffer);

      const relPath = nodePath.join('docs', 'uploads', safeName);
      const row = await getOne<{ id: string }>(
        `INSERT INTO project_documents (project_id, file_name, file_path, file_size, mime_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [projectId, safeName, relPath, buffer.length, typeof mimeType === 'string' ? mimeType : 'application/octet-stream']
      );
      return { success: true, id: row?.id, path: relPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('command-center:delete-document', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false };
    const { id, projectId } = args as Record<string, unknown>;
    if (typeof id !== 'string' || typeof projectId !== 'string') return { success: false };
    try {
      const { getOne, query: dbQuery } = await import('../db/client');
      const doc = await getOne<{ file_path: string }>(
        'SELECT file_path FROM project_documents WHERE id = $1 AND project_id = $2',
        [id, projectId]
      );
      if (doc === null) return { success: false, error: 'Document not found' };

      const project = await getOne<{ repo_path: string }>(
        'SELECT repo_path FROM projects WHERE id = $1', [projectId]
      );
      if (project !== null) {
        const nodePath = await import('path');
        const nodeFs = await import('fs');
        const absPath = nodePath.join(project.repo_path, doc.file_path);
        try { await nodeFs.promises.unlink(absPath); } catch { /* ignore missing file */ }
      }

      await dbQuery('DELETE FROM project_documents WHERE id = $1', [id]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Phase Graph (RAG) ─────────────────────────

  ipcMain.handle('command-center:get-phase-graph', async (_event, projectId: unknown) => {
    const pid = typeof projectId === 'string' ? projectId : null;
    try {
      const { getMany } = await import('../db/client');

      const phases = ['discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth'];

      let phaseCounts: readonly { phase: string; total: string; completed: string; failed: string }[] = [];
      if (pid !== null) {
        phaseCounts = await getMany<{ phase: string; total: string; completed: string; failed: string }>(
          `SELECT phase,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
           FROM tasks WHERE project_id = $1 GROUP BY phase`,
          [pid]
        );
      }

      const agentTaskRows = pid !== null ? await getMany<{
        assigned_agent: string; title: string; status: string; phase: string; id: string;
      }>(
        `SELECT assigned_agent, title, status, phase, id FROM tasks
         WHERE project_id = $1 AND status IN ('assigned', 'completed', 'failed')
         ORDER BY created_at DESC`,
        [pid]
      ) : [];

      const recentTasks = pid !== null ? await getMany<{
        id: string; title: string; status: string; phase: string; assigned_agent: string;
        started_at: string | null; completed_at: string | null;
      }>(
        `SELECT id, title, status, phase, assigned_agent, started_at, completed_at
         FROM tasks WHERE project_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [pid]
      ) : [];

      return { phases, phaseCounts, agentTaskRows, recentTasks };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get phase graph data');
      return { phases: [], phaseCounts: [], agentTaskRows: [], recentTasks: [] };
    }
  });

  // ── System Status (v1.0) ──────────────────────

  ipcMain.handle('command-center:get-system-status', async () => {
    try {
      const dbConnected = orchestrator !== null;
      const orchestratorRunning = orchestrator !== null;
      const activeAgents = orchestrator?.agentRegistry
        .getAllAgents()
        .filter((a) => a.status === 'busy').length ?? 0;

      let totalProjects = 0;
      try {
        const { getMany } = await import('../db/client');
        const rows = await getMany<{ count: string }>(
          'SELECT COUNT(*) AS count FROM projects'
        );
        totalProjects = parseInt(rows[0]?.count ?? '0', 10) || 0;
      } catch {
        totalProjects = 0;
      }

      return {
        dbConnected,
        orchestratorRunning,
        activeAgents,
        totalProjects,
        version: app.getVersion(),
        bootstrapError: orchestrator === null ? getLastBootstrapError() : null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Failed to get system status');
      return {
        dbConnected: false,
        orchestratorRunning: false,
        activeAgents: 0,
        totalProjects: 0,
        version: app.getVersion(),
        bootstrapError: getLastBootstrapError() ?? msg,
      };
    }
  });
}

// ── Configuration Module IPC ─────────────────────────

const KNOWN_PROVIDERS = ['claude', 'openrouter', 'openai', 'gemini', 'ollama', 'github'] as const;
const KNOWN_ENV_VARS = [
  // Core paths + DB
  'KAGEOPS_PROJECTS_DIR',
  'KAGEOPS_DATA_DIR',
  'KAGEOPS_MAX_CONCURRENCY',
  'DATABASE_URL',
  // Cost guardrails
  'KAGEOPS_MAX_RUN_USD',
  'KAGEOPS_MAX_AI_CALLS_PER_TASK',
  'KAGEOPS_HEADLESS_TIMEOUT_MS',
  'KAGEOPS_ZOMBIE_TIMEOUT_MS',
  // Routing — preset + design provider
  'KAGEOPS_PRESET',
  'KAGEOPS_DESIGN_PROVIDER',
  'KAGEOPS_CLAUDE_UI_MODEL',
  'KAGEOPS_CLAUDE_UI_MAX_TOKENS',
  'KAGEOPS_OPENAI_UI_MODEL',
  'KAGEOPS_OPENAI_UI_MAX_TOKENS',
  // Behavior toggles
  'KAGEOPS_DISABLE_GIT',
  'KAGEOPS_DRY_RUN',
  'KAGEOPS_DB_MODE',
  'KAGEOPS_SKILLS_HOOKS',
  // APO — opt-in nightly loop
  'KAGEOPS_APO_ENABLED',
  'KAGEOPS_APO_EVAL_MODEL',
  'KAGEOPS_APO_MUTATOR_MODEL',
  'KAGEOPS_APO_MIN_DELTA',
] as const;
const KNOWN_AGENT_NAMES = ['sensei', 'scout', 'blueprint', 'forge', 'vigil', 'aegis', 'pixel', 'cipher', 'herald'] as const;
type KnownProvider = typeof KNOWN_PROVIDERS[number];
type KnownEnvVar = typeof KNOWN_ENV_VARS[number];
type KnownAgentName = typeof KNOWN_AGENT_NAMES[number];

const PROVIDER_LABELS_CONFIG: Record<KnownProvider, string> = {
  claude: 'Claude',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama (Local)',
  github: 'GitHub',
};

// F-382 (Mac EROFS): used to be a Windows-only hardcoded path
// `C:\projects\playground\kageops\.env` — on macOS the C: drive doesn't
// exist so writes to this path threw EROFS. Use the cross-platform
// per-user .env path under ~/.kageops/, matching KAGEOPS_DATA_DIR's
// default layout. Honour KAGEOPS_DATA_DIR override when set so the
// .env tracks the data dir.
const ENV_FILE_PATH = (() => {
  const dataDir = process.env['KAGEOPS_DATA_DIR'];
  if (dataDir !== undefined && dataDir !== '') {
    return path.join(dataDir, '.env');
  }
  return path.join(os.homedir(), '.kageops', '.env');
})();

function setupConfigIPC(): void {
  // ── app:commercial-available ───────────────────────
  // True only when the commercial layer loaded (KageOps Cloud). In the open
  // build `loadCommercialExtensions()` returns `noopCommercialExtensions`, so
  // this is false and the renderer hides the commercial-only UI (Team,
  // Connectors, Cloud Burst, Deployments) + the plan/sign-out menu items.
  ipcMain.handle('app:commercial-available', () => commercialExtensions !== noopCommercialExtensions);

  // ── config:get-snapshot ───────────────────────
  ipcMain.handle('config:get-snapshot', async () => {
    const { getSecret, shouldAllowEnvKeyFallback } = await import('./secret-store');
    const agentConfig = loadAppAgentConfig();

    // F-313: distinguish keychain-stored keys from env vars at the IPC
    // layer so the UI can show what's *actually* used at runtime, not just
    // what's *present* somewhere. Previously `getApiKey()` collapsed both
    // sources into a single string; the badge logic then over-reported
    // env-var presence as the active source even when keychain was winning.
    const SERVICE = 'kageops';
    const accountMap: Partial<Record<KnownProvider, string>> = {
      claude: 'anthropic-api-key',
      openrouter: 'openrouter-api-key',
      openai: 'openai-api-key',
      gemini: 'gemini-api-key',
      ollama: 'ollama-api-key',
      github: 'github-pat',
    };
    const envMap: Partial<Record<KnownProvider, string>> = {
      claude: 'ANTHROPIC_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GOOGLE_API_KEY',
      ollama: 'OLLAMA_API_KEY',
      github: 'GITHUB_TOKEN',
    };
    const envFallbackEnabled = shouldAllowEnvKeyFallback();

    const providers: Record<string, {
      hasKey: boolean;
      // 'keychain' = user-stored value is the live one
      // 'env' = env var is the live one (only when keychain empty + fallback enabled)
      // 'env-shadowed' = env var is set but keychain wins → UI shows safe state
      // 'none' = no key found anywhere
      source: 'keychain' | 'env' | 'env-shadowed' | 'none';
      label: string;
      envVarName?: string;
      envVarPresent: boolean;
      envFallbackEnabled: boolean;
    }> = {};
    for (const p of KNOWN_PROVIDERS) {
      const envVar = envMap[p];
      const account = accountMap[p];
      const envValue = envVar !== undefined ? process.env[envVar] : undefined;
      const envPresent = envValue !== undefined && envValue !== '';

      // Raw keychain check — does NOT fall back to env, so we know what's
      // actually stored vs. what's only inherited from the environment.
      const keychainValue = account !== undefined
        ? await getSecret(SERVICE, account).catch(() => null)
        : null;
      const keychainPresent = keychainValue !== null && keychainValue !== '';

      let source: 'keychain' | 'env' | 'env-shadowed' | 'none' = 'none';
      let hasKey = false;
      if (keychainPresent) {
        hasKey = true;
        // Keychain wins at runtime. If env is also set, mark 'env-shadowed'
        // so the UI can offer "remove env var" guidance — but the active
        // value is still keychain.
        source = envPresent ? 'env-shadowed' : 'keychain';
      } else if (envPresent && envFallbackEnabled) {
        hasKey = true;
        source = 'env';
      } else if (envPresent && !envFallbackEnabled) {
        // Env var set but ignored by runtime (decision #74). Treat as 'none'
        // because the provider call WILL fail. UI surfaces this as a special
        // warning state via envVarPresent + envFallbackEnabled flags.
        hasKey = false;
        source = 'none';
      }

      const entry: {
        hasKey: boolean;
        source: 'keychain' | 'env' | 'env-shadowed' | 'none';
        label: string;
        envVarName?: string;
        envVarPresent: boolean;
        envFallbackEnabled: boolean;
      } = {
        hasKey,
        source,
        label: PROVIDER_LABELS_CONFIG[p],
        envVarPresent: envPresent,
        envFallbackEnabled,
      };
      if (envVar !== undefined) entry.envVarName = envVar;
      providers[p] = entry;
    }

    const agents: Record<string, { model: string; provider: string; fallbackModels: string[] }> = {};
    for (const name of KNOWN_AGENT_NAMES) {
      const entry = agentConfig.agents[name];
      agents[name] = {
        model: entry?.model ?? 'claude-sonnet-4-6',
        provider: entry?.provider ?? 'claude',
        fallbackModels: entry !== undefined ? [...entry.fallbackModels] : [],
      };
    }

    // Auto-derive from the typed allow-list — keeps additions in
    // KNOWN_ENV_VARS in sync with the snapshot without a second list.
    const envVars = Object.fromEntries(
      KNOWN_ENV_VARS.map((k) => [k, process.env[k] ?? null] as const),
    ) as Record<KnownEnvVar, string | null>;

    return { providers, agents, envVars };
  });

  // ── config:save-api-key ───────────────────────
  ipcMain.handle('config:save-api-key', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { provider, key } = args as Record<string, unknown>;
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.includes(provider as KnownProvider)) {
      return { success: false, error: 'Unknown provider' };
    }
    if (typeof key !== 'string' || key.trim() === '') {
      return { success: false, error: 'Key must be a non-empty string' };
    }
    try {
      const { setApiKey: storeApiKey } = await import('./secret-store');
      await storeApiKey(provider as KnownProvider, key.trim());
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── updates:get-status (F-322 / decision #76) ─
  // Single endpoint the renderer hits to populate the Settings → Updates UI:
  // current toggle state, last successful check, current app version, and
  // whether updates are even possible (packaged vs dev).
  ipcMain.handle('updates:get-status', async () => {
    const s = getSettings();
    // F-395: route channel resolution through the auto-updater helper so
    // the UI matches what the runtime is actually polling. Previously
    // this endpoint hard-coded `env ?? 'latest'`, which is exactly the
    // bug that stranded beta installs from auto-upgrading.
    const { getActiveChannel } = await import('./auto-updater');
    const active = getActiveChannel();
    return {
      autoUpdateEnabled: s.autoUpdateEnabled !== false,
      lastUpdateCheckAt: s.lastUpdateCheckAt ?? null,
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      channel: active.channel,
      channelSource: active.source,
      channelEmbedded: active.embedded,
      channelSetting: s.releaseChannel,
    };
  });

  // ── updates:set-channel (F-395) ──────────────
  // Operator-facing override: persists a UI-selected channel + repoints
  // the live autoUpdater + kicks an immediate check so the result is
  // visible within seconds. Pass `null` to clear the override (fall
  // through to embedded / default per resolveChannel precedence).
  ipcMain.handle('updates:set-channel', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { channel } = args as { channel?: unknown };
    const normalised: 'latest' | 'beta' | null =
      channel === 'latest' || channel === 'beta' ? channel : null;
    try {
      const { setReleaseChannel } = await import('./auto-updater');
      const result = await setReleaseChannel(normalised);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── updates:set-auto-enabled ──────────────────
  // Flip the autoUpdateEnabled toggle. Returns the new persisted value.
  // Safe to call repeatedly; non-bool inputs coerce to true (default ON).
  ipcMain.handle('updates:set-auto-enabled', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { enabled } = args as { enabled?: unknown };
    const next = enabled === false ? false : true;
    try {
      updateSettings({ autoUpdateEnabled: next });
      return { success: true, autoUpdateEnabled: next };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── updates:check-now ─────────────────────────
  // Always-on manual check — bypasses the autoUpdateEnabled toggle so
  // opted-out users can still pull the latest on demand.
  ipcMain.handle('updates:check-now', async () => {
    const { manualUpdateCheck } = await import('./auto-updater');
    return manualUpdateCheck();
  });

  // ── config:promote-env-key (F-313) ────────────
  // "Move to keychain" — when an env var is set and the user wants it
  // stored authoritatively in the OS Keychain, copy the value over so the
  // env var becomes unnecessary (user can then delete it from .env / shell
  // / system env).
  ipcMain.handle('config:promote-env-key', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { provider } = args as Record<string, unknown>;
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.includes(provider as KnownProvider)) {
      return { success: false, error: 'Unknown provider' };
    }
    const envMap: Partial<Record<KnownProvider, string>> = {
      claude: 'ANTHROPIC_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GOOGLE_API_KEY',
      ollama: 'OLLAMA_API_KEY',
      github: 'GITHUB_TOKEN',
    };
    const envVarName = envMap[provider as KnownProvider];
    if (envVarName === undefined) return { success: false, error: 'No env var mapped' };
    const envValue = process.env[envVarName];
    if (envValue === undefined || envValue === '') {
      return { success: false, error: `${envVarName} is not set in the current environment` };
    }
    try {
      const { setApiKey: storeApiKey } = await import('./secret-store');
      await storeApiKey(provider as KnownProvider, envValue);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── config:delete-api-key ─────────────────────
  ipcMain.handle('config:delete-api-key', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { provider } = args as Record<string, unknown>;
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.includes(provider as KnownProvider)) {
      return { success: false, error: 'Unknown provider' };
    }
    try {
      const { deleteApiKey: removeApiKey } = await import('./secret-store');
      await removeApiKey(provider as KnownProvider);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── config:test-provider ──────────────────────
  // F-335: real auth-only test calls for each provider. All use the
  // provider's cheapest endpoint that requires a valid API key — model
  // listing for OpenRouter / OpenAI / Gemini, the user endpoint for
  // GitHub, and a 1-token completion for Claude (Anthropic has no
  // free auth-only endpoint, ~$0.001 per click).
  ipcMain.handle('config:test-provider', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { provider } = args as Record<string, unknown>;
    if (typeof provider !== 'string') return { success: false, error: 'Provider required' };

    const start = Date.now();

    async function httpGet(url: string, headers: Record<string, string>): Promise<number> {
      const https = await import('https');
      return new Promise((resolve, reject) => {
        const req = https.get(url, { headers, timeout: 8000 }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
    }

    async function httpPostJson(url: string, headers: Record<string, string>, body: unknown): Promise<number> {
      const https = await import('https');
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
          method: 'POST',
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { ...headers, 'Content-Type': 'application/json' },
          timeout: 8000,
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(JSON.stringify(body));
        req.end();
      });
    }

    function envKey(name: string): string | null {
      const v = process.env[name];
      return v !== undefined && v !== '' ? v : null;
    }

    try {
      if (provider === 'ollama') {
        const http = await import('http');
        await new Promise<void>((resolve, reject) => {
          const req = http.get('http://localhost:11434/api/tags', { timeout: 3000 }, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        return { success: true, latencyMs: Date.now() - start };
      }

      if (provider === 'openrouter') {
        const key = envKey('OPENROUTER_API_KEY');
        if (key === null) return { success: false, error: 'OPENROUTER_API_KEY not set' };
        const code = await httpGet('https://openrouter.ai/api/v1/models', { Authorization: `Bearer ${key}` });
        return code >= 200 && code < 300
          ? { success: true, latencyMs: Date.now() - start }
          : { success: false, error: `OpenRouter returned HTTP ${code}` };
      }

      if (provider === 'openai') {
        const key = envKey('OPENAI_API_KEY');
        if (key === null) return { success: false, error: 'OPENAI_API_KEY not set' };
        const code = await httpGet('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
        return code >= 200 && code < 300
          ? { success: true, latencyMs: Date.now() - start }
          : { success: false, error: `OpenAI returned HTTP ${code}` };
      }

      if (provider === 'gemini') {
        const key = envKey('GEMINI_API_KEY') ?? envKey('GOOGLE_API_KEY');
        if (key === null) return { success: false, error: 'GEMINI_API_KEY not set' };
        const code = await httpGet(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {});
        return code >= 200 && code < 300
          ? { success: true, latencyMs: Date.now() - start }
          : { success: false, error: `Gemini returned HTTP ${code}` };
      }

      if (provider === 'github') {
        const key = envKey('GITHUB_TOKEN') ?? envKey('GH_TOKEN');
        if (key === null) return { success: false, error: 'GITHUB_TOKEN not set' };
        const code = await httpGet('https://api.github.com/user', {
          Authorization: `Bearer ${key}`,
          'User-Agent': 'kageops',
          Accept: 'application/vnd.github+json',
        });
        return code >= 200 && code < 300
          ? { success: true, latencyMs: Date.now() - start }
          : { success: false, error: `GitHub returned HTTP ${code}` };
      }

      if (provider === 'claude') {
        const key = envKey('ANTHROPIC_API_KEY') ?? envKey('CLAUDE_API_KEY');
        if (key === null) return { success: false, error: 'ANTHROPIC_API_KEY not set' };
        const code = await httpPostJson('https://api.anthropic.com/v1/messages', {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        }, {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return code >= 200 && code < 300
          ? { success: true, latencyMs: Date.now() - start }
          : { success: false, error: `Anthropic returned HTTP ${code}` };
      }

      return { success: false, error: `Unknown provider: ${provider}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── config:save-env-var ───────────────────────
  ipcMain.handle('config:save-env-var', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { key, value } = args as Record<string, unknown>;
    if (typeof key !== 'string' || !KNOWN_ENV_VARS.includes(key as KnownEnvVar)) {
      return { success: false, error: 'Unknown env var' };
    }
    if (typeof value !== 'string') return { success: false, error: 'Value must be a string' };

    try {
      const fs = await import('fs');
      const nodePath = await import('path');
      const envPath = ENV_FILE_PATH;
      const dir = nodePath.dirname(envPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // v0.1.41 (#163) — for directory-path env vars, eagerly create the
      // target directory on save. This eliminates a footgun where users
      // typed a custom path that didn't exist yet, then on next boot the
      // env-scrubber (pre-v0.1.41) wiped the entry as "target directory
      // does not exist". The scrubber check has been narrowed to legacy-
      // literal only; the mkdir below is belt-and-braces so the directory
      // exists before any downstream code tries to write into it.
      const DIRECTORY_PATH_KEYS: ReadonlyArray<string> = [
        'KAGEOPS_PROJECTS_DIR',
        'KAGEOPS_DATA_DIR',
      ];
      if (DIRECTORY_PATH_KEYS.includes(key) && value.trim() !== '') {
        try {
          if (!fs.existsSync(value)) {
            fs.mkdirSync(value, { recursive: true });
            log.info({ key, value }, '[Main] Created target directory on env-var save');
          }
        } catch (mkdirErr) {
          const msg = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
          // Don't fail the save — user might intend to create the
          // directory themselves later. Surface the error so the UI can
          // show a hint, but still persist the value.
          return { success: false, error: `Could not create directory "${value}": ${msg}` };
        }
      }

      let existing = '';
      if (fs.existsSync(envPath)) {
        existing = fs.readFileSync(envPath, 'utf-8');
      }

      const lines = existing.split('\n');
      const prefix = `${key}=`;
      const newLine = `${key}=${value}`;
      const idx = lines.findIndex((l) => l.startsWith(prefix));
      const updated = idx >= 0
        ? [...lines.slice(0, idx), newLine, ...lines.slice(idx + 1)]
        : [...lines, newLine];

      fs.writeFileSync(envPath, updated.join('\n'), 'utf-8');
      process.env[key] = value;

      // Most KageOps env vars (KAGEOPS_PROJECTS_DIR included) are now
      // consulted live at the point of use, so a save takes effect on the
      // next operation. Vars baked into a one-shot bootstrap step still
      // need a restart — return a non-fatal note so the UI can hint.
      const RESTART_REQUIRED: ReadonlyArray<string> = [
        'KAGEOPS_DATA_DIR', // settings.json / .env paths resolved at startup
        'DATABASE_URL',     // pg.Pool connection captured at bootstrap
      ];
      const needsRestart = RESTART_REQUIRED.includes(key);
      return { success: true, needsRestart };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── config:get-env-vars ───────────────────────
  ipcMain.handle('config:get-env-vars', () => {
    const result: Partial<Record<KnownEnvVar, string | null>> = {};
    for (const k of KNOWN_ENV_VARS) {
      result[k] = process.env[k] ?? null;
    }
    return result;
  });

  // ── Provider Key Registry ─────────────────────
  ipcMain.handle('config:list-provider-keys', async (_event, args: unknown) => {
    try {
      const { listProviderKeys } = await import('./provider-key-registry');
      const a = (args !== null && typeof args === 'object') ? args as Record<string, unknown> : {};
      const provider = typeof a.provider === 'string' ? a.provider : undefined;
      const projectId = typeof a.projectId === 'string' ? a.projectId : (a.projectId === null ? null : undefined);
      return { success: true, keys: await listProviderKeys(provider, projectId) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), keys: [] };
    }
  });

  ipcMain.handle('config:add-provider-key', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const a = args as Record<string, unknown>;
    if (typeof a.provider !== 'string' || typeof a.label !== 'string' || typeof a.apiKey !== 'string') {
      return { success: false, error: 'provider, label, and apiKey are required' };
    }
    try {
      const { addProviderKey } = await import('./provider-key-registry');
      const key = await addProviderKey({
        provider: a.provider,
        label: a.label,
        apiKey: a.apiKey,
        projectId: typeof a.projectId === 'string' ? a.projectId : null,
        isDefault: typeof a.isDefault === 'boolean' ? a.isDefault : false,
      });
      return { success: true, key };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('config:update-provider-key', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const a = args as Record<string, unknown>;
    if (typeof a.keyId !== 'string') return { success: false, error: 'keyId is required' };
    try {
      const { updateProviderKey } = await import('./provider-key-registry');
      return await updateProviderKey(a.keyId, {
        label: typeof a.label === 'string' ? a.label : undefined,
        isDefault: typeof a.isDefault === 'boolean' ? a.isDefault : undefined,
        projectId: a.projectId !== undefined ? (typeof a.projectId === 'string' ? a.projectId : null) : undefined,
        apiKey: typeof a.apiKey === 'string' ? a.apiKey : undefined,
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('config:delete-provider-key', async (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const a = args as Record<string, unknown>;
    if (typeof a.keyId !== 'string') return { success: false, error: 'keyId is required' };
    try {
      const { deleteProviderKey } = await import('./provider-key-registry');
      return await deleteProviderKey(a.keyId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── config:set-agent-provider ─────────────────
  ipcMain.handle('config:set-agent-provider', (_event, args: unknown) => {
    if (typeof args !== 'object' || args === null) return { success: false, error: 'Invalid args' };
    const { agentName, provider, model } = args as Record<string, unknown>;
    if (typeof agentName !== 'string' || !KNOWN_AGENT_NAMES.includes(agentName as KnownAgentName)) {
      return { success: false, error: 'Unknown agent' };
    }
    if (typeof provider !== 'string' || typeof model !== 'string') {
      return { success: false, error: 'provider and model required' };
    }
    try {
      setAgentModelConfig(agentName, model, provider, []);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ── App Lifecycle ────────────────────────────────────

// Single-instance lock. Prevents a second launch of THIS build from opening a
// duplicate window on the same data dir (which would fight over the embedded
// PGlite store). The lock is keyed on the app's userData dir, so it is per-build
// (open vs commercial don't block each other — the splash scheme fix handles
// that case). In the commercial build the device-flow protocol handler also
// requests this lock; calling it here is idempotent and additionally covers the
// open build. If another instance already holds the lock, quit; otherwise focus
// the existing window when a second launch is attempted.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getCommandCenterWindow();
    if (win !== null && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Windows taskbar grouping + icon. Without setAppUserModelId, the taskbar
// shows the generic Electron icon and groups all KageOps windows under
// "Electron" instead of "KageOps". MUST be called before any window opens.
if (process.platform === 'win32') {
  app.setAppUserModelId('ai.kageops.app');
}

app.whenReady().then(async () => {
  // Pillar 2.2 / fix — point the bundle loader at the packaged copy.
  // In `npm run dev`, process.cwd() is the repo root and `bundles/`
  // sits next to package.json — the loader's default is correct.
  // In packaged installs, process.cwd() is wherever Windows launched
  // the .exe from (often C:\Users\<u>\AppData\Local\Programs\KageOps),
  // so the loader looks for `<launch-dir>/bundles` and finds nothing.
  // electron-builder copies `bundles/**/*` into resources/bundles via
  // extraResources; point the loader there.
  if (app.isPackaged && process.env['KAGEOPS_BUNDLES_DIR'] === undefined) {
    const packagedBundles = path.join(process.resourcesPath, 'bundles');
    process.env['KAGEOPS_BUNDLES_DIR'] = packagedBundles;
    log.info({ bundlesDir: packagedBundles }, 'packaged build: pointing bundle loader at resources/bundles');
  }

  // .env auto-loading is a developer convenience. End users (running the
  // packaged installer) should NOT inherit stray .env files from random
  // working directories — that's the F-313 leakage path where stale
  // ANTHROPIC_API_KEY values silently override what the user typed in the
  // API Keys panel.
  //
  // Gating rule (decision #74):
  //   - Packaged app (production install)  → never load .env
  //   - Unpackaged (`npm run dev`)         → load .env (dev convenience)
  //   - `KAGEOPS_LOAD_DOTENV=1` env var    → force-load (override for ops/tests)
  //   - `KAGEOPS_LOAD_DOTENV=0` env var    → force-skip (override for safety)
  // Bug #6 (v0.1.32) — scrub stale KAGEOPS_DATA_DIR / KAGEOPS_PROJECTS_DIR
  // entries from ~/.kageops/.env BEFORE the dotenv loader runs. Pre-F-382
  // builds shipped a hardcoded `C:\projects\playground\kageops\...` default
  // that got persisted on first run; users who installed back then keep
  // booting against paths their machine no longer has (PGlite ENOENT,
  // orchestrator failed to start). The scrubber only touches those two
  // keys and only when the value is the legacy literal or a non-existent
  // dir — every other line is preserved byte-for-byte.
  try {
    const { scrubStaleEnvFile } = await import('./env-scrubber');
    const envCandidates = [
      path.join(os.homedir(), '.kageops', '.env'),
      path.join(process.cwd(), '.env'),
    ];
    for (const candidate of envCandidates) {
      const result = scrubStaleEnvFile(candidate);
      if (result.scrubbed > 0) {
        log.warn(
          { envPath: candidate, scrubbed: result.scrubbed, details: result.details },
          'Scrubbed stale env entries (bug #6 migrator) — using current defaults',
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'env-scrubber failed (continuing with original .env)',
    );
  }

  const dotenvOverride = process.env['KAGEOPS_LOAD_DOTENV'];
  const shouldLoadDotenv = dotenvOverride === '1'
    ? true
    : dotenvOverride === '0'
      ? false
      : !app.isPackaged; // default: dev=on, prod=off
  if (shouldLoadDotenv) {
    try {
      const envFs = await import('fs');
      const envPaths = [
        require('path').join(process.cwd(), '.env'),
        require('path').join(require('os').homedir(), '.kageops', '.env'),
      ];
      for (const envPath of envPaths) {
        if (envFs.existsSync(envPath)) {
          const envContent = envFs.readFileSync(envPath, 'utf-8');
          for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx <= 0) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
          log.info({ envPath }, 'Loaded .env file (dev mode)');
          break;
        }
      }
    } catch {
      // .env loading is best-effort
    }
  } else {
    log.info({ packaged: app.isPackaged }, '.env auto-load disabled (production / opt-out)');
  }

  loadSettings();

  // Seed any missing built-in preset files (claude-cli, ollama,
  // openrouter_*) so the Command Center preset dropdown lists every
  // option instead of greying them out as "(file missing)".
  try { ensurePresetFiles(); } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ensurePresetFiles failed');
  }

  const isHeadless = process.argv.includes('--headless');

  // OSS-split seam (step 3a): load commercial boot extensions once. In the open
  // build this resolves to {} and every cloud/auth/team/connector capability is
  // simply absent; in the commercial build it wires the real modules.
  commercialExtensions = await loadCommercialExtensions();
  const commercial = commercialExtensions;

  // OSS default — hosting follows the Vercel token (no global toggle needed).
  // With no commercial layer + no explicit KAGEOPS_NO_HOSTING, auto-decide from
  // the keychain: a token means the user wants to deploy; no token means run
  // locally (so a clean build never wedges the dev gate waiting for a deploy
  // they haven't set up). Saving/clearing the token in the UI re-applies this
  // live (deploy-keys-handlers). Explicit KAGEOPS_NO_HOSTING=0/1 always wins.
  if (commercial === noopCommercialExtensions && !isHostingExplicitlySet()) {
    const { getSecret } = await import('./secret-store');
    const vercelToken = await getSecret('kageops', 'vercel-token').catch(() => null);
    const tokenPresent = typeof vercelToken === 'string' && vercelToken.length > 0;
    applyAutoHosting(tokenPresent);
    log.info(
      `[Main] Open build hosting: ${tokenPresent ? 'enabled (Vercel token found)' : 'run-locally (no Vercel token)'}.`,
    );
  }

  // Bootstrap orchestrator unless --no-orchestrator flag is set
  if (!process.argv.includes('--no-orchestrator')) {
    // F-382: prefer KAGEOPS_PROJECTS_DIR; default to ~/.kageops/projects/
    // (cross-platform). The previous Windows-only `C:\projects\playground\kageops\projects`
    // default broke installed Mac builds because the C: drive doesn't exist.
    const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.kageops', 'projects');
    const projectsDir = process.env['KAGEOPS_PROJECTS_DIR'] ?? DEFAULT_PROJECTS_DIR;
    orchestrator = await bootstrapOrchestrator(projectsDir);

    if (orchestrator !== null) {
      // Push a welcome activity so the Command Center isn't empty on launch
      orchestrator.activityBridge.pushActivity({
        agent: 'Sensei',
        message: 'KageOps online. All agents standing by.',
      });

      // Surface ai-adapter network-transient retries to the event bus so
      // the UI can show "retrying — network issue" instead of silent stalls.
      const { onNetworkTransient } = await import('../agents/ai-adapter-resilience');
      onNetworkTransient((info) => {
        void orchestrator?.eventBus.publish('network.transient', {
          data: {
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            delayMs: info.delayMs,
            error: info.error,
          },
        });
      });

      // Forward resilience signals to the Command Center renderer via a
      // dedicated IPC channel so the network-toast consumer can show
      // "retrying…" / "Back online" without tapping the full activity feed.
      orchestrator.eventBus.subscribe('network.transient', (event) => {
        const win = getCommandCenterWindow();
        if (win === null) return;
        try {
          win.webContents.send(IPC.NETWORK_EVENT, {
            kind: 'transient',
            data: event.data,
            timestamp: event.timestamp,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[Main] NETWORK_EVENT transient forward failed'
          );
        }
      });
      orchestrator.eventBus.subscribe('eventbus.reconnected', (event) => {
        const win = getCommandCenterWindow();
        if (win === null) return;
        try {
          win.webContents.send(IPC.NETWORK_EVENT, {
            kind: 'reconnected',
            data: event.data,
            timestamp: event.timestamp,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[Main] NETWORK_EVENT reconnected forward failed'
          );
        }
      });

      // ── App-credential setup copilot (MCC-8 / Slice 4) ──
      // Forward `setup.required` to the Command Center so the credential
      // ledger panel surfaces a missing credential the moment Sensei detects
      // it at a gate — without the operator manually refreshing.
      orchestrator.eventBus.subscribe('setup.required', (event) => {
        const win = getCommandCenterWindow();
        if (win === null) return;
        try {
          win.webContents.send(IPC.SETUP_REQUIRED_EVENT, {
            projectId: event.projectId ?? null,
            data: event.data,
            timestamp: event.timestamp,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[Main] SETUP_REQUIRED_EVENT forward failed'
          );
        }
      });

      // ── BPF-6 — development-gate defer reason ───────────
      // Forward `gate.deferred` to the Command Center so clicking "Approve"
      // never silently does nothing: the renderer toasts WHY it deferred
      // (tasks in flight / build failing / deploy pending / credential needed).
      orchestrator.eventBus.subscribe('gate.deferred', (event) => {
        const win = getCommandCenterWindow();
        if (win === null) return;
        try {
          win.webContents.send(IPC.GATE_DEFERRED_EVENT, {
            projectId: event.projectId ?? null,
            data: event.data,
            timestamp: event.timestamp,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[Main] GATE_DEFERRED_EVENT forward failed'
          );
        }
      });

      // ── Agent Terminal panel (B-497) ───────────────
      // Forward `subprocess.output` events to every open Command Center
      // window. The renderer filters by projectId — main keeps the wire
      // shape minimal so the panel can render without re-parsing.
      orchestrator.eventBus.subscribe('subprocess.output', (event) => {
        const win = getCommandCenterWindow();
        if (win === null) return;
        try {
          win.webContents.send(IPC.AGENT_TERMINAL_OUTPUT, {
            projectId: event.projectId ?? null,
            taskId: event.taskId ?? null,
            agent: event.agent ?? null,
            data: event.data,
            timestamp: event.timestamp,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[Main] AGENT_TERMINAL_OUTPUT forward failed'
          );
        }
      });

      // ── Phase 3 — Human collaboration notifications ────
      // approval.required, task.claimed, phase.changed fire desktop toasts
      // via the helpers in notifications.ts so the user gets feedback even
      // when the Command Center window is behind another app.
      orchestrator.eventBus.subscribe('approval.required', (event) => {
        try {
          const { notifyApprovalRequired } = require('./notifications') as typeof import('./notifications');
          const d = (event.data ?? {}) as Record<string, unknown>;
          notifyApprovalRequired({
            projectName: String(d['projectName'] ?? event.projectId ?? 'KageOps'),
            taskTitle:   String(d['taskTitle'] ?? 'Approval needed'),
            requestedBy: String(d['requestedBy'] ?? 'Agent'),
            taskId:      String(d['taskId'] ?? ''),
          });
        } catch { /* non-fatal */ }
      });

      orchestrator.eventBus.subscribe('task.claimed', (event) => {
        try {
          const { notifyTaskClaimed } = require('./notifications') as typeof import('./notifications');
          const d = (event.data ?? {}) as Record<string, unknown>;
          notifyTaskClaimed({
            projectName: String(d['projectName'] ?? event.projectId ?? 'KageOps'),
            taskTitle:   String(d['taskTitle'] ?? 'Task'),
            claimedBy:   String(d['claimedBy'] ?? 'Someone'),
          });
        } catch { /* non-fatal */ }
      });

      orchestrator.eventBus.subscribe('phase.changed', (event) => {
        try {
          const { notifyPhaseChanged } = require('./notifications') as typeof import('./notifications');
          const d = (event.data ?? {}) as Record<string, unknown>;
          notifyPhaseChanged({
            projectName: String(d['projectName'] ?? event.projectId ?? 'KageOps'),
            phase:       String(d['phase'] ?? event.channel),
          });
        } catch { /* non-fatal */ }
      });

      // ── OS-level project completion toast ─────────────
      // Wave 3 Day 3: when a project transitions to completed, fire a
      // native notification + sound so the user gets feedback even if
      // the Command Center window is minimised or behind another app.
      orchestrator.eventBus.subscribe('project.completed', (event) => {
        try {
          const data = (event.data ?? {}) as { readonly name?: string | null; readonly finalPhase?: string };
          const projectName = typeof data.name === 'string' && data.name.length > 0 ? data.name : 'KageOps project';
          const finalPhase = typeof data.finalPhase === 'string' ? data.finalPhase : 'launch-growth';
          // Electron 26+ supports Notification on Win/Mac/Linux. Sound
          // defaults to system default; users can mute via OS settings.
          const notif = new Notification({
            title: `${projectName} — done`,
            body: `Final phase: ${finalPhase}. Check the Command Center for the artifact.`,
            silent: false,
          });
          notif.on('click', () => {
            const win = getCommandCenterWindow();
            if (win !== null && !win.isDestroyed()) {
              if (win.isMinimized()) win.restore();
              win.focus();
            }
          });
          notif.show();
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[Main] project.completed notification failed (continuing)'
          );
        }
      });

      // Broadcast key lifecycle events to outbound connectors (Slack/Discord/Teams).
      // Commercial-only — no-op in the open build where broadcastConnectorEvent is absent.
      const connectorBroadcast = commercial.broadcastConnectorEvent;
      if (connectorBroadcast !== undefined) {
        const makeConnectorHandler = (type: import('../connectors/types').ConnectorEventType) =>
          (event: { data?: unknown; projectId?: string }) => {
            const d = (event.data ?? {}) as Record<string, unknown>;
            const str = (key: string, fallback: string): string =>
              typeof d[key] === 'string' && (d[key] as string).length > 0 ? (d[key] as string) : fallback;
            void connectorBroadcast({
              type,
              projectId:   str('projectId', event.projectId ?? 'unknown'),
              projectName: str('projectName', str('name', 'KageOps project')),
              actor:       str('actor', str('agentName', 'KageOps')),
              message:     str('message', type.replace('.', ' ')),
            });
          };
        orchestrator.eventBus.subscribe('approval.required', makeConnectorHandler('approval.required'));
        orchestrator.eventBus.subscribe('task.claimed',      makeConnectorHandler('task.claimed'));
        orchestrator.eventBus.subscribe('phase.changed',     makeConnectorHandler('phase.changed'));
        orchestrator.eventBus.subscribe('project.completed', makeConnectorHandler('project.completed'));
      }

      // F-300 — generate a self-contained build report HTML on every project
      // completion. Saves to <workspace>/build-report.html (travels with the
      // project) and ~/.kageops/build-reports/ (central index until the admin
      // portal lands). Pure fire-and-forget — failures log but never affect
      // orchestration.
      const { subscribeBuildSummaryGenerator } = await import('../orchestrator/build-summary');
      subscribeBuildSummaryGenerator(orchestrator.eventBus);
    }
  } else {
    log.info('--no-orchestrator flag detected. Skipping orchestration init.');
  }

  bootstrapApoScheduler();

  if (isHeadless) {
    // Headless mode: HTTP control plane only, no Electron windows or tray
    log.info('--headless flag detected. Starting in headless mode (no GUI).');
    createHeadlessServer(orchestrator);

    // Forward EventBus activity to SSE clients if orchestrator is running
    if (orchestrator !== null) {
      orchestrator.eventBus.subscribeAll((event) => {
        broadcastEvent(event.channel, event);
      });
    }
    return;
  }

  // GUI mode
  setupIPC();
  setupCommandCenterIPC();
  setupConfigIPC();
  setupOnboardingIPC();

  // kageops:// request handler. Commercial build: auth-window owns the richer
  // router (auth + plan + splash + welcome). Open build: fall back to the CORE
  // handler that serves splash + welcome. Exactly one handler is registered.
  if (commercial.registerAuthProtocol) {
    commercial.registerAuthProtocol();
  } else {
    registerAppProtocol();
  }

  // Phase 3 — Auth + Plan + Team IPC (commercial; absent in the open build)
  commercial.registerAuthIpc?.();
  commercial.registerPlanIpc?.();

  const { registerWelcomeIpcHandlers } = await import('./welcome-window');
  registerWelcomeIpcHandlers();

  // PR D of F-302 — wire the orchestrator's eventBus + notification helpers
  // so team actions (invite, claim, comment) fan out to connectors and
  // surface as desktop notifications. The optional deps object lets the
  // handlers run as before when the orchestrator isn't yet bootstrapped.
  const { notifyTaskCommented, notifyMemberJoined } = await import('./notifications');
  commercial.registerTeamIpc?.({
    publishEvent: (channel, payload) => {
      if (orchestrator !== null) {
        // Fire-and-forget — the IPC handler doesn't await the publish.
        void orchestrator.eventBus.publish(channel as never, { data: payload });
      }
    },
    notify: {
      taskCommented: notifyTaskCommented,
      memberJoined: notifyMemberJoined,
    },
  });

  commercial.registerConnectorIpc?.();

  // Boot: branded splash → auth check → Command Center.
  // Splash duration is controlled by KAGEOPS_SPLASH_MS (default 10s, set 0 to skip).
  const skipAuth = process.argv.includes('--no-auth') || process.env['KAGEOPS_SKIP_AUTH'] === '1';
  const skipSplash = process.argv.includes('--no-splash') || process.env['KAGEOPS_SPLASH_MS'] === '0';

  if (!skipSplash) {
    const { showSplash } = await import('./splash-window');
    await showSplash();
  }

  // Auth flow (post-pivot — device-flow via Cloudflare Worker).
  // 1. --no-auth or KAGEOPS_SKIP_AUTH=1 → skip auth entirely (dev only)
  // 2. Cached desktop session valid → boot Command Center directly
  // 3. Otherwise → open auth window with "Sign in with browser" button
  const onAuthComplete = (session: AuthSessionLike): void => {
    log.info({ userId: session.userId, plan: session.plan }, '[Main] Auth complete');

    const bootCommandCenter = (): void => {
      log.info('[Main] bootCommandCenter: creating CC window');
      const commandCenter = createCommandCenterWindow();
      log.info('[Main] bootCommandCenter: CC window created');
      if (process.argv.includes('--devtools')) {
        commandCenter.webContents.openDevTools({ mode: 'detach' });
      }
      void import('./welcome-window').then(({ showWelcomeWindow, shouldShowWelcome }) => {
        if (shouldShowWelcome()) {
          setTimeout(() => showWelcomeWindow(), 300);
        }
      });
    };

    // Accept plan-selected from either the Worker (authoritative) or the local
    // settings file (fallback for when the Worker isn't yet deployed with the
    // plan_selected endpoint — avoids showing the plan window on every login).
    const alreadySelected = session.planSelected || getSettings().planSelected;

    // Plan selection is commercial — absent in the open build, so boot directly.
    if (!alreadySelected && commercial.showPlanWindow !== undefined) {
      commercial.showPlanWindow(session, () => {
        updateSettings({ planSelected: true });
        bootCommandCenter();
      });
    } else {
      bootCommandCenter();
    }
  };

  // Open build (no commercial auth) or explicit skip → boot the Command Center
  // directly with a local session. Commercial build runs the Clerk device flow.
  if (skipAuth || commercial.tryRestoreSession === undefined) {
    onAuthComplete({ userId: 'dev-skip', email: '', firstName: null, lastName: null, plan: 'team', planSelected: true });
  } else {
    const restored = await commercial.tryRestoreSession(onAuthComplete);
    if (!restored) {
      commercial.showAuthWindow?.(onAuthComplete);
    }
  }

  // Tray "Sign Out" is commercial (auth) — wire it from the registry before the
  // tray is built. Null in the open build → the menu item no-ops.
  setSignOutHandler(commercial.signOut ?? null);
  createTray();

  // Auto-updater — packaged builds only, no-op in dev.
  // Channel: KAGEOPS_RELEASE_CHANNEL=latest (default) or =staging (testers).
  try {
    const { initAutoUpdater } = await import('./auto-updater');
    initAutoUpdater(() => getCommandCenterWindow());
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[Main] auto-updater init failed (continuing without auto-update)'
    );
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows
});

// CRITICAL — async cleanup in `before-quit`.
//
// Electron's `before-quit` event does NOT await async handlers. Returning a
// Promise has no effect: the process exits as soon as the synchronous part
// of the handler returns. The `await shutdownOrchestrator(...)` then runs
// against a torn-down event loop and PGlite's final WAL checkpoint write
// gets killed mid-flush. Next launch finds an incomplete checkpoint and
// PGlite panics with "could not locate a valid checkpoint record at 0/...".
// Observed in production 2026-05-20 AEST — every clean quit corrupted the
// embedded DB. The Sensei error message politely directed users to rename
// pgdata → pgdata.bak, but the underlying bug was THIS handler, not PGlite.
//
// The correct pattern: preventDefault() to stop the synchronous teardown,
// run the async cleanup to completion, then explicitly app.quit() once
// done. A re-entry guard avoids the infinite loop where the second quit
// fires another before-quit.
let isShuttingDown = false;
app.on('before-quit', (event) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  event.preventDefault();

  void (async () => {
    try {
      if (apoScheduler !== null) {
        apoScheduler.stop();
        apoScheduler = null;
      }

      if (stopBurstIdleReaper !== null) {
        stopBurstIdleReaper();
        stopBurstIdleReaper = null;
      }

      // (Loopback auth HTTP server removed in the device-flow pivot —
      //  no shutdown needed.)

      shellManager.killAllSessions();

      if (orchestrator !== null) {
        await shutdownOrchestrator(orchestrator);
        orchestrator = null;
      }
    } catch (err) {
      // Log but never throw — a thrown shutdown leaves the app stuck
      // (preventDefault held, no app.quit() ever fires).
      try {
        log.error({ err: err instanceof Error ? err.message : String(err) }, '[Main] Shutdown handler error');
      } catch {
        // Logger itself broken — fall through to app.quit().
      }
    } finally {
      app.quit();
    }
  })();
});

// (singleton lock is at top of file)
