/**
 * P2-04 — Vercel preview deployer.
 *
 * Spawns `vercel deploy --prebuilt --token <T> --yes` against a project
 * workspace, parses the preview URL from stdout, returns a structured
 * result. Token resolution is layered (env > keychain > ~/.vercel/auth.json)
 * per D-11 so operators with the Vercel CLI already configured get zero
 * friction while CI gets a clean env-var escape hatch.
 *
 * Pure-ish module — `runDeploy()` accepts a spawn function so unit tests
 * can drive deterministic outputs without invoking the real CLI. The
 * KageOps integration uses `child_process.spawn` directly.
 *
 * Non-features (deliberately):
 *   - No production deploys. `--prod` is never passed. The bundle's
 *     description spells this out: operator promotes manually.
 *   - No domain attachment. Custom domains live in the operator's
 *     Vercel project settings, not in KageOps.
 *   - No retry on transient network failures. Aegis re-dispatch is the
 *     retry surface; deeper retry logic belongs in P3+.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';

import { createLogger } from '../shared/logger';

const log = createLogger('VercelDeployer');

// ── Token resolution ────────────────────────────────────

const VERCEL_TOKEN_ENV = 'KAGEOPS_VERCEL_TOKEN';
const KEYCHAIN_SERVICE = 'kageops';
const KEYCHAIN_ACCOUNT = 'vercel-token';

// BPF-13: hard cap on a single `vercel deploy` invocation. The CLI can hang
// indefinitely at "Loading teams…" when it must resolve a scope for a
// first-time/unlinked deploy and has no TTY to prompt on — with no cap the
// deploy-preview task hangs until an external reaper kills it. Override via
// KAGEOPS_VERCEL_DEPLOY_TIMEOUT_MS. Default 5 minutes (real deploys finish well
// inside this).
function resolveDeployTimeoutMs(): number {
    const raw = Number(process.env.KAGEOPS_VERCEL_DEPLOY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

export interface TokenSource {
    readonly value: string;
    readonly origin: 'env' | 'keychain' | 'vercel-auth-json';
}

export interface LoadVercelTokenDeps {
    /** Reads from the OS keychain. Returns null when unavailable or empty. */
    readonly getKeychainSecret: (service: string, account: string) => Promise<string | null>;
    /** Resolves the user's home directory. Defaults to os.homedir(). */
    readonly homeDir?: () => string;
}

/**
 * Resolve a Vercel auth token from env / keychain / local Vercel CLI auth
 * config, in that order. Returns `null` when no token is found anywhere
 * — caller surfaces a clear actionable error in that case.
 */
export async function loadVercelToken(
    deps: LoadVercelTokenDeps
): Promise<TokenSource | null> {
    const envToken = process.env[VERCEL_TOKEN_ENV];
    if (typeof envToken === 'string' && envToken.length > 0) {
        return { value: envToken, origin: 'env' };
    }

    try {
        const fromKeychain = await deps.getKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (typeof fromKeychain === 'string' && fromKeychain.length > 0) {
            return { value: fromKeychain, origin: 'keychain' };
        }
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Keychain lookup for vercel-token failed — falling through to ~/.vercel/auth.json'
        );
    }

    const home = (deps.homeDir ?? os.homedir)();
    const authJsonPath = path.join(home, '.vercel', 'auth.json');
    try {
        const raw = await fs.readFile(authJsonPath, 'utf8');
        const parsed = JSON.parse(raw) as { token?: unknown };
        if (typeof parsed.token === 'string' && parsed.token.length > 0) {
            return { value: parsed.token, origin: 'vercel-auth-json' };
        }
    } catch (err) {
        // ENOENT here is expected for operators without the Vercel CLI;
        // anything else is logged but non-fatal — `null` still surfaces.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), path: authJsonPath },
                'Reading ~/.vercel/auth.json failed — continuing without a fallback token'
            );
        }
    }

    return null;
}

// ── Deploy ──────────────────────────────────────────────

export interface DeployPreviewInput {
    /** Workspace to deploy from (must be a built Next.js project). */
    readonly cwd: string;
    /** Resolved Vercel token. */
    readonly token: TokenSource;
    /** Optional Vercel scope (team slug). Omit to use operator's personal scope (D-12). */
    readonly scope?: string;
    /**
     * Pillar 2.2 / PR-D — per-deployment runtime env. Each KEY=VALUE
     * is passed as `--env KEY=VALUE` to `vercel deploy`. Without
     * these, the deployed page boots with no Clerk/Neon/Stripe env
     * and crashes at first request — defeating the AcceptanceGate v2
     * `/` 200 check.
     *
     * Keys land in this Vercel deployment only — they don't pollute
     * the operator's Vercel project's persistent env settings.
     */
    readonly runtimeEnv?: Readonly<Record<string, string>>;
}

export interface DeployPreviewResult {
    readonly status: 'success' | 'failure';
    readonly previewUrl?: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly durationMs: number;
}

export type SpawnFn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
) => ChildProcessWithoutNullStreams;

/**
 * Run the deploy. Pure-ish — accepts the spawn function as a dependency
 * so tests can plug in a fake child process with deterministic stdout.
 *
 * Args are a closed set of literals chosen by this module; no operator
 * input is concatenated, so shell injection is not a risk.
 */
