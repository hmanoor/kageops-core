/**
 * Shell Manager — interactive child-process sessions for the Command Center
 * Interactive Shell panel.
 *
 * Each session spawns one shell (powershell / bash / cmd) and streams stdout
 * and stderr back to the renderer over the dedicated IPC channels. The user
 * types a line; we write it to stdin followed by a newline.
 *
 * Security model:
 *   - Sessions run with the same user privileges as the Electron main
 *     process. The renderer never gets direct access to child_process —
 *     all spawning is gated by this module.
 *   - shellType is restricted to the small allow-list below to prevent
 *     arbitrary executable invocation through the IPC bridge.
 *   - cwd is restricted to safe directories: KAGEOPS_DATA_DIR, the user's
 *     home directory, or any of the user's project workspaces. Anything
 *     else falls back to the home directory rather than failing loudly,
 *     so a stale cwd doesn't kill the session.
 *   - Each session has a hard cap on output buffered in memory; once the
 *     cap is hit the renderer is told and the child is killed to avoid
 *     runaway memory use from a misbehaving long-running process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { IPC } from '../shared/ipc-channels';

export type ShellType = 'powershell' | 'bash' | 'cmd';

const ALLOWED_SHELLS: readonly ShellType[] = ['powershell', 'bash', 'cmd'];

interface ShellSession {
    readonly id: string;
    readonly proc: ChildProcess;
    readonly webContents: WebContents;
    bytesEmitted: number;
}

const MAX_BYTES_PER_SESSION = 50 * 1024 * 1024; // 50 MB hard cap
const MAX_CONCURRENT_SESSIONS = 8;

const sessions = new Map<string, ShellSession>();

function shellExecutable(shellType: ShellType): { cmd: string; args: readonly string[] } {
    if (process.platform === 'win32') {
        if (shellType === 'powershell') {
            return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
        }
        if (shellType === 'cmd') {
            return { cmd: 'cmd.exe', args: ['/Q'] };
        }
        // Best-effort bash on Windows — Git Bash / WSL fallback.
        return { cmd: 'bash.exe', args: ['-i'] };
    }
    // Non-Windows: only bash is sensible; powershell/cmd fall back to bash.
    return { cmd: '/bin/bash', args: ['-i'] };
}

function resolveSafeCwd(requested: string | undefined): string {
    const home = os.homedir();
    const dataDir = process.env['KAGEOPS_DATA_DIR'] ?? path.join(home, '.kageops');
    const projectsDir = process.env['KAGEOPS_PROJECTS_DIR'] ?? path.join(home, 'kageops-projects');

    if (typeof requested !== 'string' || requested.length === 0) {
        return home;
    }
    const abs = path.resolve(requested);
    if (!existsSync(abs)) {
        return home;
    }
    const allowed = [home, dataDir, projectsDir];
    if (allowed.some((root) => abs === root || abs.startsWith(root + path.sep))) {
        return abs;
    }
    return home;
}

export interface SpawnArgs {
    readonly sessionId: string;
    readonly shellType: ShellType;
    readonly cwd: string | undefined;
    readonly webContents: WebContents;
}

export function spawnSession(args: SpawnArgs): { ok: boolean; error?: string } {
    if (sessions.has(args.sessionId)) {
        return { ok: false, error: `session ${args.sessionId} already exists` };
    }
    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return { ok: false, error: `max ${MAX_CONCURRENT_SESSIONS} concurrent sessions` };
    }
    if (!ALLOWED_SHELLS.includes(args.shellType)) {
        return { ok: false, error: `shell ${args.shellType} not allowed` };
    }

    const cwd = resolveSafeCwd(args.cwd);
    const { cmd, args: spawnArgs } = shellExecutable(args.shellType);

    let proc: ChildProcess;
    try {
        proc = spawn(cmd, [...spawnArgs], {
            cwd,
            shell: false,
            // windowsHide:true — without this, every interactive shell
            // session spawned from Mission Control pops a visible
            // PowerShell / cmd.exe window on Windows. The terminal
            // panel renders the I/O inline; the underlying console
            // window is decorative noise.
            windowsHide: true,
            env: { ...process.env, TERM: 'xterm-256color' },
        });
    } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const session: ShellSession = {
        id: args.sessionId,
        proc,
        webContents: args.webContents,
        bytesEmitted: 0,
    };
    sessions.set(args.sessionId, session);

    const emit = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (args.webContents.isDestroyed()) {
            killSession(args.sessionId);
            return;
        }
        session.bytesEmitted += chunk.length;
        if (session.bytesEmitted > MAX_BYTES_PER_SESSION) {
            try {
                args.webContents.send(IPC.SHELL_OUTPUT, {
                    sessionId: args.sessionId,
                    stream: 'stderr',
                    data: `\r\n[shell-manager] output cap (${MAX_BYTES_PER_SESSION} bytes) exceeded — session terminated.\r\n`,
                });
            } catch {
                // ignore — webContents may be torn down
            }
            killSession(args.sessionId);
            return;
        }
        try {
            args.webContents.send(IPC.SHELL_OUTPUT, {
                sessionId: args.sessionId,
                stream,
                data: chunk.toString('utf8'),
            });
        } catch (err: unknown) {
            console.warn(
                '[ShellManager] failed to send chunk:',
                err instanceof Error ? err.message : String(err),
            );
        }
    };

    proc.stdout?.on('data', (chunk: Buffer) => emit('stdout', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => emit('stderr', chunk));

    proc.on('exit', (code, signal) => {
        sessions.delete(args.sessionId);
        if (args.webContents.isDestroyed()) return;
        try {
            args.webContents.send(IPC.SHELL_EXIT, {
                sessionId: args.sessionId,
                code: code ?? null,
                signal: signal ?? null,
            });
        } catch {
            // ignore
        }
    });

    proc.on('error', (err) => {
        if (args.webContents.isDestroyed()) return;
        try {
            args.webContents.send(IPC.SHELL_OUTPUT, {
                sessionId: args.sessionId,
                stream: 'stderr',
                data: `\r\n[shell-manager] spawn error: ${err.message}\r\n`,
            });
        } catch {
            // ignore
        }
    });

    return { ok: true };
}

export function writeToSession(sessionId: string, line: string): void {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    if (session.proc.stdin === null || session.proc.stdin.destroyed) return;
    try {
        session.proc.stdin.write(line.endsWith('\n') ? line : line + '\n');
    } catch (err: unknown) {
        console.warn(
            '[ShellManager] write failed:',
            err instanceof Error ? err.message : String(err),
        );
    }
}

export function killSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    try {
        session.proc.kill();
    } catch {
        // already dead
    }
}

export function killAllSessions(): void {
    for (const id of Array.from(sessions.keys())) {
        killSession(id);
    }
}
