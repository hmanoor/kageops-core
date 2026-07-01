/**
 * Error Boundary for Renderer Processes
 *
 * Captures, categorizes, and recovers from errors in Electron renderer
 * windows (overlay, chat, command-center). Provides fallback UI rendering,
 * retry logic with exponential backoff, and error reporting to Sensei.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ErrorBoundaryConfig {
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly onError: string;
  readonly showFallbackUi: boolean;
  readonly logErrors: boolean;
  readonly reportToSensei: boolean;
}

export interface CapturedError {
  readonly id: string;
  readonly message: string;
  readonly stack: string | null;
  readonly componentName: string;
  readonly timestamp: string;
  readonly retryCount: number;
  readonly recovered: boolean;
}

export interface ErrorReport {
  readonly errors: readonly CapturedError[];
  readonly totalCaught: number;
  readonly totalRecovered: number;
  readonly uptime: number;
}

export interface FallbackUiConfig {
  readonly title: string;
  readonly message: string;
  readonly showRetryButton: boolean;
  readonly showReportButton: boolean;
  readonly showDetails: boolean;
}

export type RecoveryStrategy = 'retry' | 'fallback' | 'reload' | 'ignore';

// ---------------------------------------------------------------------------
// Transient error patterns
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /network/i,
  /timeout/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /fetch failed/i,
  /ERR_NETWORK/,
  /socket hang up/i,
  /ENOTFOUND/,
  /503/,
  /429/,
];

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

let errorCounter = 0;

export function captureError(
  error: unknown,
  componentName: string,
  retryCount: number,
): CapturedError {
  errorCounter += 1;
  const message =
    error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error ? (error.stack ?? null) : null;

  return {
    id: `err-${Date.now()}-${errorCounter}`,
    message,
    stack,
    componentName,
    timestamp: new Date().toISOString(),
    retryCount,
    recovered: false,
  };
}

export function shouldRetry(
  error: CapturedError,
  config: ErrorBoundaryConfig,
): boolean {
  return error.retryCount < config.maxRetries;
}

export function selectRecoveryStrategy(
  error: CapturedError,
  config: ErrorBoundaryConfig,
): RecoveryStrategy {
  if (error.retryCount < config.maxRetries) {
    return 'retry';
  }
  if (config.showFallbackUi) {
    return 'fallback';
  }
  return 'reload';
}

export function createDefaultConfig(
  overrides?: Partial<ErrorBoundaryConfig>,
): ErrorBoundaryConfig {
  return {
    maxRetries: 3,
    retryDelayMs: 1000,
    onError: 'recover',
    showFallbackUi: true,
    logErrors: true,
    reportToSensei: true,
    ...overrides,
  };
}

export function addErrorToReport(
  report: ErrorReport,
  error: CapturedError,
): ErrorReport {
  return {
    ...report,
    errors: [...report.errors, error],
    totalCaught: report.totalCaught + 1,
    totalRecovered: error.recovered
      ? report.totalRecovered + 1
      : report.totalRecovered,
  };
}

export function createEmptyReport(): ErrorReport {
  return {
    errors: [],
    totalCaught: 0,
    totalRecovered: 0,
    uptime: 0,
  };
}

export function markRecovered(
  report: ErrorReport,
  errorId: string,
): ErrorReport {
  const updatedErrors = report.errors.map((e) =>
    e.id === errorId ? { ...e, recovered: true } : e,
  );
  const found = report.errors.some((e) => e.id === errorId && !e.recovered);
  return {
    ...report,
    errors: updatedErrors,
    totalRecovered: found
      ? report.totalRecovered + 1
      : report.totalRecovered,
  };
}

export function formatErrorReport(report: ErrorReport): string {
  const lines: string[] = [
    '# Error Boundary Report',
    '',
    `- **Total Caught:** ${report.totalCaught}`,
    `- **Total Recovered:** ${report.totalRecovered}`,
    `- **Uptime:** ${report.uptime}ms`,
    '',
  ];

  if (report.errors.length > 0) {
    lines.push('## Errors', '');
    for (const err of report.errors) {
      lines.push(
        `### ${err.componentName} — ${err.id}`,
        `- Message: ${err.message}`,
        `- Timestamp: ${err.timestamp}`,
        `- Retry Count: ${err.retryCount}`,
        `- Recovered: ${err.recovered}`,
        '',
      );
    }
  }

  return lines.join('\n');
}

export function renderFallbackHtml(
  config: FallbackUiConfig,
  error: CapturedError,
): string {
  const details = config.showDetails
    ? `<pre class="error-details">${escapeHtml(error.message)}${error.stack ? '\n' + escapeHtml(error.stack) : ''}</pre>`
    : '';
  const retryBtn = config.showRetryButton
    ? '<button class="retry-btn" onclick="location.reload()">Retry</button>'
    : '';
  const reportBtn = config.showReportButton
    ? '<button class="report-btn">Report to Sensei</button>'
    : '';

  return [
    '<div class="error-boundary-fallback">',
    `  <h2>${escapeHtml(config.title)}</h2>`,
    `  <p>${escapeHtml(config.message)}</p>`,
    `  ${details}`,
    '  <div class="error-actions">',
    `    ${retryBtn}`,
    `    ${reportBtn}`,
    '  </div>',
    '</div>',
  ].join('\n');
}

export function createFallbackConfig(
  componentName: string,
): FallbackUiConfig {
  return {
    title: `${componentName} encountered an error`,
    message: 'Something went wrong. You can retry or report this issue.',
    showRetryButton: true,
    showReportButton: true,
    showDetails: false,
  };
}

export function isTransientError(error: CapturedError): boolean {
  return TRANSIENT_PATTERNS.some(
    (pattern) =>
      pattern.test(error.message) ||
      (error.stack !== null && pattern.test(error.stack)),
  );
}

export function getRetryDelay(
  retryCount: number,
  baseDelay: number,
): number {
  const exponential = baseDelay * Math.pow(2, retryCount);
  const jitter = Math.floor(Math.random() * baseDelay * 0.5);
  return exponential + jitter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
