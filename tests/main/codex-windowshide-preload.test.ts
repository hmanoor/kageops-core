/**
 * codex-windowshide-preload tests
 *
 * Anchors the v0.1.7 → v0.1.8 hotfix: the preload's patch step must
 * NOT throw on a child_process module whose `spawn` is non-configurable
 * (which is how Electron's asar runtime exposes it). Earlier code used
 * Object.defineProperty and crashed every Codex/Claude CLI child with
 * "Cannot redefine property: spawn".
 */

import { describe, it, expect, vi } from 'vitest';

import {
    applyWindowsHidePatch,
    buildPatchedSpawn,
} from '../../src/main/codex-windowshide-preload';

interface MutableTarget {
    spawn: (...args: unknown[]) => unknown;
}

function makeConfigurableTarget(impl: (...args: unknown[]) => unknown): MutableTarget {
    const target: MutableTarget = { spawn: impl };
    return target;
}

function makeAsarLockedTarget(impl: (...args: unknown[]) => unknown): MutableTarget {
    // Mirror Electron's asar shim: writable:true but configurable:false.
    // Plain assignment still works; Object.defineProperty would throw.
    const target = {} as MutableTarget;
    Object.defineProperty(target, 'spawn', {
        configurable: false,
        writable: true,
        value: impl,
    });
    return target;
}

function makeFrozenTarget(impl: (...args: unknown[]) => unknown): MutableTarget {
    const target = {} as MutableTarget;
    Object.defineProperty(target, 'spawn', {
        configurable: false,
        writable: false,
        value: impl,
    });
    return target;
}

describe('buildPatchedSpawn', () => {
    it('injects windowsHide:true when called with command only', () => {
        const original = vi.fn();
        const patched = buildPatchedSpawn(original, {});
        patched('cmd.exe');
        expect(original).toHaveBeenCalledWith('cmd.exe', { windowsHide: true });
    });

    it('injects windowsHide:true when called with command + args array', () => {
        const original = vi.fn();
        const patched = buildPatchedSpawn(original, {});
        patched('cmd.exe', ['/c', 'echo']);
        expect(original).toHaveBeenCalledWith('cmd.exe', ['/c', 'echo'], { windowsHide: true });
    });

    it('merges windowsHide into existing options (2-arg form)', () => {
        const original = vi.fn();
        const patched = buildPatchedSpawn(original, {});
        patched('cmd.exe', { cwd: 'C:\\tmp', stdio: 'pipe' });
        expect(original).toHaveBeenCalledWith('cmd.exe', {
            cwd: 'C:\\tmp',
            stdio: 'pipe',
            windowsHide: true,
        });
    });

    it('merges windowsHide into existing options (3-arg form)', () => {
        const original = vi.fn();
        const patched = buildPatchedSpawn(original, {});
        patched('node', ['script.js'], { env: { FOO: '1' } });
        expect(original).toHaveBeenCalledWith(
            'node',
            ['script.js'],
            { env: { FOO: '1' }, windowsHide: true },
        );
    });

    it('does not mutate caller-provided options object', () => {
        const original = vi.fn();
        const patched = buildPatchedSpawn(original, {});
        const opts = { cwd: 'C:\\tmp' };
        patched('cmd.exe', opts);
        expect(opts).toEqual({ cwd: 'C:\\tmp' });
    });
});

describe('applyWindowsHidePatch', () => {
    it('replaces spawn when the property is configurable (plain Node case)', () => {
        const original = vi.fn();
        const target = makeConfigurableTarget(original);
        const ok = applyWindowsHidePatch(target);
        expect(ok).toBe(true);
        expect(target.spawn).not.toBe(original);
        target.spawn('cmd.exe');
        expect(original).toHaveBeenCalledWith('cmd.exe', { windowsHide: true });
    });

    it('does not throw on non-configurable spawn (Electron asar runtime case)', () => {
        // This is the v0.1.7 regression: Object.defineProperty threw
        // "Cannot redefine property: spawn" here. Assignment must work.
        const original = vi.fn();
        const target = makeAsarLockedTarget(original);
        let threw = false;
        let ok = false;
        try {
            ok = applyWindowsHidePatch(target);
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
        expect(ok).toBe(true);
        target.spawn('cmd.exe');
        expect(original).toHaveBeenCalledWith('cmd.exe', { windowsHide: true });
    });

    it('does not throw when spawn is fully frozen — returns false instead', () => {
        // Defensive: a future runtime that locks the property entirely
        // (writable:false too) must not crash the CLI child.
        const original = vi.fn();
        const target = makeFrozenTarget(original);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let threw = false;
        let ok = true;
        try {
            ok = applyWindowsHidePatch(target);
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
        expect(ok).toBe(false);
        // Spawn keeps the original implementation — no windowsHide,
        // but the CLI keeps working.
        expect(target.spawn).toBe(original);
        warnSpy.mockRestore();
    });
});
