/**
 * Low-level HTTP + subprocess helpers.
 *
 * `httpRequest` / `httpStreamRequest` are thin wrappers around Node's
 * built-in http/https modules — kept here so tests can mock `https.request`
 * and `http.request` once and have every provider path pick it up.
 *
 * `runProcess` / `runProcessStream` drive the Claude CLI provider.
 */

import { spawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';

export interface HttpRequestOptions {
    readonly hostname: string;
    readonly path: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly port?: number;
    readonly protocol?: string;
}

export function httpRequest(options: HttpRequestOptions, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const isHttp = options.protocol === 'http:';
        const lib = isHttp ? http : https;
        const requestOptions = {
            hostname: options.hostname,
            path: options.path,
            method: options.method,
            headers: { ...options.headers, 'Content-Length': Buffer.byteLength(body).toString() },
            port: options.port,
        };

        const req = lib.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== undefined && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                } else {
                    resolve(data);
                }
            });
        });

        // 5 minute timeout — generous for large cloud models, prevents infinite hangs
        if (typeof req.setTimeout === 'function') {
            req.setTimeout(300_000, () => {
                req.destroy(new Error('Request timed out after 5 minutes'));
            });
        }

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

export function httpStreamRequest(
    options: HttpRequestOptions,
    body: string,
    onChunk: (chunk: string) => void
): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const isHttp = options.protocol === 'http:';
        const lib = isHttp ? http : https;
        const requestOptions = {
            hostname: options.hostname,
            path: options.path,
            method: options.method,
            headers: { ...options.headers, 'Content-Length': Buffer.byteLength(body).toString() },
            port: options.port,
        };

        const req = lib.request(requestOptions, (res) => {
            if (res.statusCode !== undefined && res.statusCode >= 400) {
                let errorData = '';
                res.on('data', (chunk) => { errorData += chunk; });
                res.on('end', () => {
                    reject(new Error(`HTTP ${res.statusCode}: ${errorData}`));
                });
                return;
            }

            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                onChunk(chunk);
            });
            res.on('end', () => {
                resolve(res);
            });
            res.on('error', reject);
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Windows-only: detect a batch-file binary. Node 18.20+ / 20+ refuses to
 * spawn `.cmd` / `.bat` / `.ps1` files without `shell: true` and throws
 * EINVAL (CVE-2024-27980 hardening). Both Claude CLI and Codex CLI install
 * as `%APPDATA%\npm\<name>.cmd` shims, so the legacy code path was hitting
 * EINVAL on every Windows install — completely blocking subscription
 * routing for both providers.
 */
function isWindowsBatchFile(command: string): boolean {
    if (process.platform !== 'win32') return false;
    const lower = command.toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1');
}

/**
 * Quote an arg for safe inclusion in a `cmd.exe /d /s /c "<line>"` string.
 * When `shell: true` is set on Windows, Node forwards the whole command as
 * one string to cmd.exe without per-arg escaping — we have to do it.
 * The doublequote-doubling pattern (`"` → `""`) is the cmd.exe-native
 * escape; wrapping in surrounding doublequotes protects whitespace and
 * cmd metacharacters (`& | < > ^ ( ) % ! , ; =`).
 */
