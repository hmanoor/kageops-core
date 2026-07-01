/**
 * KageOps Structured Logger
 *
 * Factory-based logger using pino for structured JSON output.
 * Each module creates its own child logger with a `module` field.
 *
 * Usage:
 *   import { createLogger } from '../shared/logger';
 *   const log = createLogger('Sensei');
 *   log.info('Orchestrator started');
 *   log.warn({ taskId }, 'Task blocked');
 *   log.error({ err }, 'Task failed');
 *
 * Configuration:
 *   KAGEOPS_LOG_LEVEL env var (default: 'info')
 *   KAGEOPS_LOG_PRETTY env var (default: 'false', set 'true' for dev)
 */

import pino from 'pino';

// ── Types ────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
    readonly trace: LogFn;
    readonly debug: LogFn;
    readonly info: LogFn;
    readonly warn: LogFn;
    readonly error: LogFn;
    readonly fatal: LogFn;
    readonly child: (bindings: Record<string, unknown>) => Logger;
}

type LogFn = {
    (msg: string): void;
    (obj: Record<string, unknown>, msg: string): void;
};

// ── Root Logger ──────────────────────────────────────

const LOG_LEVEL = (process.env.KAGEOPS_LOG_LEVEL ?? 'info') as LogLevel;
const LOG_PRETTY = process.env.KAGEOPS_LOG_PRETTY === 'true';

const rootLogger: pino.Logger = pino({
    level: LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(LOG_PRETTY
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
});

// ── Factory ──────────────────────────────────────────

/**
 * Create a child logger for a specific module.
 * The module name appears in every log line as `{ module: 'ModuleName' }`.
 */
export function createLogger(module: string): Logger {
    return rootLogger.child({ module }) as unknown as Logger;
}

/**
 * Get the root logger (for testing or special cases).
 */
export function getRootLogger(): Logger {
    return rootLogger as unknown as Logger;
}

/**
 * Create a no-op logger that silently discards all messages.
 * Useful for tests that don't want log output.
 */
export function createSilentLogger(): Logger {
    const noop = (() => undefined) as unknown as LogFn;
    const silent: Logger = {
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        fatal: noop,
        child: () => silent,
    };
    return silent;
}
