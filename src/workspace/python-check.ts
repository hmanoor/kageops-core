/**
 * KageOps Python/uvx Availability Check
 *
 * Detects whether uvx (the recommended code-review-graph launcher) or
 * a raw Python 3.10+ installation is available on the system.
 *
 * Result is cached after the first check — no repeated process spawns.
 */

import { spawn } from 'child_process';
import { createLogger } from '../shared/logger';

const log = createLogger('PythonCheck');

// ── Types ─────────────────────────────────────────────

export interface UvxCheckResult {
    readonly available: boolean;
    /** The command to use when spawning the MCP server */
    readonly command: string;
    /** Human-readable version string, or null if not detected */
    readonly version: string | null;
    /** How the tool was found */
    readonly method: 'uvx' | 'python' | 'none';
}

// ── Cache ─────────────────────────────────────────────

let cachedResult: UvxCheckResult | null = null;

// ── Main export ───────────────────────────────────────

/**
 * Check whether uvx or python (with code-review-graph installed) is available.
 * Result is cached — safe to call multiple times.
 */
export async function checkUvxAvailable(): Promise<UvxCheckResult> {
    if (cachedResult !== null) {
        return cachedResult;
    }

    // Try uvx first (recommended, zero-install launcher)
    const uvxResult = await tryCommand('uvx', ['--version'], 5000);
    if (uvxResult !== null) {
        log.info({ version: uvxResult }, 'uvx detected — LiteLLM proxy available');
        cachedResult = { available: true, command: 'uvx', version: uvxResult, method: 'uvx' };
        return cachedResult;
    }

    // Fallback: try python -m code_review_graph (requires pip install)
    const pythonCmds = ['python', 'python3', 'py'];
    for (const py of pythonCmds) {
        const pyResult = await tryCommand(py, ['-m', 'code_review_graph', '--version'], 5000);
        if (pyResult !== null) {
            log.info({ command: py, version: pyResult }, 'Python code-review-graph detected');
            cachedResult = { available: true, command: py, version: pyResult, method: 'python' };
            return cachedResult;
        }
    }

    log.warn('Neither uvx nor code-review-graph found — CodeGraphBridge will run in degraded mode');
    cachedResult = { available: false, command: '', version: null, method: 'none' };
    return cachedResult;
}

/**
 * Reset the cached result — for testing only.
 */
export function resetUvxCheckForTesting(): void {
    cachedResult = null;
}

// ── Helpers ───────────────────────────────────────────

function tryCommand(command: string, args: string[], timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        let proc: ReturnType<typeof spawn>;
        try {
            proc = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true,
            });
        } catch {
            resolve(null);
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            try { proc.kill(); } catch { /* ignore */ }
            resolve(null);
        }, timeoutMs);

        proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return;

            if (code === 0) {
                const version = stdout.trim() || stderr.trim() || 'unknown';
                resolve(version);
            } else {
                resolve(null);
            }
        });

        proc.on('error', () => {
            clearTimeout(timer);
            if (!timedOut) resolve(null);
        });
    });
}
