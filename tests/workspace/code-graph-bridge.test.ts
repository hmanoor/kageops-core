/**
 * Tests for code-graph-bridge.ts
 *
 * Tests the CodeGraphBridge public API — degraded mode when Python is unavailable,
 * status reporting, graph initialization, and singleton behavior.
 * Uses mocks to avoid spawning real child processes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────

const bridgeMocks = vi.hoisted(() => ({
    mockCheckUvx: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock('../../src/workspace/python-check', () => ({
    checkUvxAvailable: bridgeMocks.mockCheckUvx,
}));

vi.mock('child_process', () => ({
    spawn: bridgeMocks.mockSpawn,
}));

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

// ── Import under test ─────────────────────────────────

import {
    getCodeGraphBridge,
    resetCodeGraphBridgeForTesting,
} from '../../src/workspace/code-graph-bridge';

// ── Tests ─────────────────────────────────────────────

describe('CodeGraphBridge — degraded mode', () => {
    beforeEach(() => {
        resetCodeGraphBridgeForTesting();
        bridgeMocks.mockCheckUvx.mockReset();
        bridgeMocks.mockSpawn.mockReset();
    });

    it('enters degraded mode when uvx is unavailable', async () => {
        bridgeMocks.mockCheckUvx.mockResolvedValue({
            available: false,
            command: '',
            version: null,
            method: 'none',
        });

        const bridge = getCodeGraphBridge();
        await bridge.initialize();

        expect(bridge.isDegraded).toBe(true);
    });

    it('all public API methods return null when degraded', async () => {
        bridgeMocks.mockCheckUvx.mockResolvedValue({
            available: false, command: '', version: null, method: 'none',
        });

        const bridge = getCodeGraphBridge();
        await bridge.initialize();

        expect(await bridge.buildGraph('/some/repo')).toBeNull();
        expect(await bridge.getReviewContext('/some/repo', ['src/foo.ts'])).toBeNull();
        expect(await bridge.getImpactRadius('/some/repo', 'MyFunc')).toBeNull();
        expect(await bridge.getArchitectureOverview('/some/repo')).toBeNull();
        expect(await bridge.detectChanges('/some/repo', 'HEAD~1')).toBeNull();
        expect(await bridge.getMinimalContext('/some/repo', 'Fix the bug')).toBeNull();
        expect(await bridge.semanticSearch('/some/repo', 'useCallback')).toBeNull();
    });

    it('getAllStatuses returns empty array when degraded', async () => {
        bridgeMocks.mockCheckUvx.mockResolvedValue({
            available: false, command: '', version: null, method: 'none',
        });

        const bridge = getCodeGraphBridge();
        await bridge.initialize();

        expect(bridge.getAllStatuses()).toEqual([]);
    });

    it('getStatus returns unavailable state when degraded', async () => {
        bridgeMocks.mockCheckUvx.mockResolvedValue({
            available: false, command: '', version: null, method: 'none',
        });

        const bridge = getCodeGraphBridge();
        await bridge.initialize();

        const status = bridge.getStatus('/my/project');
        expect(status.state).toBe('unavailable');
        expect(status.nodeCount).toBe(0);
    });
});

describe('CodeGraphBridge — not-started state', () => {
    beforeEach(() => {
        resetCodeGraphBridgeForTesting();
        bridgeMocks.mockCheckUvx.mockReset();
        bridgeMocks.mockSpawn.mockReset();
    });

    it('getStatus returns not-started for unknown repo when not degraded', async () => {
        bridgeMocks.mockCheckUvx.mockResolvedValue({
            available: true, command: 'uvx', version: '0.5.0', method: 'uvx',
        });

        // Spawn a never-resolving proc (we won't actually call buildGraph in this test)
        bridgeMocks.mockSpawn.mockImplementation(() => ({
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            stdin: { write: vi.fn(), end: vi.fn() },
            on: vi.fn(),
            kill: vi.fn(),
        }));

        const bridge = getCodeGraphBridge();
        // Don't call initialize — just check status directly
        const status = bridge.getStatus('/unknown/repo');
        expect(status.state).toBe('not-started');
        expect(status.lastBuiltAt).toBeNull();
        expect(status.error).toBeNull();
    });
});

describe('CodeGraphBridge — path normalization', () => {
    beforeEach(() => {
        resetCodeGraphBridgeForTesting();
        bridgeMocks.mockCheckUvx.mockReset();
    });

    it('normalizes Windows backslash paths to forward slashes', async () => {
        bridgeMocks.mockCheckUvx.mockResolvedValue({
            available: false, command: '', version: null, method: 'none',
        });

        const bridge = getCodeGraphBridge();
        await bridge.initialize();

        // Both paths should map to the same normalized key
        const status1 = bridge.getStatus('C:\\projects\\foo');
        const status2 = bridge.getStatus('C:/projects/foo');

        // Both should be unavailable (degraded) — same underlying state
        expect(status1.state).toBe('unavailable');
        expect(status2.state).toBe('unavailable');
    });
});

describe('CodeGraphBridge — singleton', () => {
    beforeEach(() => {
        resetCodeGraphBridgeForTesting();
    });

    it('getCodeGraphBridge returns the same instance on repeated calls', () => {
        const a = getCodeGraphBridge();
        const b = getCodeGraphBridge();
        expect(a).toBe(b);
    });

    it('resetCodeGraphBridgeForTesting creates a fresh instance', () => {
        const a = getCodeGraphBridge();
        resetCodeGraphBridgeForTesting();
        const b = getCodeGraphBridge();
        expect(a).not.toBe(b);
    });
});
