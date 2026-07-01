/**
 * KageOps Retry Policy
 *
 * Generic retry wrapper with exponential backoff and jitter.
 * Classifies errors as retryable (rate limit, timeout, transient)
 * vs non-retryable (auth, client errors).
 */

// ── Types ────────────────────────────────────────────

export interface RetryOptions {
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly isRetryable?: (error: unknown) => boolean;
}

export interface RetryResult<T> {
    readonly value: T;
    readonly attempts: number;
    readonly totalDelayMs: number;
}

export type ErrorClassification =
    | 'rate-limit'
    | 'timeout'
    | 'server-error'
    | 'auth-error'
    | 'client-error'
    | 'unknown';

// ── Default Options ──────────────────────────────────

const DEFAULT_OPTIONS: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
};

// ── Error Classification ─────────────────────────────

/**
 * Classify an error for retry decision-making.
 */
export function classifyError(error: unknown): ErrorClassification {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();

    // HTTP status code patterns
    if (lowerMessage.includes('http 429') || lowerMessage.includes('rate_limit') || lowerMessage.includes('rate limit')) {
        return 'rate-limit';
    }
    if (lowerMessage.includes('http 408') || lowerMessage.includes('timeout') || lowerMessage.includes('etimedout') || lowerMessage.includes('econnreset')) {
        return 'timeout';
    }
    if (lowerMessage.includes('http 401') || lowerMessage.includes('http 403') || lowerMessage.includes('unauthorized') || lowerMessage.includes('forbidden')) {
        return 'auth-error';
    }

    // 5xx server errors
    const http5xx = lowerMessage.match(/http\s*(5\d{2})/);
    if (http5xx !== null) {
        return 'server-error';
    }

    // 4xx client errors (not rate limit or auth)
    const http4xx = lowerMessage.match(/http\s*(4\d{2})/);
    if (http4xx !== null) {
        return 'client-error';
    }

    // Network-level transient errors
    if (lowerMessage.includes('econnrefused') || lowerMessage.includes('enotfound') || lowerMessage.includes('socket hang up')) {
        return 'server-error';
    }

    return 'unknown';
}

/**
 * Check if an error is retryable based on its classification.
 * Rate limits, timeouts, and server errors are retryable.
 * Auth and client errors are not.
 */
export function isRetryableError(error: unknown): boolean {
    const classification = classifyError(error);
    return classification === 'rate-limit'
        || classification === 'timeout'
        || classification === 'server-error';
}

/**
 * Check if an error is specifically a rate limit error.
 */
export function isRateLimitError(error: unknown): boolean {
    return classifyError(error) === 'rate-limit';
}

/**
 * Whether an error is a credential / authentication failure — a missing,
 * invalid, or unauthorized API key. These are NOT worth retrying: no
 * number of re-attempts conjures a key, so the durable-recovery path
 * pauses the project and surfaces the specific credential instead of
 * burning the retry budget (#4 — pause-don't-fail).
 *
 * Covers the `auth-error` classification (401/403/unauthorized/forbidden)
 * plus the provider-specific phrasings we've actually hit in the wild —
 * notably OpenRouter's 401 body "User not found" (the stale-key bug) and
 * the "<PROVIDER>_API_KEY not configured" / "no api key" thrown by the
 * adapter when a key is absent.
 */
export function isCredentialError(error: unknown): boolean {
    if (classifyError(error) === 'auth-error') return true;
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (msg.includes('user not found')) return true;          // OpenRouter 401 body
    if (msg.includes('invalid api key')) return true;
    if (msg.includes('incorrect api key')) return true;
    if (msg.includes('no api key')) return true;
    if (msg.includes('missing api key')) return true;
    if (msg.includes('api key not configured')) return true;
    if (msg.includes('api_key') && (msg.includes('not configured') || msg.includes('not set') || msg.includes('missing'))) {
        return true;
    }
    if (msg.includes('api key') && msg.includes('not configured')) return true;
    return false;
}

/**
 * Check if an error is specifically a timeout error.
 */
export function isTimeoutError(error: unknown): boolean {
    return classifyError(error) === 'timeout';
}

// ── Backoff Calculation ──────────────────────────────

/**
 * Calculate delay with exponential backoff and jitter.
 * Formula: min(maxDelay, baseDelay * 2^attempt) * (0.5 + random * 0.5)
 */
export function calculateBackoff(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number
): number {
    const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.floor(exponential * jitter);
}

// ── Retry Execution ──────────────────────────────────

/**
 * Execute a function with automatic retries on transient failures.
 *
 * Uses exponential backoff with jitter between retries.
 * Only retries on retryable errors (rate limit, timeout, server error).
 * Throws immediately on non-retryable errors (auth, client errors).
 */
export async function executeWithRetry<T>(
    fn: () => Promise<T>,
    options: Partial<RetryOptions> = {}
): Promise<RetryResult<T>> {
    const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
    const retryCheck = opts.isRetryable ?? isRetryableError;

    const errors: Error[] = [];
    let totalDelayMs = 0;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            const value = await fn();
            return { value, attempts: attempt + 1, totalDelayMs };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            errors.push(err);

            // Don't retry on the last attempt
            if (attempt === opts.maxRetries) {
                break;
            }

            // Don't retry non-retryable errors
            if (!retryCheck(error)) {
                break;
            }

            // Wait with backoff before retrying
            const delay = calculateBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs);
            totalDelayMs += delay;
            await sleep(delay);
        }
    }

    // All retries exhausted — throw aggregated error
    const messages = errors.map((e, i) => `  Attempt ${i + 1}: ${e.message}`).join('\n');
    throw new Error(
        `All ${errors.length} attempt(s) failed after ${totalDelayMs}ms:\n${messages}`
    );
}

// ── Helpers ──────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
