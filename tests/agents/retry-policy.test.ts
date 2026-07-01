/**
 * RetryPolicy unit tests
 *
 * Tests exponential backoff, error classification, jitter calculation,
 * and retry exhaustion behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    executeWithRetry,
    classifyError,
    isRetryableError,
    isRateLimitError,
    isTimeoutError,
    isCredentialError,
    calculateBackoff,
} from '../../src/agents/retry-policy';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeError(message: string): Error {
    return new Error(message);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RetryPolicy', () => {

    // ── isCredentialError (④ pause-don't-fail) ──────────────────────────────

    describe('isCredentialError()', () => {
        it('is true for the auth-error class (401/403/unauthorized/forbidden)', () => {
            for (const m of ['HTTP 401: nope', 'HTTP 403: denied', 'Unauthorized', 'Forbidden']) {
                expect(isCredentialError(makeError(m))).toBe(true);
            }
        });

        it('is true for provider-specific missing/invalid-key phrasings', () => {
            for (const m of [
                'OpenRouter error: User not found',     // OpenRouter 401 body (stale-key bug)
                'Invalid API key provided',
                'Incorrect API key',
                'No API key configured for openrouter',
                'Missing API key',
                'ANTHROPIC_API_KEY not configured',
            ]) {
                expect(isCredentialError(makeError(m))).toBe(true);
            }
        });

        it('is false for non-credential failures (no over-matching)', () => {
            for (const m of [
                'TS2304: Cannot find name "foo"',
                'HTTP 500: internal error',
                'HTTP 429: rate limited',
                'Process timed out after 300s',
                'ECONNRESET',
            ]) {
                expect(isCredentialError(makeError(m))).toBe(false);
            }
        });
    });

    // ── classifyError ───────────────────────────────────────────────────────

    describe('classifyError()', () => {
        it('classifies HTTP 429 as rate-limit', () => {
            expect(classifyError(makeError('HTTP 429: Too Many Requests'))).toBe('rate-limit');
        });

        it('classifies rate_limit_exceeded as rate-limit', () => {
            expect(classifyError(makeError('Error: rate_limit_exceeded'))).toBe('rate-limit');
        });

        it('classifies "rate limit" as rate-limit', () => {
            expect(classifyError(makeError('Rate limit reached'))).toBe('rate-limit');
        });

        it('classifies HTTP 408 as timeout', () => {
            expect(classifyError(makeError('HTTP 408: Request Timeout'))).toBe('timeout');
        });

        it('classifies ETIMEDOUT as timeout', () => {
            expect(classifyError(makeError('connect ETIMEDOUT 1.2.3.4:443'))).toBe('timeout');
        });

        it('classifies ECONNRESET as timeout', () => {
            expect(classifyError(makeError('read ECONNRESET'))).toBe('timeout');
        });

        it('classifies HTTP 401 as auth-error', () => {
            expect(classifyError(makeError('HTTP 401: Unauthorized'))).toBe('auth-error');
        });

        it('classifies HTTP 403 as auth-error', () => {
            expect(classifyError(makeError('HTTP 403: Forbidden'))).toBe('auth-error');
        });

        it('classifies HTTP 500 as server-error', () => {
            expect(classifyError(makeError('HTTP 500: Internal Server Error'))).toBe('server-error');
        });

        it('classifies HTTP 502 as server-error', () => {
            expect(classifyError(makeError('HTTP 502: Bad Gateway'))).toBe('server-error');
        });

        it('classifies HTTP 503 as server-error', () => {
            expect(classifyError(makeError('HTTP 503: Service Unavailable'))).toBe('server-error');
        });

        it('classifies ECONNREFUSED as server-error', () => {
            expect(classifyError(makeError('connect ECONNREFUSED 127.0.0.1:11434'))).toBe('server-error');
        });

        it('classifies HTTP 400 as client-error', () => {
            expect(classifyError(makeError('HTTP 400: Bad Request'))).toBe('client-error');
        });

        it('classifies unknown errors as unknown', () => {
            expect(classifyError(makeError('Something went wrong'))).toBe('unknown');
        });

        it('handles non-Error values', () => {
            expect(classifyError('HTTP 429: rate limited')).toBe('rate-limit');
        });
    });

    // ── isRetryableError ────────────────────────────────────────────────────

    describe('isRetryableError()', () => {
        it('returns true for rate-limit errors', () => {
            expect(isRetryableError(makeError('HTTP 429'))).toBe(true);
        });

        it('returns true for timeout errors', () => {
            expect(isRetryableError(makeError('ETIMEDOUT'))).toBe(true);
        });

        it('returns true for server errors', () => {
            expect(isRetryableError(makeError('HTTP 500'))).toBe(true);
        });

        it('returns false for auth errors', () => {
            expect(isRetryableError(makeError('HTTP 401'))).toBe(false);
        });

        it('returns false for client errors', () => {
            expect(isRetryableError(makeError('HTTP 400'))).toBe(false);
        });
    });

    // ── isRateLimitError / isTimeoutError ───────────────────────────────────

    describe('isRateLimitError()', () => {
        it('returns true for rate limit errors only', () => {
            expect(isRateLimitError(makeError('HTTP 429'))).toBe(true);
            expect(isRateLimitError(makeError('HTTP 500'))).toBe(false);
        });
    });

    describe('isTimeoutError()', () => {
        it('returns true for timeout errors only', () => {
            expect(isTimeoutError(makeError('ETIMEDOUT'))).toBe(true);
            expect(isTimeoutError(makeError('HTTP 429'))).toBe(false);
        });
    });

    // ── calculateBackoff ────────────────────────────────────────────────────

    describe('calculateBackoff()', () => {
        it('returns delay within expected range for attempt 0', () => {
            const base = 1000;
            const max = 30000;
            // Expected: 1000 * 2^0 * [0.5, 1.0] = [500, 1000]
            for (let i = 0; i < 20; i++) {
                const delay = calculateBackoff(0, base, max);
                expect(delay).toBeGreaterThanOrEqual(500);
                expect(delay).toBeLessThanOrEqual(1000);
            }
        });

        it('increases delay with higher attempts', () => {
            const base = 1000;
            const max = 60000;

            // Collect samples
            const delays0: number[] = [];
            const delays3: number[] = [];
            for (let i = 0; i < 50; i++) {
                delays0.push(calculateBackoff(0, base, max));
                delays3.push(calculateBackoff(3, base, max));
            }

            const avg0 = delays0.reduce((a, b) => a + b, 0) / delays0.length;
            const avg3 = delays3.reduce((a, b) => a + b, 0) / delays3.length;

            expect(avg3).toBeGreaterThan(avg0);
        });

        it('caps delay at maxDelayMs', () => {
            const max = 5000;
            for (let i = 0; i < 20; i++) {
                const delay = calculateBackoff(10, 1000, max);
                expect(delay).toBeLessThanOrEqual(max);
            }
        });

        it('always returns a positive integer', () => {
            for (let attempt = 0; attempt < 10; attempt++) {
                const delay = calculateBackoff(attempt, 100, 10000);
                expect(delay).toBeGreaterThan(0);
                expect(Number.isInteger(delay)).toBe(true);
            }
        });
    });

    // ── executeWithRetry ────────────────────────────────────────────────────

    describe('executeWithRetry()', () => {
        beforeEach(() => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('succeeds on first try with no delay', async () => {
            const fn = vi.fn(async () => 'success');

            const result = await executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 });

            expect(result.value).toBe('success');
            expect(result.attempts).toBe(1);
            expect(result.totalDelayMs).toBe(0);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('retries and succeeds on second attempt', async () => {
            let callCount = 0;
            const fn = vi.fn(async () => {
                callCount++;
                if (callCount === 1) throw new Error('HTTP 500: Internal Server Error');
                return 'recovered';
            });

            const result = await executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });

            expect(result.value).toBe('recovered');
            expect(result.attempts).toBe(2);
            expect(result.totalDelayMs).toBeGreaterThan(0);
        });

        it('retries and succeeds on third attempt', async () => {
            let callCount = 0;
            const fn = vi.fn(async () => {
                callCount++;
                if (callCount <= 2) throw new Error('HTTP 503: Service Unavailable');
                return 'finally';
            });

            const result = await executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });

            expect(result.value).toBe('finally');
            expect(result.attempts).toBe(3);
        });

        it('throws after exhausting all retries', async () => {
            const fn = vi.fn(async () => { throw new Error('HTTP 500: always fails'); });

            await expect(
                executeWithRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 })
            ).rejects.toThrow('All 3 attempt(s) failed');

            expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
        });

        it('does not retry on non-retryable errors (auth)', async () => {
            const fn = vi.fn(async () => { throw new Error('HTTP 401: Unauthorized'); });

            await expect(
                executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 })
            ).rejects.toThrow();

            expect(fn).toHaveBeenCalledTimes(1); // No retries
        });

        it('does not retry on client errors', async () => {
            const fn = vi.fn(async () => { throw new Error('HTTP 400: Bad Request'); });

            await expect(
                executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 })
            ).rejects.toThrow();

            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('respects custom isRetryable function', async () => {
            let callCount = 0;
            const fn = vi.fn(async () => {
                callCount++;
                if (callCount === 1) throw new Error('custom-retryable');
                return 'ok';
            });

            const result = await executeWithRetry(fn, {
                maxRetries: 3,
                baseDelayMs: 10,
                maxDelayMs: 50,
                isRetryable: (err) => err instanceof Error && err.message.includes('custom-retryable'),
            });

            expect(result.value).toBe('ok');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('includes all error messages in the aggregated error', async () => {
            let callCount = 0;
            const fn = vi.fn(async () => {
                callCount++;
                throw new Error(`HTTP 500: fail ${callCount}`);
            });

            try {
                await executeWithRetry(fn, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 });
                expect.fail('Should have thrown');
            } catch (err) {
                const message = (err as Error).message;
                expect(message).toContain('fail 1');
                expect(message).toContain('fail 2');
            }
        });
    });
});
