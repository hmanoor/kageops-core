/**
 * codex-windowshide-preload — Node --require preload module.
 *
 * Monkey-patches `child_process.spawn` so EVERY descendant process
 * spawned inside Codex CLI's process tree gets `windowsHide: true`.
 * This is what kills the cmd.exe console popup operators see on
 * Windows when Codex internally invokes taskkill / MCP servers /
 * model-API helpers — those spawns happen inside @openai/codex's
 * own JavaScript, so our top-level `windowsHide:true` on the codex
 * spawn (PR #121) doesn't reach them.
 *
 * Load via Node's `--require` flag:
 *   node --require <dist>/main/codex-windowshide-preload.js \
 *        <path-to-codex.js> exec --color never …
 *
 * Posix is a no-op — `windowsHide` only affects Windows.
 *
 * Safety:
 *   - Monkey-patches the cached `child_process` module's spawn
 *     function. Anything that calls `require('child_process').spawn`
 *     AFTER the preload runs gets the patched version. Anything that
 *     captured the original BEFORE the preload would miss the patch,
 *     but since --require runs before the main script, nothing in
 *     codex.js's import graph has had a chance to cache the original.
 *   - Only the spawn() entry point. exec(), execFile(), fork() etc.
 *     internally call spawn() (or their own implementation that
 *     respects similar flags), so monkey-patching spawn() covers the
 *     vast majority of grandchild creations.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cp from 'child_process';

interface SpawnLike {
    spawn: (...args: any[]) => any;
}

/**
 * Build a patched spawn function that always injects windowsHide:true.
 * Exported for unit testing — the preload's top-level code calls
 * applyWindowsHidePatch which uses this.
 */
export function buildPatchedSpawn(
    originalSpawn: (...args: any[]) => any,
    context: unknown,
): (...args: any[]) => any {
    return function patchedSpawn(this: unknown, ...args: any[]): any {
        // Mirror Node's overload resolution for spawn:
        //   spawn(command)                — opts implicit
        //   spawn(command, args)          — args[1] is array; opts implicit
        //   spawn(command, options)       — args[1] is non-array object
        //   spawn(command, args, options) — args[2] is options
        let optsIdx = -1;
        if (args.length >= 3) {
            optsIdx = 2;
        } else if (
            args.length === 2 &&
            args[1] !== null &&
            typeof args[1] === 'object' &&
            !Array.isArray(args[1])
        ) {
            optsIdx = 1;
        }

        if (optsIdx === -1) {
            args.push({ windowsHide: true });
        } else {
            args[optsIdx] = { ...(args[optsIdx] as object), windowsHide: true };
        }

        return originalSpawn.apply(context, args);
    };
}

/**
 * Replace target.spawn with a patched version that injects
 * windowsHide:true. Uses simple assignment because Electron's asar
 * runtime makes child_process.spawn non-configurable, which would
 * cause Object.defineProperty to throw "Cannot redefine property:
 * spawn" (the regression that shipped in v0.1.7 and crashed the
 * Codex/Claude CLI child before it could run). Assignment still works
 * because the property is `writable: true` even when non-configurable.
 *
 * Returns true if the patch landed, false if it had to be skipped
 * (caller can log the failure mode). Never throws — losing
 * windowsHide is preferable to crashing the entire CLI child.
 */
export function applyWindowsHidePatch(target: SpawnLike): boolean {
    const originalSpawn = target.spawn;
    const patched = buildPatchedSpawn(originalSpawn, target);
    try {
        target.spawn = patched;
        return target.spawn === patched;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
            '[codex-windowshide-preload] could not patch child_process.spawn: ' + msg,
        );
        return false;
    }
}

if (process.platform === 'win32') {
    applyWindowsHidePatch(cp as unknown as SpawnLike);
}
