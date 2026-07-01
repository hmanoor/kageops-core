/**
 * KageOps Learning — Apply APO Winner to Preset Config (B-476)
 *
 * Writes the winning prompt from `apo-engine.optimize()` into the active
 * `agent-config.<preset>.json` file under `agents.<name>.systemPromptOverride`.
 * Called explicitly by a caller that already ran APO — the engine itself
 * stays pure and doesn't touch the filesystem.
 *
 * Guarantees:
 *   - **Scope-gated**: rejects agents outside `APO_ELIGIBLE_AGENTS`.
 *   - **Idempotent**: no-op (no write, no backup) when the winner already
 *     matches the existing override.
 *   - **Atomic**: writes to a sibling temp file and renames on success, so
 *     a crash mid-write never leaves the preset corrupted.
 *   - **Reversible**: copies the pre-update file to
 *     `<preset>.apo-backup-<ts>.json` before overwriting — B-478 (manual
 *     rollback UI) will consume this trail.
 *   - **Preserves unrelated fields**: only writes `systemPromptOverride`
 *     for the target agent; other agents, `defaults`, and unrelated keys
 *     pass through untouched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../shared/logger';
import { APO_ELIGIBLE_AGENTS } from './types';

const log = createLogger('APO.ApplyWinner');

// ── Injectable fs shape ──────────────────────────────

/**
 * Subset of `fs` used by this module. Tests inject a memfs-backed object so
 * we never write to the user's real `~/.kageops/`.
 */
export interface FsLike {
    readonly existsSync: typeof fs.existsSync;
    readonly readFileSync: typeof fs.readFileSync;
    readonly writeFileSync: typeof fs.writeFileSync;
    readonly renameSync: typeof fs.renameSync;
}

// ── Public types ─────────────────────────────────────

export interface ApplyWinnerOptions {
    readonly agentName: string;
    readonly winner: string;
    /**
     * Absolute path to the preset JSON. When omitted, resolved using the
     * same `KAGEOPS_DATA_DIR` / `KAGEOPS_PRESET` / `active-preset.txt`
     * precedence as `agent-config.ts`.
     */
    readonly presetPath?: string;
    /** Injectable for tests. Defaults to node's `fs`. */
    readonly fs?: FsLike;
    /**
     * Injectable clock for tests. Defaults to `Date.now()`.
     * Used for backup filename + tmp filename suffixes.
     */
    readonly now?: () => number;
}

export interface ApplyWinnerResult {
    readonly presetPath: string;
    readonly agentName: string;
    readonly previousPrompt: string | null;
    readonly newPrompt: string;
    readonly changed: boolean;
    readonly backupPath: string | null;
}

// ── Core ─────────────────────────────────────────────

export function applyWinner(opts: ApplyWinnerOptions): ApplyWinnerResult {
    if (!APO_ELIGIBLE_AGENTS.includes(opts.agentName)) {
        throw new Error(
            `[APO.ApplyWinner] agent "${opts.agentName}" is not APO-eligible ` +
                `(allowed: ${APO_ELIGIBLE_AGENTS.join(', ')})`
        );
    }
    if (opts.winner.trim() === '') {
        throw new Error('[APO.ApplyWinner] winner prompt is empty');
    }

    const fsImpl = opts.fs ?? fs;
    const now = opts.now ?? Date.now;
    const presetPath = opts.presetPath ?? resolvePresetPath();

    if (!fsImpl.existsSync(presetPath)) {
        throw new Error(`[APO.ApplyWinner] preset file does not exist: ${presetPath}`);
    }

    const raw = fsImpl.readFileSync(presetPath, 'utf-8').toString();

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            `[APO.ApplyWinner] preset file is not valid JSON (${presetPath}): ${message}`
        );
    }

    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(
            `[APO.ApplyWinner] preset file does not decode to an object: ${presetPath}`
        );
    }

    const config = parsed as Record<string, unknown>;
    const agentsRaw = config['agents'];
    if (typeof agentsRaw !== 'object' || agentsRaw === null) {
        throw new Error(
            `[APO.ApplyWinner] preset file has no "agents" object: ${presetPath}`
        );
    }
    const agents = agentsRaw as Record<string, Record<string, unknown>>;

    const prev = agents[opts.agentName] ?? {};
    const previousPrompt =
        typeof prev['systemPromptOverride'] === 'string'
            ? (prev['systemPromptOverride'] as string)
            : null;

    if (previousPrompt === opts.winner) {
        log.info(
            { agentName: opts.agentName, presetPath },
            'applyWinner: winner matches existing override — no-op'
        );
        return Object.freeze({
            presetPath,
            agentName: opts.agentName,
            previousPrompt,
            newPrompt: opts.winner,
            changed: false,
            backupPath: null,
        });
    }

    const nextAgents: Record<string, Record<string, unknown>> = { ...agents };
    nextAgents[opts.agentName] = {
        ...prev,
        systemPromptOverride: opts.winner,
    };
    const nextConfig: Record<string, unknown> = { ...config, agents: nextAgents };
    const nextJson = JSON.stringify(nextConfig, null, 2) + '\n';

    const ts = now();
    const backupPath = `${presetPath}.apo-backup-${ts}.json`;
    const tmpPath = `${presetPath}.tmp-${process.pid}-${ts}`;

    fsImpl.writeFileSync(backupPath, raw, 'utf-8');
    fsImpl.writeFileSync(tmpPath, nextJson, 'utf-8');
    fsImpl.renameSync(tmpPath, presetPath);

    log.info(
        {
            agentName: opts.agentName,
            presetPath,
            backupPath,
            promptLength: opts.winner.length,
        },
        'applyWinner: wrote new systemPromptOverride'
    );

    return Object.freeze({
        presetPath,
        agentName: opts.agentName,
        previousPrompt,
        newPrompt: opts.winner,
        changed: true,
        backupPath,
    });
}

// ── Preset path resolution ───────────────────────────

/**
 * Mirrors the precedence in `src/agents/agent-config.ts#getGlobalConfigPath`:
 *   1. `KAGEOPS_PRESET` env var → `agent-config.<preset>.json`
 *   2. `<dataDir>/active-preset.txt` → `agent-config.<preset>.json`
 *   3. `<dataDir>/agent-config.json` (no preset)
 *
 * Duplicated intentionally — pulling the helper out of `agent-config.ts`
 * would drag Electron-facing imports into the learning module. Copying
 * ~20 lines is cheaper than the coupling.
 */
function resolvePresetPath(): string {
    const dataDir =
        process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');

    let preset = process.env['KAGEOPS_PRESET'];
    if (preset === undefined || preset === '') {
        const activePresetFile = path.join(dataDir, 'active-preset.txt');
        if (fs.existsSync(activePresetFile)) {
            try {
                preset = fs.readFileSync(activePresetFile, 'utf-8').trim();
            } catch {
                // active-preset.txt exists but unreadable — fall through to default.
            }
        }
    }

    if (preset !== undefined && preset !== '') {
        return path.join(dataDir, `agent-config.${preset}.json`);
    }

    return path.join(dataDir, 'agent-config.json');
}
