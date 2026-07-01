/**
 * Pillar 2.2 / PR-D — Deployment env materialiser.
 *
 * Bridges the encrypted-at-rest deployment config (PR-B.1) to the
 * on-disk `<repoPath>/.env.local` that Next.js + Vitest + Playwright
 * all expect to find during `npm install / build / test`.
 *
 * Called from `BuildVerificationGate.verify()` BEFORE any npm command
 * runs. Idempotent — overwrites whatever was on disk so subsequent
 * iterations (Pillar 1.2 reopen) pick up updated secrets.
 *
 * Failure mode: if encryption is unavailable (rare; only on
 * platforms without keychain support), we surface a typed error so
 * BVG can persist a clear build-status reason rather than emit a
 * generic "build failed" event.
 *
 * Secret hygiene: the .env.local file is written with mode 0o600
 * where the OS supports it (POSIX) and is added to .gitignore by the
 * scaffold itself — bundles are responsible for shipping a `.gitignore`
 * that excludes `.env*.local`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as nodeFs from 'node:fs';

import { appEnvFilePath, loadAppEnvFile } from './app-env-file';
import { createLogger } from '../shared/logger';

const log = createLogger('MaterializeDeploymentEnv');

const ENV_LOCAL_FILENAME = '.env.local';

// ── Public types ────────────────────────────────────────

/** Plaintext map of env-var key → value (mirrors deployment-config-repo's). */
export type DeploymentConfigValues = Readonly<Record<string, string>>;

export interface MaterializeResult {
    readonly status: 'written' | 'skipped' | 'error';
    /** Path to the file we wrote (or would have, on skip). */
    readonly path: string;
    /** Number of KEY=VALUE pairs serialized. 0 when skipped. */
    readonly varCount: number;
    /** Operator-facing one-line reason, used in build-status reports. */
    readonly reason: string;
}

export interface MaterializeDeps {
    /**
     * Optional override for fs.writeFile. Tests inject so we don't
     * touch the real filesystem; production uses node:fs.
     */
    readonly writeFile?: (filePath: string, contents: string, mode: number) => Promise<void>;
}

// ── OSS-split seam: encrypted deployment_config reader ───
//
// Reading the encrypted-at-rest `deployment_config` (Electron safeStorage) is
// COMMERCIAL. It's injected at the boundary (orchestrator-bootstrap); the open
// build leaves it null, so app credentials come only from the headless app-env
// file (KAGEOPS_APP_ENV_FILE, BPF-35). Tests inject a fake reader.
export type DeploymentConfigReader = (projectId: string) => Promise<DeploymentConfigValues | null>;

let deploymentConfigReader: DeploymentConfigReader | null = null;

export function setDeploymentConfigReader(reader: DeploymentConfigReader | null): void {
    deploymentConfigReader = reader;
}

// ── Phase 2b: OS-keychain "key register" reader ──────────
//
// Reads app secrets the operator ticked "Save to key register" for. Unlike the
// encrypted deployment_config reader above, this one is OPEN (OS keychain only)
// and is installed in both builds at bootstrap. It is the LAST fallback — used
// when neither the headless app-env file nor the (commercial) encrypted store
// yielded values, which is exactly the open build's steady state.
export type AppEnvKeychainReader = (projectId: string) => Promise<DeploymentConfigValues | null>;

let appEnvKeychainReader: AppEnvKeychainReader | null = null;

export function setAppEnvKeychainReader(reader: AppEnvKeychainReader | null): void {
    appEnvKeychainReader = reader;
}

// ── Public API ──────────────────────────────────────────

/**
 * Read `projects.deployment_config` for `projectId`, decrypt, and
 * serialize to `<repoPath>/.env.local`. Returns a structured result
 * so the caller (BVG) can attach the outcome to its build report.
 *
 * - status='skipped' when the operator chose "Skip for now" (D-B) —
 *   no config row exists. Project's build will fail naturally if it
 *   needs env vars; that's the intended D-B fallback.
 * - status='written' when at least one env var was serialized.
 * - status='error' wraps any unexpected throw and lets BVG keep going
 *   with a typed reason instead of an uncaught exception.
 */
