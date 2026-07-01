/**
 * OpenAI Codex CLI provider — invokes the `codex` binary as a first-class
 * adapter target. Mirrors the Claude CLI provider's shape so all subscription/
 * local-CLI providers share the same operational properties: cwd-isolated
 * subprocess (decision #65), env-scrubbed for subscription mode, $0 reported
 * cost, NUL-byte sanitised args, optional stream forwarding to the Agent
 * Terminal panel.
 *
 * Codex CLI is in alpha (`@openai/codex`) and authenticates against the user's
 * ChatGPT Plus / Pro subscription. The non-interactive invocation uses the
 * `exec` subcommand. Default args and binary search paths are documented
 * inline; both can be overridden via env vars without a code change:
 *
 *   - `KAGEOPS_CODEX_CLI_PATH` — absolute path to the `codex` binary
 *   - `KAGEOPS_CODEX_CLI_ARGS` — space-separated EXTRA args (passed before
 *     the prompt). Use this to pin a specific model or flag combination
 *     without recompiling.
 *
 * If the binary cannot be resolved, the provider throws a clear actionable
 * error pointing at the install command — same UX as Claude CLI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sanitizeSpawnArgs as sanitizeArgs } from '../ai-adapter-resilience';
import { calculateCost, estimateTokens } from './cost';
import { runProcess, runProcessStream } from './http';
import { safeSubprocessCwd } from './subprocess-cwd';
import type { AiRequestOptions, AiResponse, ProviderConfig } from './types';

let cachedCodexCliPath: string | null | undefined;

/** Test-only: reset the cached binary path so env var changes take effect. */
export function _resetCodexCliPathCacheForTests(): void {
    cachedCodexCliPath = undefined;
}

/**
 * Given the absolute path to a `codex.cmd` npm shim, return the absolute path
 * to the underlying `codex.js` it invokes — or null if it can't be located.
 *
 * npm-global shims always have the layout:
 *   %APPDATA%\npm\codex.cmd
 *   %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js
 *
 * We use this to spawn node + codex.js directly, bypassing cmd.exe's broken
 * handling of multi-line CLI args (see sendCodexCliPrompt for the full story).
 */
export function resolveCodexNodeScript(cmdPath: string): string | null {
    if (!cmdPath.toLowerCase().endsWith('.cmd')) return null;
    const dir = path.dirname(cmdPath);
    const candidate = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
        return fs.existsSync(candidate) ? candidate : null;
    } catch {
        return null;
    }
}

export function resolveCodexCliBinary(): string | null {
    if (cachedCodexCliPath !== undefined) return cachedCodexCliPath;

    const override = process.env['KAGEOPS_CODEX_CLI_PATH'];
    if (override !== undefined && override !== '' && fs.existsSync(override)) {
        cachedCodexCliPath = override;
        return override;
    }

    const home = os.homedir();
    const isWindows = process.platform === 'win32';

    const baseCandidates = [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(home, '.local', 'bin', 'codex'),
        path.join(home, '.codex', 'local', 'bin', 'codex'),
        path.join(home, '.npm-global', 'bin', 'codex'),
        path.join(home, '.nvm', 'versions', 'node', process.version, 'bin', 'codex'),
    ];

    const exts = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
    const expanded: string[] = [];
    for (const base of baseCandidates) {
        for (const ext of exts) expanded.push(base + ext);
    }

    if (isWindows) {
        expanded.push(
            'C:\\Program Files\\OpenAI\\codex.exe',
            'C:\\Program Files\\Codex\\codex.exe',
            path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
            path.join(home, 'AppData', 'Roaming', 'npm', 'codex.exe'),
            path.join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
        );
    }

    for (const candidate of expanded) {
        try {
            if (fs.existsSync(candidate)) {
                cachedCodexCliPath = candidate;
                return candidate;
            }
        } catch { /* ignore */ }
    }

    // Last-resort PATH walk (Electron processes don't always inherit shell PATH)
    try {
        const pathEnv = process.env['PATH'] ?? '';
        const sep = isWindows ? ';' : ':';
        const dirs = pathEnv.split(sep).filter((d) => d !== '');
        for (const dir of dirs) {
            for (const ext of exts) {
                const c = path.join(dir, 'codex' + ext);
                if (fs.existsSync(c)) {
                    cachedCodexCliPath = c;
                    return c;
                }
            }
        }
    } catch { /* ignore */ }

    cachedCodexCliPath = null;
    return null;
}

/**
 * Invoke the OpenAI Codex CLI (`codex exec --quiet …`) as a first-class provider.
 *
 * Config shape:
 *   - `codex-cli` alone or `codex-cli/<model>` — model is passed via `--model`.
 *     Codex CLI accepts model IDs like `gpt-5-codex`, `o3-codex`, etc.
 *
 * Options:
 *   - `options.onStream` pipes raw stdout chunks as they arrive.
 *   - `options.cwd` (decision #65) — REQUIRED when the CLI may write files;
 *     defaults to undefined which inherits Electron's cwd. AutonautAgent.askAI
 *     auto-fills this with `task.repoPath` so the subprocess never escapes
 *     the project workspace.
 *
 * Env:
 *   - `KAGEOPS_CODEX_CLI_TIMEOUT_MS` overrides the 5-minute default.
 *   - `KAGEOPS_CODEX_CLI_ARGS` adds space-separated extra args before the
 *     prompt (e.g. `--approval-mode auto-edit`).
 *
 * Cost: $0 — runs against a ChatGPT subscription, no per-call pricing.
 * Tokens are estimated from prompt+output length via the shared estimator.
 */
