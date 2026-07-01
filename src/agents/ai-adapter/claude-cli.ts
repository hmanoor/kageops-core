/**
 * Claude Code CLI provider — invokes the `claude` binary as a first-class
 * adapter target. Also serves as the fallback when Claude API calls have
 * no API key set.
 *
 * Electron processes don't inherit the shell PATH, so `spawn('claude')`
 * fails with ENOENT even when `which claude` works in the user's terminal.
 * We resolve the absolute binary path once and cache it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sanitizeSpawnArgs as sanitizeArgs } from '../ai-adapter-resilience';
import { calculateCost, estimateTokens } from './cost';
import { runProcess, runProcessStream } from './http';
import { safeSubprocessCwd } from './subprocess-cwd';
import type { AiRequestOptions, AiResponse, ProviderConfig } from './types';

let cachedClaudeCliPath: string | null | undefined;

/** Test-only: reset the cached binary path so env var changes take effect. */
export function _resetClaudeCliPathCacheForTests(): void {
    cachedClaudeCliPath = undefined;
}

/**
 * Given the absolute path to a `claude.cmd` npm shim, return the absolute path
 * to the underlying claude.js script it invokes — or null if it can't be located.
 *
 * Mirror of resolveCodexNodeScript in codex-cli.ts. Used so we can bypass
 * the .cmd shim entirely and spawn `node claude.js` directly with a
 * --require preload that monkey-patches child_process.spawn to force
 * windowsHide:true on every grandchild. Without this, Claude CLI's
 * internal MCP / git / shell helper spawns pop visible cmd.exe windows
 * during every agent task on Windows.
 *
 * Tries the documented npm-global layout first, then a couple of fallback
 * conventions @anthropic-ai/claude-code has used historically:
 *   %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js
 *   %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.js
 */
export function resolveClaudeNodeScript(cmdPath: string): string | null {
    if (!cmdPath.toLowerCase().endsWith('.cmd')) return null;
    const dir = path.dirname(cmdPath);
    const candidates = [
        path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.js'),
        path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'dist', 'cli.js'),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* try next */ }
    }
    return null;
}

export function resolveClaudeCliBinary(): string | null {
    if (cachedClaudeCliPath !== undefined) return cachedClaudeCliPath;

    const override = process.env['KAGEOPS_CLAUDE_CLI_PATH'];
    if (override !== undefined && override !== '' && fs.existsSync(override)) {
        cachedClaudeCliPath = override;
        return override;
    }

    const home = os.homedir();
    const isWindows = process.platform === 'win32';

    // Posix candidates — extension-less. Windows candidates carry the
    // .exe/.cmd suffix because Node won't auto-resolve PATHEXT for spawn().
    const baseCandidates = [
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'bin', 'claude'),
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.nvm', 'versions', 'node', process.version, 'bin', 'claude'),
    ];

    // Expand each base path with the platform's executable extensions so
    // a Windows install at e.g. `~/.local/bin/claude.exe` is found even
    // though the base list uses Posix-style extension-less names.
    const exts = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
    const expanded: string[] = [];
    for (const base of baseCandidates) {
        for (const ext of exts) expanded.push(base + ext);
    }

    // Windows-specific install locations
    if (isWindows) {
        expanded.push(
            'C:\\Program Files\\Claude\\claude.exe',
            'C:\\Program Files\\Anthropic\\Claude\\claude.exe',
            path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
            path.join(home, 'AppData', 'Roaming', 'npm', 'claude.exe'),
            path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
            path.join(home, 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe'),
        );
    }

    for (const candidate of expanded) {
        try {
            if (fs.existsSync(candidate)) {
                cachedClaudeCliPath = candidate;
                return candidate;
            }
        } catch { /* ignore */ }
    }

    // Last resort: walk PATH ourselves. Electron processes don't always
    // inherit the full shell PATH, but when they do this catches installs
    // in non-canonical locations (e.g. a manual symlink farm).
    try {
        const pathEnv = process.env['PATH'] ?? '';
        const sep = isWindows ? ';' : ':';
        const dirs = pathEnv.split(sep).filter((d) => d !== '');
        for (const dir of dirs) {
            for (const ext of exts) {
                const c = path.join(dir, 'claude' + ext);
                if (fs.existsSync(c)) {
                    cachedClaudeCliPath = c;
                    return c;
                }
            }
        }
    } catch { /* ignore */ }

    cachedClaudeCliPath = null;
    return null;
}