export async function materializeDeploymentEnv(
    projectId: string,
    repoPath: string,
    deps?: Partial<MaterializeDeps>
): Promise<MaterializeResult> {
    const filePath = path.join(repoPath, ENV_LOCAL_FILENAME);
    const writeFile = deps?.writeFile ?? defaultWriteFile;

    let values: DeploymentConfigValues | null;
    try {
        values = await resolveAppEnvValues(projectId);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ projectId, err: msg }, 'load failed — BVG will see an error result');
        return {
            status: 'error',
            path: filePath,
            varCount: 0,
            reason: `failed to load deployment config: ${msg}`,
        };
    }

    if (values === null) {
        log.info(
            { projectId, repoPath },
            'no deployment_config row — operator picked "Skip for now" or never opened the section'
        );
        return {
            status: 'skipped',
            path: filePath,
            varCount: 0,
            reason: 'no deployment_config — operator skipped',
        };
    }

    const keys = Object.keys(values).sort();
    if (keys.length === 0) {
        return {
            status: 'skipped',
            path: filePath,
            varCount: 0,
            reason: 'deployment_config row exists but is empty',
        };
    }

    const contents = serializeEnvFile(values, keys);
    try {
        await writeFile(filePath, contents, 0o600);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ projectId, filePath, err: msg }, 'failed to write .env.local');
        return {
            status: 'error',
            path: filePath,
            varCount: 0,
            reason: `failed to write .env.local: ${msg}`,
        };
    }

    log.info(
        { projectId, filePath, varCount: keys.length },
        'wrote .env.local from deployment_config'
    );
    return {
        status: 'written',
        path: filePath,
        varCount: keys.length,
        reason: `materialised ${keys.length} env var${keys.length === 1 ? '' : 's'}`,
    };
}

/**
 * Read the same values without writing to disk. Aegis uses this to
 * generate `vercel deploy --env KEY=VALUE` flags so Vercel's runtime
 * gets the secrets too (build-time `.env.local` only covers `next build`).
 */
export async function readDeploymentEnv(
    projectId: string,
): Promise<DeploymentConfigValues | null> {
    return resolveAppEnvValues(projectId);
}

/**
 * BPF-35 — resolve the project's app env, preferring the headless app-env file
 * (`KAGEOPS_APP_ENV_FILE`) over the Electron-encrypted `deployment_config`.
 *
 * The file is the headless self-deploy credential source: with no Electron
 * `safeStorage` to decrypt the stored config, a headless run had no app
 * credentials and deployed to Vercel with no `--env`. When the file is unset,
 * empty, or unreadable we fall through to the encrypted store (the desktop
 * path), so the change is invisible to the GUI.
 *
 * The returned map feeds `.env.local` + `vercel deploy --env` only; it is NEVER
 * assigned into `process.env` (BPF-19 — the app's own DATABASE_URL must not
 * reach the orchestrator and hijack the embedded DB).
 */
export async function resolveAppEnvValues(
    projectId: string,
): Promise<DeploymentConfigValues | null> {
    const filePath = appEnvFilePath();
    if (filePath !== null) {
        const fromFile = loadAppEnvFile(filePath, nodeFs.readFileSync);
        if (fromFile !== null) return fromFile;
        // File set but unreadable/empty — fall through to the stores below.
    }
    // Encrypted deployment_config is commercial — null reader in the open build.
    if (deploymentConfigReader !== null) {
        const fromConfig = await deploymentConfigReader(projectId);
        if (fromConfig !== null) return fromConfig;
    }
    // Phase 2b — OS-keychain "key register" (open; the open build's primary
    // persistent app-secret store). Last resort so the encrypted store wins
    // when both are present on a commercial desktop install.
    if (appEnvKeychainReader !== null) {
        return appEnvKeychainReader(projectId);
    }
    return null;
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Render the env-var map into dotenv format. Values are wrapped in
 * double quotes when they contain whitespace, `$`, backticks, or
 * embedded quotes — matching the dotenv-expand contract Next.js uses.
 */
export function serializeEnvFile(
    values: DeploymentConfigValues,
    keys: readonly string[]
): string {
    const lines: string[] = [
        '# Auto-generated by KageOps — DO NOT COMMIT.',
        '# Source: projects.deployment_config (Pillar 2.2 PR-B.1).',
        '# Edit secrets in the New-Project modal / project card → Edit deployment config.',
        '',
    ];
    for (const key of keys) {
        const raw = values[key];
        if (raw === undefined) continue;
        lines.push(`${key}=${quoteIfNeeded(raw)}`);
    }
    return `${lines.join('\n')}\n`;
}

function quoteIfNeeded(value: string): string {
    // dotenv-expand treats unquoted values as raw text up to the next
    // newline. Quote when value contains whitespace, `=`, `#`, `$`,
    // backticks, or quotes — that's the dotenv-conservative shape.
    const needsQuote = /[\s=#$`"']/u.test(value);
    if (!needsQuote) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function defaultWriteFile(filePath: string, contents: string, mode: number): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, { encoding: 'utf8', mode });
}