function quoteForWindowsShell(arg: string): string {
    if (arg === '') return '""';
    if (!/[\s"&|<>^()%!,;=`]/.test(arg)) return arg;
    return '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * Forcefully terminate a spawned subprocess AND its descendants.
 *
 * BPF-18 (claude-cli orphan wedge): `proc.kill('SIGKILL')` only terminates
 * the *direct* child. The claude-cli adapter spawns `node claude.js`, which
 * in turn spawns its own grandchildren (MCP servers, git helpers, model API
 * clients). On a timeout, killing only the direct child left those
 * grandchildren running — 20+ idle `claude.exe`/`node` orphans accumulated
 * across the wedged run and never released their slots. The timeout *logged*
 * "Process timed out" but the work never actually stopped.
 *
 * Windows: `taskkill /pid <pid> /T /F` walks and force-kills the whole tree
 *   (`/T` = tree, `/F` = force). Node's signal emulation can't do this.
 * POSIX: the child is spawned `detached` so it leads its own process group
 *   (pgid === pid); signalling the negative pid reaps the entire group.
 *
 * Best-effort and never throws — a failure to tree-kill falls back to the
 * single-process kill so we at least stop the direct child.
 */
export function killProcessTree(proc: ReturnType<typeof spawn>): void {
    const pid = proc.pid;
    if (pid === undefined) {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        return;
    }
    if (process.platform === 'win32') {
        try {
            // Fire-and-forget; we don't await taskkill's own exit. stdio
            // ignored + windowsHide so it doesn't pop a console window.
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
        } catch {
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }
        return;
    }
    try {
        // Negative pid → signal the whole process group (requires the child
        // to have been spawned detached so pgid === pid).
        process.kill(-pid, 'SIGKILL');
    } catch {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
}

/**
 * Build spawn options + (possibly rewritten) args so the underlying
 * subprocess invocation works across:
 *   - Posix (no rewriting)
 *   - Windows .cmd / .bat (needs shell:true + manual arg quoting)
 *   - Windows .exe (no rewriting)
 * Returns the args as the caller should pass them to spawn().
 */
function prepareSpawn(
    command: string,
    args: readonly string[],
    base: Parameters<typeof spawn>[2],
): { args: string[]; opts: Parameters<typeof spawn>[2] } {
    if (!isWindowsBatchFile(command)) {
        return { args: [...args], opts: base };
    }
    return {
        args: args.map(quoteForWindowsShell),
        opts: { ...base, shell: true } as Parameters<typeof spawn>[2],
    };
}

export function runProcess(
    command: string,
    args: string[],
    timeoutMs: number = 120_000,
    env?: NodeJS.ProcessEnv,
    cwd?: string,
    stdinPayload?: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        // F-381 (spawn ENAMETOOLONG): when the caller supplies a large
        // payload (e.g. a multi-thousand-line agent prompt), passing it
        // as an argv string blows the OS argv length cap (~32KB on
        // Windows). `stdinPayload` lets the caller pipe it via stdin
        // instead — claude/codex CLIs both accept `-p`/`--print` with
        // the prompt on stdin when no positional arg is given.
        //
        // stdin: 'ignore' (default) → /dev/null so CLIs that read stdin
        // (e.g. claude --print) don't block waiting for input and then
        // exit with a non-zero code.
        // windowsHide: true → suppress the console window Windows opens by
        // default for console-subsystem subprocesses.
        const stdin: 'ignore' | 'pipe' = stdinPayload !== undefined ? 'pipe' : 'ignore';
        // detached on POSIX gives the child its own process group so
        // killProcessTree can reap grandchildren via a negative-pid signal
        // (BPF-18). Windows uses taskkill /T instead and must NOT be detached
        // (it would spawn a new console window).
        const baseOpts: Parameters<typeof spawn>[2] = {
            stdio: [stdin, 'pipe', 'pipe'],
            env,
            windowsHide: true,
            detached: process.platform !== 'win32',
        };
        if (cwd !== undefined && cwd !== '') baseOpts.cwd = cwd;
        const prepared = prepareSpawn(command, args, baseOpts);
        const spawnOpts = prepared.opts;
        const proc = spawn(command, prepared.args, spawnOpts);
        let stdout = '';
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            killProcessTree(proc);
            reject(new Error(`Process timed out after ${timeoutMs / 1000}s: ${command} ${args.join(' ')}`));
        }, timeoutMs);

        // stdio: 'pipe' guarantees stdout/stderr are non-null Readable streams
        proc.stdout?.on('data', (data) => { stdout += data.toString(); });
        proc.stderr?.on('data', (data) => { stderr += data.toString(); });

        if (stdinPayload !== undefined && proc.stdin !== null) {
            try {
                proc.stdin.end(stdinPayload);
            } catch (err) {
                clearTimeout(timer);
                killed = true;
                killProcessTree(proc);
                reject(new Error(`Failed to write stdin: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
        }

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (killed) return;
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | stdout: ');
                reject(new Error(`Process exited with code ${code}: ${detail || '(no output)'}`));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            if (!killed) reject(err);
        });
    });
}

/**
 * Spawn a subprocess and forward each stdout chunk to `onChunk` as it arrives.
 * Returns the full accumulated stdout on successful exit. Used by the Claude CLI
 * provider to surface tokens to the UI in real time.
 */
export function runProcessStream(
    command: string,
    args: string[],
    onChunk: (chunk: string) => void,
    timeoutMs: number = 300_000,
    env?: NodeJS.ProcessEnv,
    cwd?: string,
    stdinPayload?: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        // F-381: see runProcess for the stdinPayload rationale (avoids
        // spawn ENAMETOOLONG when caller has a multi-thousand-line prompt).
        // windowsHide: true — suppress the cmd.exe console window that
        // would otherwise pop during the request for every Codex/Claude
        // CLI call.
        const stdin: 'ignore' | 'pipe' = stdinPayload !== undefined ? 'pipe' : 'ignore';
        // detached on POSIX gives the child its own process group so
        // killProcessTree can reap grandchildren via a negative-pid signal
        // (BPF-18). Windows uses taskkill /T instead and must NOT be detached
        // (it would spawn a new console window).
        const baseOpts: Parameters<typeof spawn>[2] = {
            stdio: [stdin, 'pipe', 'pipe'],
            env,
            windowsHide: true,
            detached: process.platform !== 'win32',
        };
        if (cwd !== undefined && cwd !== '') baseOpts.cwd = cwd;
        const prepared = prepareSpawn(command, args, baseOpts);
        const spawnOpts = prepared.opts;
        const proc = spawn(command, prepared.args, spawnOpts);
        let stdout = '';
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            killProcessTree(proc);
            reject(new Error(`Process timed out after ${timeoutMs / 1000}s: ${command} ${args.join(' ')}`));
        }, timeoutMs);

        // stdio: 'pipe' guarantees stdout/stderr are non-null Readable streams
        proc.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            try {
                onChunk(chunk);
            } catch {
                // A misbehaving stream consumer must not tear down the subprocess.
            }
        });
        proc.stderr?.on('data', (data) => { stderr += data.toString(); });

        if (stdinPayload !== undefined && proc.stdin !== null) {
            try {
                proc.stdin.end(stdinPayload);
            } catch (err) {
                clearTimeout(timer);
                killed = true;
                killProcessTree(proc);
                reject(new Error(`Failed to write stdin: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
        }

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (killed) return;
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Process exited with code ${code}: ${stderr}`));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            if (!killed) reject(err);
        });
    });
}
