/**
 * Error Boundary tests
 */

import { describe, it, expect } from 'vitest';
import {
  captureError,
  shouldRetry,
  selectRecoveryStrategy,
  createDefaultConfig,
  addErrorToReport,
  createEmptyReport,
  markRecovered,
  formatErrorReport,
  renderFallbackHtml,
  createFallbackConfig,
  isTransientError,
  getRetryDelay,
  type CapturedError,
  type ErrorBoundaryConfig,
} from '../../src/renderer/shared/error-boundary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapturedError(overrides?: Partial<CapturedError>): CapturedError {
  return {
    id: 'err-test-1',
    message: 'Something broke',
    stack: null,
    componentName: 'TestComponent',
    timestamp: '2026-01-01T00:00:00.000Z',
    retryCount: 0,
    recovered: false,
    ...overrides,
  };
}

function defaultConfig(overrides?: Partial<ErrorBoundaryConfig>): ErrorBoundaryConfig {
  return createDefaultConfig(overrides);
}

// ---------------------------------------------------------------------------
// captureError
// ---------------------------------------------------------------------------

describe('captureError', () => {
  it('captures an Error instance', () => {
    const err = captureError(new Error('test error'), 'ChatWindow', 0);
    expect(err.message).toBe('test error');
    expect(err.stack).toContain('test error');
    expect(err.componentName).toBe('ChatWindow');
    expect(err.retryCount).toBe(0);
    expect(err.recovered).toBe(false);
  });

  it('captures a string error', () => {
    const err = captureError('string failure', 'Overlay', 2);
    expect(err.message).toBe('string failure');
    expect(err.stack).toBeNull();
    expect(err.retryCount).toBe(2);
  });

  it('generates unique ids', () => {
    const a = captureError('a', 'X', 0);
    const b = captureError('b', 'X', 0);
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// shouldRetry
// ---------------------------------------------------------------------------

describe('shouldRetry', () => {
  it.each([
    { retryCount: 0, maxRetries: 3, expected: true },
    { retryCount: 2, maxRetries: 3, expected: true },
    { retryCount: 3, maxRetries: 3, expected: false },
    { retryCount: 5, maxRetries: 3, expected: false },
  ])('retryCount=$retryCount maxRetries=$maxRetries => $expected', ({ retryCount, maxRetries, expected }) => {
    const err = makeCapturedError({ retryCount });
    expect(shouldRetry(err, defaultConfig({ maxRetries }))).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// selectRecoveryStrategy
// ---------------------------------------------------------------------------

describe('selectRecoveryStrategy', () => {
  it('returns retry when under max retries', () => {
    const err = makeCapturedError({ retryCount: 1 });
    expect(selectRecoveryStrategy(err, defaultConfig({ maxRetries: 3 }))).toBe('retry');
  });

  it('returns fallback when max retries reached and fallback enabled', () => {
    const err = makeCapturedError({ retryCount: 3 });
    expect(selectRecoveryStrategy(err, defaultConfig({ maxRetries: 3, showFallbackUi: true }))).toBe('fallback');
  });

  it('returns reload when max retries reached and fallback disabled', () => {
    const err = makeCapturedError({ retryCount: 3 });
    expect(selectRecoveryStrategy(err, defaultConfig({ maxRetries: 3, showFallbackUi: false }))).toBe('reload');
  });
});

// ---------------------------------------------------------------------------
// createDefaultConfig
// ---------------------------------------------------------------------------

describe('createDefaultConfig', () => {
  it('creates config with sensible defaults', () => {
    const config = createDefaultConfig();
    expect(config.maxRetries).toBe(3);
    expect(config.retryDelayMs).toBe(1000);
    expect(config.logErrors).toBe(true);
    expect(config.reportToSensei).toBe(true);
  });

  it('applies overrides', () => {
    const config = createDefaultConfig({ maxRetries: 5, logErrors: false });
    expect(config.maxRetries).toBe(5);
    expect(config.logErrors).toBe(false);
    expect(config.retryDelayMs).toBe(1000); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Report management
// ---------------------------------------------------------------------------

describe('addErrorToReport', () => {
  it('immutably adds error to report', () => {
    const report = createEmptyReport();
    const err = makeCapturedError();
    const updated = addErrorToReport(report, err);
    expect(updated.errors).toHaveLength(1);
    expect(updated.totalCaught).toBe(1);
    expect(report.errors).toHaveLength(0); // original unchanged
  });
});

describe('markRecovered', () => {
  it('marks an error as recovered and increments count', () => {
    const err = makeCapturedError({ id: 'err-1' });
    const report = addErrorToReport(createEmptyReport(), err);
    const updated = markRecovered(report, 'err-1');
    expect(updated.errors[0].recovered).toBe(true);
    expect(updated.totalRecovered).toBe(1);
  });

  it('does not increment if error already recovered', () => {
    const err = makeCapturedError({ id: 'err-1', recovered: true });
    const report = { ...addErrorToReport(createEmptyReport(), err), totalRecovered: 1 };
    const updated = markRecovered(report, 'err-1');
    expect(updated.totalRecovered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatErrorReport
// ---------------------------------------------------------------------------

describe('formatErrorReport', () => {
  it('formats an empty report', () => {
    const text = formatErrorReport(createEmptyReport());
    expect(text).toContain('# Error Boundary Report');
    expect(text).toContain('Total Caught:** 0');
  });

  it('includes error details', () => {
    const report = addErrorToReport(createEmptyReport(), makeCapturedError({ componentName: 'Overlay' }));
    const text = formatErrorReport(report);
    expect(text).toContain('Overlay');
  });
});

// ---------------------------------------------------------------------------
// Fallback UI
// ---------------------------------------------------------------------------

describe('renderFallbackHtml', () => {
  it('renders HTML with retry button', () => {
    const config = createFallbackConfig('ChatWindow');
    const err = makeCapturedError();
    const html = renderFallbackHtml(config, err);
    expect(html).toContain('retry-btn');
    expect(html).toContain('ChatWindow');
  });

  it('escapes HTML in error messages', () => {
    const config = createFallbackConfig('Test');
    const err = makeCapturedError({ message: '<script>alert("xss")</script>' });
    const html = renderFallbackHtml({ ...config, showDetails: true }, err);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

describe('isTransientError', () => {
  it.each([
    { message: 'network error occurred', expected: true },
    { message: 'ETIMEDOUT after 5000ms', expected: true },
    { message: 'fetch failed', expected: true },
    { message: 'TypeError: cannot read property', expected: false },
    { message: 'ReferenceError: x is not defined', expected: false },
  ])('message="$message" => $expected', ({ message, expected }) => {
    const err = makeCapturedError({ message });
    expect(isTransientError(err)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getRetryDelay
// ---------------------------------------------------------------------------

describe('getRetryDelay', () => {
  it('increases with retry count', () => {
    const d0 = getRetryDelay(0, 1000);
    const d1 = getRetryDelay(1, 1000);
    const d2 = getRetryDelay(2, 1000);
    // Base exponential: 1000, 2000, 4000 — jitter adds 0-500
    expect(d0).toBeGreaterThanOrEqual(1000);
    expect(d0).toBeLessThan(1500);
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d2).toBeGreaterThanOrEqual(4000);
  });
});
