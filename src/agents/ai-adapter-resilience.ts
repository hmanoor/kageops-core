/**
 * KageOps AI Adapter — Resilience Helpers
 *
 * Narrow, side-effect-free utilities that harden the AI call path:
 *   - `stripNullBytes` / `sanitizeSpawnArgs` — remove NUL bytes from argv
 *     before handing to child_process.spawn (which rejects null-byte args
 *     with ERR_INVALID_ARG_VALUE). Streamed agent outputs occasionally
 *     splice in stray nulls; without this the claude-cli adapter crashes
 *     the whole fallback chain.
 *   - `isNetworkTransientError` — classifies an error as DNS/TCP outage
 *     vs provider-specific. Transient failures repeat across every
 *     fallback model, so we retry the SAME model instead.
 *   - `withNetworkRetry` — wraps an AI call with exponential backoff
 *     (1s, 3s, 9s) on transient failure. Provider errors fall straight
 *     through so the caller's fallback chain can try the next model.
 *
 * All exports preserve the KageOps conventions: readonly, explicit
 * return types, `[AiAdapter]` log prefix.
 */

import { createLogger } from '../shared/logger';

const log = createLogger('AiAdapter');

// ── Null-byte sanitization ───────────────────────────

/**
 * Strip NUL (U+0000) bytes from a string. Returns the input unchanged
 * if it is already clean (common case, so no allocation cost).
 *
 * Rationale: Node's `child_process.spawn` rejects any argv entry
 * containing `\0` with `ERR_INVALID_ARG_VALUE: "args[n]" must be a
 * string without null bytes`. We observed this in production when an
 * agent reflection accidentally embedded a null byte into its prompt.
 */
export function stripNullBytes(input: string): string {
    if (input.length === 0 || !input.includes('\u0000')) return input;
    return input.replace(/\u0000/g, '');
}

/**
 * Sanitize a full argv array for spawn. Coerces non-strings (shouldn't
 * happen in normal use) to their String() form first so we can't
 * accidentally skip a sanitize pass.
 */
export function sanitizeSpawnArgs(args: readonly string[]): string[] {
    return args.map((a) => stripNullBytes(typeof a === 'string' ? a : String(a)));
}

// ── Network-transient classification ─────────────────

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENETUNREACH',
    'ENETDOWN',
    'EHOSTUNREACH',
    'EPIPE',
]);

/**
 * Detect errors caused by a transient network / DNS outage. These
 * errors repeat identically across every provider (DNS down, no route,
 * connection reset), so failing through to the next fallback model is
 * pointless — we wait and retry the SAME model instead.
 *
 * NOT included: HTTP 4xx/5xx, rate limits, auth errors. Those are
 * provider-specific and a different fallback may succeed.
 */
export function isNetworkTransientError(error: unknown): boolean {
    if (error === null || error === undefined) return false;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code ?? '';
    const lower = message.toLowerCase();

    if (TRANSIENT_CODES.has(code)) return true;

    // Message-based sniff for errors that lose their .code on rethrow.
    // Guard against matching legitimate HTTP errors that happen to mention
    // these words in the response body — those arrive as "HTTP <code>: ...".
    if (/^http\s*\d{3}/i.test(message)) return false;

    if (lower.includes('getaddrinfo') && lower.includes('enotfound')) return true;
    if (lower.includes('enotfound')) return true;
    if (lower.includes('eai_again')) return true;
    if (lower.includes('econnrefused')) return true;
    if (lower.includes('econnreset')) return true;
    if (lower.includes('etimedout')) return true;
    if (lower.includes('socket hang up')) return true;
    if (lower.includes('fetch failed') && !lower.includes('http ')) return true;
    if (lower.includes('network error') && !lower.includes('http ')) return true;
    if (lower.includes('request timed out')) return true;
    // P2.3-01 (FleetPulse smoke 2026-05-31): the claude-cli adapter
    // surfaces subprocess timeouts as "Process timed out after Ns:
    // <command>". Without this match, a hung Vigil review burned 5
    // minutes per attempt and then propagated as a hard failure that
    // skipped the same-model retry path. Treat it as transient so
    // `withNetworkRetry` re-spawns with a fresh subprocess.
    if (lower.includes('process timed out')) return true;

    return false;
}

// ── Transient-error listener (optional UX hook) ──────

export interface NetworkTransientInfo {
    readonly model: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly error: string;
}

export type NetworkTransientListener = (info: NetworkTransientInfo) => void;

/**
 * Module-level hook invoked when a transient failure triggers a retry.
 * Main process wires this to publish `network.transient` events so the
 * UI can surface "retrying — network issue". Kept as a hook rather than
 * a parameter so the public sendPrompt/sendConversation signatures are
 * unchanged.
 */
let networkTransientListener: NetworkTransientListener | null = null;

export function onNetworkTransient(
    listener: NetworkTransientListener | null
): void {
    networkTransientListener = listener;
}

/** Test-only: reset the listener between cases. */
export function _resetNetworkTransientListenerForTests(): void {
    networkTransientListener = null;
}

// ── Retry loop ───────────────────────────────────────

/** Exponential backoff schedule. Exported for tests. */
export const NETWORK_RETRY_BACKOFF_MS: readonly number[] = [1000, 3000, 9000];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invoke `fn`; on a network-transient failure, retry the SAME call up
 * to `NETWORK_RETRY_BACKOFF_MS.length` times with exponential backoff.
 * Provider-specific errors bypass this loop so the caller's fallback
 * chain can handle them.
 */
export async function withNetworkRetry<T>(
    modelString: string,
    fn: () => Promise<T>
): Promise<T> {
    const maxAttempts = NETWORK_RETRY_BACKOFF_MS.length + 1; // 1 initial + 3 retries
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!isNetworkTransientError(err)) {
                throw err;
            }
            const msg = err instanceof Error ? err.message : String(err);

            if (attempt === maxAttempts - 1) {
                log.warn(
                    { model: modelString, attempts: maxAttempts, err: msg },
                    '[AiAdapter] Network-transient retries exhausted'
                );
                throw err;
            }

            const delayMs = NETWORK_RETRY_BACKOFF_MS[attempt];
            log.warn(
                {
                    model: modelString,
                    attempt: attempt + 1,
                    maxAttempts,
                    delayMs,
                    err: msg,
                },
                '[AiAdapter] Network-transient error — retrying same model'
            );

            if (networkTransientListener !== null) {
                try {
                    networkTransientListener({
                        model: modelString,
                        attempt: attempt + 1,
                        maxAttempts,
                        delayMs,
                        error: msg,
                    });
                } catch {
                    // Listener must never break the retry loop.
                }
            }

            await sleep(delayMs);
        }
    }

    // Unreachable — loop returns or throws.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