/**
 * Build the `--env KEY=VALUE` argv for `vercel deploy` (BPF-5).
 *
 * On Windows the deploy is spawned with `shell:true` (a `.cmd` shim needs a
 * shell), and Node then raw-joins argv into a single `cmd /c "..."` string with
 * NO per-arg escaping. A value like a Neon `DATABASE_URL` containing
 * `…&channel_binding=require` therefore breaks the command: cmd treats `&` as a
 * command separator, runs the `vercel deploy …` prefix, then tries to run
 * `channel_binding=require` as its own command ("not recognized…") and the
 * deploy dies. Wrapping each `KEY=VALUE` token in double quotes makes cmd treat
 * it literally (it doesn't split on `&|<>^` inside quotes); vercel's own arg
 * parser then strips the quotes. POSIX passes args directly (no shell parsing),
 * so the value is passed verbatim there.
 *
 * Defensive rejections (mirroring the prior newline guard): a newline would
 * terminate the flag; on Windows a double-quote in the value can't be safely
 * wrapped, so reject it rather than emit a corrupt command line. App
 * credentials (API keys, connection strings) never contain either.
 */
export function buildDeployEnvArgs(
    runtimeEnv: Readonly<Record<string, string>>,
    isWindows: boolean
): readonly string[] {
    const args: string[] = [];
    for (const [key, value] of Object.entries(runtimeEnv)) {
        if (/[\r\n]/.test(value)) {
            throw new Error(
                `vercel deploy: env value for ${key} contains a newline — refusing to pass to CLI`
            );
        }
        if (isWindows && value.includes('"')) {
            throw new Error(
                `vercel deploy: env value for ${key} contains a double-quote — cannot be safely quoted for the Windows shell`
            );
        }
        const pair = `${key}=${value}`;
        // Windows shell:true → quote so cmd doesn't split on & | < > ^.
        // POSIX shell:false → pass verbatim (adding quotes would leak literal " into the value).
        args.push('--env', isWindows ? `"${pair}"` : pair);
    }
    return args;
}

export async function runDeploy(
    input: DeployPreviewInput,
    spawnFn: SpawnFn
): Promise<DeployPreviewResult> {
    // Windows: `vercel` ships as `.cmd` and must be launched via shell. With
    // shell:true Node RAW-JOINS argv into a cmd command string (no per-arg
    // escaping), so `--env` values are shell-interpreted on Windows — see
    // buildDeployEnvArgs for the quoting that fixes BPF-5.
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'vercel.cmd' : 'vercel';

    const args: string[] = ['deploy', '--prebuilt', '--token', input.token.value, '--yes'];
    if (input.scope !== undefined && input.scope.length > 0) {
        args.push('--scope', input.scope);
    }
    if (input.runtimeEnv !== undefined) {
        args.push(...buildDeployEnvArgs(input.runtimeEnv, isWindows));
    }

    const timeoutMs = resolveDeployTimeoutMs();

    return new Promise((resolve) => {
        const startTime = Date.now();
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        let settled = false;

        const child = spawnFn(command, args, {
            cwd: input.cwd,
            shell: isWindows,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        // BPF-13: fail fast instead of hanging forever on the "Loading teams…"
        // stall. Kill the CLI and return an actionable failure.
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                child.kill();
            } catch {
                /* process already gone */
            }
            resolve({
                status: 'failure',
                stdout: stdoutChunks.join(''),
                stderr:
                    `${stderrChunks.join('')}\n` +
                    `vercel deploy timed out after ${timeoutMs}ms — the CLI stalled resolving the Vercel ` +
                    `scope/teams for an unlinked project. Set KAGEOPS_VERCEL_SCOPE to your team or username, ` +
                    `or VERCEL_ORG_ID + VERCEL_PROJECT_ID to pre-link the project.`,
                exitCode: null,
                durationMs: Date.now() - startTime,
            });
        }, timeoutMs);
        // Don't let the timer keep the event loop alive on its own.
        (timer as { unref?: () => void }).unref?.();

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
        });

        child.on('close', (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const stdout = stdoutChunks.join('');
            const stderr = stderrChunks.join('');
            const previewUrl = extractPreviewUrl(stdout) ?? extractPreviewUrl(stderr) ?? undefined;
            const status: 'success' | 'failure' =
                code === 0 && previewUrl !== undefined ? 'success' : 'failure';
            resolve({
                status,
                ...(previewUrl !== undefined ? { previewUrl } : {}),
                stdout,
                stderr,
                exitCode: code,
                durationMs: Date.now() - startTime,
            });
        });

        child.on('error', (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                status: 'failure',
                stdout: stdoutChunks.join(''),
                stderr: err.message,
                exitCode: null,
                durationMs: Date.now() - startTime,
            });
        });
    });
}

/**
 * Extract the first https://*.vercel.app URL from a chunk of CLI output.
 * Vercel CLI's deploy output prints the preview URL on its own line
 * (often as `https://<project>-<hash>-<scope>.vercel.app`). We pick the
 * first match — there's only ever one preview per invocation.
 *
 * Exposed for tests so the regex can be exercised directly.
 */
export function extractPreviewUrl(output: string): string | null {
    const re = /https:\/\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.vercel\.app(?:\/[^\s]*)?/;
    const match = output.match(re);
    return match !== null ? match[0] : null;
}
