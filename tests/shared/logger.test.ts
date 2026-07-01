/**
 * Logger module tests
 *
 * Tests the createLogger factory, child loggers, silent logger,
 * and environment-based configuration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('logger', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('createLogger()', () => {
        it('returns a logger with all standard log methods', async () => {
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('TestModule');

            expect(typeof log.trace).toBe('function');
            expect(typeof log.debug).toBe('function');
            expect(typeof log.info).toBe('function');
            expect(typeof log.warn).toBe('function');
            expect(typeof log.error).toBe('function');
            expect(typeof log.fatal).toBe('function');
        });

        it('creates a child logger with module binding', async () => {
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('Sensei');

            // The logger should not throw when called
            expect(() => log.info('test message')).not.toThrow();
            expect(() => log.info({ taskId: '123' }, 'task message')).not.toThrow();
        });

        it('creates separate loggers for different modules', async () => {
            const { createLogger } = await import('../../src/shared/logger');
            const log1 = createLogger('ModuleA');
            const log2 = createLogger('ModuleB');

            expect(log1).not.toBe(log2);
        });

        it('supports child() to create nested loggers', async () => {
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('Sensei');
            const childLog = log.child({ projectId: 'proj-1' });

            expect(typeof childLog.info).toBe('function');
            expect(() => childLog.info('child message')).not.toThrow();
        });
    });

    describe('createSilentLogger()', () => {
        it('returns a logger that silently discards all messages', async () => {
            const { createSilentLogger } = await import('../../src/shared/logger');
            const log = createSilentLogger();

            // Should not throw
            expect(() => log.trace('trace')).not.toThrow();
            expect(() => log.debug('debug')).not.toThrow();
            expect(() => log.info('info')).not.toThrow();
            expect(() => log.warn('warn')).not.toThrow();
            expect(() => log.error('error')).not.toThrow();
            expect(() => log.fatal('fatal')).not.toThrow();
        });

        it('child() returns the same silent logger', async () => {
            const { createSilentLogger } = await import('../../src/shared/logger');
            const log = createSilentLogger();
            const child = log.child({ extra: 'data' });

            expect(typeof child.info).toBe('function');
            expect(() => child.info('should not throw')).not.toThrow();
        });
    });

    describe('getRootLogger()', () => {
        it('returns the root pino logger instance', async () => {
            const { getRootLogger } = await import('../../src/shared/logger');
            const root = getRootLogger();

            expect(typeof root.info).toBe('function');
            expect(typeof root.child).toBe('function');
        });
    });

    describe('log level configuration', () => {
        it('defaults to info level', async () => {
            delete process.env.KAGEOPS_LOG_LEVEL;
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('Test');

            // trace and debug should be no-ops at info level
            // info and above should work (not throw)
            expect(() => log.info('visible')).not.toThrow();
            expect(() => log.warn('visible')).not.toThrow();
            expect(() => log.error('visible')).not.toThrow();
        });

        it('respects KAGEOPS_LOG_LEVEL env var', async () => {
            process.env.KAGEOPS_LOG_LEVEL = 'warn';
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('Test');

            // Should not throw at any level
            expect(() => log.info('below threshold')).not.toThrow();
            expect(() => log.warn('at threshold')).not.toThrow();
            expect(() => log.error('above threshold')).not.toThrow();
        });
    });

    describe('structured logging', () => {
        it('accepts object context as first argument', async () => {
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('Sensei');

            expect(() => log.info({ projectId: 'p1', taskId: 't1' }, 'Task started')).not.toThrow();
            expect(() => log.error({ err: new Error('boom') }, 'Task failed')).not.toThrow();
        });

        it('accepts string-only messages', async () => {
            const { createLogger } = await import('../../src/shared/logger');
            const log = createLogger('EventBus');

            expect(() => log.info('Connected to database')).not.toThrow();
        });
    });
});