/**
 * Invoke the Claude Code CLI (`claude -p ...`) as a first-class provider.
 *
 * Config shape:
 *   - `claude-cli` alone or `claude-cli/<model>` — model is passed via `--model`.
 *     Claude CLI accepts aliases (sonnet, opus, haiku) or full IDs (claude-sonnet-4-...).
 * Options:
 *   - `options.onStream` pipes raw stdout chunks as they arrive (text mode only).
 * Env:
 *   - `KAGEOPS_CLAUDE_CLI_TIMEOUT_MS` overrides the 5-minute default.
 *
 * Cost is reported as $0 because Claude Code runs under a subscription — the
 * adapter does not see per-call pricing, so downstream budget gates rely on
 * token estimates alone.
 */
export async function sendClaudeCliPrompt(
    config: ProviderConfig | undefined,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions = {}
): Promise<AiResponse> {
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
    // F-381 (spawn ENAMETOOLONG): the prompt used to be passed as a CLI
    // argument here. Windows argv limit is ~32KB; a multi-thousand-line
    // brand brief + Sensei system prompt blew past it and project
    // creation died with `spawn ENAMETOOLONG`. We now pipe the prompt
    // via stdin instead — Claude CLI's `--print` mode reads stdin when
    // no positional prompt arg is given.
    //
    // --dangerously-skip-permissions: prevents interactive permission
    // prompts when running headless (no TTY). Safe because we control
    // the prompt.
    const rawArgs: string[] = ['--print', '--dangerously-skip-permissions'];

    // Only forward --model when the caller explicitly chose the claude-cli provider.
    // In the API-key-absent fallback path the config.model is a full Anthropic API ID
    // (e.g. `claude-sonnet-4-20250514`) which the CLI does not accept — let it default.
    const isExplicitCli = config?.provider === 'claude-cli';
    const modelName = (config?.model ?? '').trim();
    if (isExplicitCli && modelName !== '' && modelName !== 'claude-cli') {
        rawArgs.push('--model', modelName);
    }

    // Scrub NUL bytes — Node's child_process rejects args containing '\0'
    // with `ERR_INVALID_ARG_VALUE`. Streamed agent reflections and pasted
    // tool output occasionally carry stray nulls that would otherwise kill
    // the entire fallback chain.
    const args: string[] = sanitizeArgs(rawArgs);

    const timeoutMs = Number(process.env['KAGEOPS_CLAUDE_CLI_TIMEOUT_MS'] ?? 300_000);

    const binary = resolveClaudeCliBinary();
    if (binary === null) {
        throw new Error(
            'Claude CLI binary not found. Install with `npm install -g @anthropic-ai/claude-code`, ' +
            'or set KAGEOPS_CLAUDE_CLI_PATH to the absolute path. ' +
            'Alternatively, switch the active preset to openrouter_budget or ollama.'
        );
    }

    // On Windows the Claude CLI ships as `claude.cmd`, an npm shim that calls
    // `node claude.js %*`. Spawning the .cmd directly works (with shell:true
    // for the cmd.exe wrapper), but Claude's internal grandchild spawns
    // (MCP servers, git helpers, model API clients) do NOT inherit our
    // windowsHide:true and pop visible cmd.exe windows during every agent
    // task. Bypass the shim — spawn Electron's bundled Node directly on the
    // resolved claude.js, with a --require preload that monkey-patches
    // child_process.spawn so every grandchild gets windowsHide:true. Mirror
    // of the codex-cli fix in PR #126.
    let spawnBinary = binary;
    let spawnArgs = args;
    const extraEnv: Record<string, string> = {};
    if (process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd')) {
        const script = resolveClaudeNodeScript(binary);
        if (script !== null) {
            spawnBinary = process.execPath;
            // Preload lives at dist/main/codex-windowshide-preload.js
            // — the preload is platform-generic (it monkey-patches spawn
            // regardless of which CLI is calling), so we reuse it.
            const preloadPath = path.join(__dirname, '..', '..', 'main', 'codex-windowshide-preload.js');
            const preloadArgs = fs.existsSync(preloadPath) ? ['--require', preloadPath] : [];
            spawnArgs = [...preloadArgs, script, ...args];
            extraEnv['ELECTRON_RUN_AS_NODE'] = '1';
        }
    }

    // Strip ANTHROPIC_API_KEY: if set, claude CLI uses API-key mode (requires paid API plan)
    // instead of the user's claude.ai subscription. We always want subscription mode here.
    const cliEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY')
    ) as NodeJS.ProcessEnv;
    Object.assign(cliEnv, extraEnv);

    // Project workspace cwd. CRITICAL: without this, Claude CLI would inherit
    // the parent's cwd (the KageOps repo), read KageOps's CLAUDE.md, and write
    // output files into the source tree (RG-1: it overwrote landing/index.html
    // during a benchmark). safeSubprocessCwd guarantees we NEVER inherit the
    // repo — a missing cwd redirects to an isolated scratch dir instead.
    const { cwd, redirected } = safeSubprocessCwd(options.cwd);
    if (redirected) {
        // eslint-disable-next-line no-console
        console.warn(
            '[claude-cli] WARNING: no cwd provided — redirecting to an isolated scratch ' +
            'dir so the subprocess cannot write into the KageOps source tree (RG-1). ' +
            'The calling agent should pass options.cwd (the project workspace).'
        );
    }

    // Compose the stream consumer:
    //   1. The caller's onStream handler (if any) for token-by-token UI rendering.
    //   2. The Agent Terminal bus publisher (if a `terminal` context is set) for
    //      the read-only Terminal panel (B-497). Both are fire-and-forget so a
    //      misbehaving consumer cannot tear down the subprocess.
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
                            source: 'claude-cli',
                            stream: 'stdout',
                            chunk,
                            ts: Date.now(),
                        },
                    }).catch(() => { /* never let bus errors break CLI run */ });
                }
            }
            : undefined;

    // F-381: scrub NUL bytes from the stdin payload too. Previously
    // sanitizeArgs() caught nulls in argv because the prompt lived there;
    // now that we pipe via stdin, the same guarantee belongs at the
    // stdin boundary. Some downstream CLI tooling chokes on embedded NULs.
    const stdinPayload = fullPrompt.replace(/\0/g, '');
    const output = composedStream !== undefined
        ? await runProcessStream(spawnBinary, spawnArgs, composedStream, timeoutMs, cliEnv, cwd, stdinPayload)
        : await runProcess(spawnBinary, spawnArgs, timeoutMs, cliEnv, cwd, stdinPayload);

    const trimmed = output.trim();
    const reportedModel = isExplicitCli && modelName !== '' && modelName !== 'claude-cli'
        ? `claude-cli/${modelName}`
        : 'claude-cli';
    const tokensIn = estimateTokens(fullPrompt);
    const tokensOut = estimateTokens(trimmed);
    // F-363: synthetic cost based on the underlying model's API rate. The
    // CLI is subscription-billed (operator pays Anthropic Pro/Max monthly,
    // not per-call), but a real number here is what feeds the budget kill,
    // cost dashboards, and benchmark math. Treat as an estimate, not a bill.
    return {
        text: trimmed,
        tokensIn,
        tokensOut,
        costUsd: calculateCost(reportedModel, tokensIn, tokensOut),
        model: reportedModel,
        durationMs: 0,
    };
}