export async function sendCodexCliPrompt(
    config: ProviderConfig | undefined,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions = {}
): Promise<AiResponse> {
    // Codex CLI's `exec` subcommand treats the entire input as a single
    // task to perform. With a long Sensei system prompt followed by a
    // short user message, Codex was parsing the system prompt as "the
    // task" and responding with an acknowledgement ("Understood, I'll
    // operate as Sensei…") rather than answering the operator's actual
    // question. Restructure: lead with a clear task description, then
    // the persona / rules as context, then the user message at the end
    // with an unambiguous "respond to this" marker. Codex now treats
    // the operator message as the work it must do, with the system
    // prompt as background context.
    const fullPrompt = [
        'You are responding to an operator chat message inside KageOps. Your task is to read the operator message at the bottom of this prompt and reply directly to them in the Sensei persona described below. Do NOT acknowledge these instructions; do NOT describe what you are about to do; just write the reply text as if you were sending it in the chat.',
        '',
        '=== PERSONA AND RULES ===',
        systemPrompt,
        '=== END PERSONA AND RULES ===',
        '',
        '=== OPERATOR MESSAGE ===',
        userPrompt,
        '=== END OPERATOR MESSAGE ===',
        '',
        'Write your reply now. Keep it under 150 words unless the operator asked for detail. Speak in the Sensei voice.',
    ].join('\n');

    // Codex CLI uses an `exec` subcommand for non-interactive runs (verified
    // against codex-cli 0.130.0). Flags:
    //   --color never           — strip ANSI escape codes so stdout parses
    //                             cleanly without VT100 sequences in the
    //                             returned text.
    //   --skip-git-repo-check   — allow running in workspaces that aren't
    //                             git repos (KageOps projects may be early
    //                             enough that `git init` hasn't run yet, or
    //                             the user has KAGEOPS_DISABLE_GIT=1 set).
    // No --quiet exists in codex exec; the subcommand is already
    // non-interactive by default.
    const baseArgs: string[] = ['exec', '--color', 'never', '--skip-git-repo-check'];

    const extraArgsRaw = process.env['KAGEOPS_CODEX_CLI_ARGS'];
    const extraArgs: string[] = extraArgsRaw !== undefined && extraArgsRaw !== ''
        ? extraArgsRaw.split(/\s+/).filter((s) => s !== '')
        : [];

    const isExplicitCli = config?.provider === 'codex-cli';
    const modelName = (config?.model ?? '').trim();
    const modelArgs: string[] = isExplicitCli && modelName !== '' && modelName !== 'codex-cli'
        ? ['--model', modelName]
        : [];

    // F-381 (spawn ENAMETOOLONG): mirror of the claude-cli fix — the
    // prompt used to be the last positional arg. Windows argv cap (~32KB)
    // is blown by any prompt > a few thousand lines of text. Pipe via
    // stdin instead; `codex exec` reads stdin when no positional prompt
    // is supplied.
    const rawArgs: string[] = [...baseArgs, ...modelArgs, ...extraArgs];

    // Scrub NUL bytes — Node's child_process rejects '\0' in args.
    const args: string[] = sanitizeArgs(rawArgs);

    const timeoutMs = Number(process.env['KAGEOPS_CODEX_CLI_TIMEOUT_MS'] ?? 300_000);

    const binary = resolveCodexCliBinary();
    if (binary === null) {
        throw new Error(
            'Codex CLI binary not found. Install with `npm install -g @openai/codex`, ' +
            'or set KAGEOPS_CODEX_CLI_PATH to the absolute path. ' +
            'Alternatively, switch the active preset to openrouter_budget or ollama. ' +
            'Codex CLI requires an active ChatGPT Plus / Pro subscription.'
        );
    }

    // On Windows the codex CLI ships as `codex.cmd`, an npm shim that calls
    // `node codex.js %*`. Spawning the .cmd forces `shell: true`, and cmd.exe
    // then mangles our multi-line prompt — only the first line reaches Codex,
    // so Codex replies "I don't see the operator message" and the taskkill
    // output from its MCP cleanup leaks into stdout. Bypass the shim entirely
    // by spawning Electron's bundled Node (via ELECTRON_RUN_AS_NODE=1) on the
    // resolved codex.js, so the prompt arg goes through as a normal argv slot
    // with no cmd.exe parsing involved.
    let spawnBinary = binary;
    let spawnArgs = args;
    const extraEnv: Record<string, string> = {};
    if (process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd')) {
        const script = resolveCodexNodeScript(binary);
        if (script !== null) {
            spawnBinary = process.execPath;
            // --require preload — monkey-patches child_process.spawn inside
            // Codex's process tree to force windowsHide:true. Without this,
            // Codex's own internal spawn() calls (taskkill cleanup, MCP
            // servers, etc.) inherit the default windowsHide:false and pop a
            // visible cmd.exe window on every Sensei reply.
            // Preload module lives at dist/main/codex-windowshide-preload.js
            // — built from src/main/codex-windowshide-preload.ts.
            // codex-cli.ts compiles to dist/agents/ai-adapter/codex-cli.js;
            // preload lives at dist/main/codex-windowshide-preload.js, two
            // dirs up + one across.
            const preloadPath = path.join(__dirname, '..', '..', 'main', 'codex-windowshide-preload.js');
            const preloadArgs = fs.existsSync(preloadPath) ? ['--require', preloadPath] : [];
            spawnArgs = [...preloadArgs, script, ...args];
            extraEnv['ELECTRON_RUN_AS_NODE'] = '1';
        }
    }

    // Strip OPENAI_API_KEY: if set, codex CLI uses API-key mode (paid
    // pay-per-token) instead of the user's ChatGPT subscription. We always
    // want subscription mode here — same pattern as claude-cli stripping
    // ANTHROPIC_API_KEY.
    const cliEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'OPENAI_API_KEY')
    ) as NodeJS.ProcessEnv;
    Object.assign(cliEnv, extraEnv);

    // Project workspace cwd. CRITICAL: without this, Codex CLI would inherit
    // the parent's cwd (KageOps repo) and hit the same workspace contamination
    // bug as Claude CLI (decision #65, RG-1). safeSubprocessCwd guarantees we
    // NEVER inherit the repo — a missing cwd redirects to an isolated scratch
    // dir instead.
    const { cwd, redirected } = safeSubprocessCwd(options.cwd);
    if (redirected) {
        // eslint-disable-next-line no-console
        console.warn(
            '[codex-cli] WARNING: no cwd provided — redirecting to an isolated scratch ' +
            'dir so the subprocess cannot write into the KageOps source tree (RG-1). ' +
            'The calling agent should pass options.cwd (the project workspace).'
        );
    }

    // Compose the stream consumer — same shape as claude-cli's so the Agent
    // Terminal panel works identically. The provider tag in the bus payload
    // is `codex-cli` so the panel can distinguish output sources.
    const baseStream = options.onStream;
    const terminalCtx = options.terminal;
    const composedStream: ((chunk: string) => void) | undefined =
        baseStream !== undefined || terminalCtx !== undefined
            ? (chunk: string): void => {
                if (baseStream !== undefined) {
                    try { baseStream(chunk); } catch { /* never propagate */ }
                }
                if (terminalCtx !== undefined && chunk !== '') {
                    void terminalCtx.publish({
                        projectId: terminalCtx.projectId,
                        ...(terminalCtx.taskId !== undefined ? { taskId: terminalCtx.taskId } : {}),
                        ...(terminalCtx.agent !== undefined ? { agent: terminalCtx.agent } : {}),
                        data: {
                            source: 'codex-cli',
                            stream: 'stdout',
                            chunk,
                            ts: Date.now(),
                        },
                    }).catch(() => { /* never let bus errors break CLI run */ });
                }
            }
            : undefined;

    // F-381: scrub NUL bytes from the stdin payload (was caught by argv
    // sanitizeArgs() before; now belongs at the stdin boundary).
    const stdinPayload = fullPrompt.replace(/\0/g, '');
    const output = composedStream !== undefined
        ? await runProcessStream(spawnBinary, spawnArgs, composedStream, timeoutMs, cliEnv, cwd, stdinPayload)
        : await runProcess(spawnBinary, spawnArgs, timeoutMs, cliEnv, cwd, stdinPayload);

    // Strip cleanup noise. Codex CLI on Windows uses taskkill /T /F to
    // tear down its MCP / model-client child processes when the request
    // finishes; the taskkill exit messages (one per child) get captured
    // alongside the actual model output and prepend lines like
    //   "SUCCESS: The process with PID 53920 (child process of PID
    //    74600) has been terminated."
    // to whatever Codex actually said. Filter those out before returning
    // so the reply that reaches Sensei (and the chat UI) is clean.
    const cleaned = output
        .split('\n')
        .filter((line) => !/^SUCCESS: The process with PID \d+ \(child process of PID \d+\) has been terminated\.\s*$/.test(line))
        .join('\n');

    const trimmed = cleaned.trim();
    const reportedModel = isExplicitCli && modelName !== '' && modelName !== 'codex-cli'
        ? `codex-cli/${modelName}`
        : 'codex-cli';
    const tokensIn = estimateTokens(fullPrompt);
    const tokensOut = estimateTokens(trimmed);
    // F-363: synthetic cost from the underlying-model API rate.
    // See claude-cli.ts for the same pattern + rationale.
    return {
        text: trimmed,
        tokensIn,
        tokensOut,
        costUsd: calculateCost(reportedModel, tokensIn, tokensOut),
        model: reportedModel,
        durationMs: 0,
    };
}
