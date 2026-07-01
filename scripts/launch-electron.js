#!/usr/bin/env node
/**
 * Launch Electron with `ELECTRON_RUN_AS_NODE` actually unset.
 *
 * Background: VS Code (and Claude Code running inside it) propagate
 * `ELECTRON_RUN_AS_NODE=1` to every child process spawned from its
 * integrated terminal. When that env var is *present* — even with an
 * empty value — Electron starts in pure-Node.js mode and the app
 * crashes immediately with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'commandLine')
 *
 * because `require('electron')` returns a string path instead of the
 * API surface.
 *
 * The earlier `cross-env ELECTRON_RUN_AS_NODE= electron .` workaround
 * is **not** sufficient — `cross-env KEY=` sets the variable to the
 * empty string but leaves it present in `process.env`, and Electron's
 * native runtime check is for presence (via `getenv()` returning
 * non-null), not for truthiness. The variable must actually be deleted.
 *
 * This wrapper:
 *   1. Deletes `ELECTRON_RUN_AS_NODE` from its own env
 *   2. Resolves the local Electron binary (./node_modules/.bin/electron)
 *   3. Spawns it with the project root (`.`) as the only arg, plus any
 *      extra args this script was launched with
 *   4. Forwards stdio + the cleaned env, exits with the child's code
 *
 * Cross-platform: works on Windows / macOS / Linux because we use
 * Node's `spawn` with `shell: true`, which lets the platform's
 * `electron.cmd` / `electron` shim resolve correctly.
 */

const { spawn } = require('node:child_process');

// Strip the offending env var BEFORE the child inherits our env.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// `require('electron')` resolves to the absolute path of the platform
// binary inside `node_modules/electron/dist/...` — same trick the
// `node_modules/.bin/electron` shim uses internally. No shell needed,
// so we sidestep the Node deprecation warning about shell+args.
const electronBin = require('electron');

const args = ['.', ...process.argv.slice(2)];
const child = spawn(electronBin, args, {
    stdio: 'inherit',
    env,
});

child.on('exit', (code, signal) => {
    if (signal !== null) {
        process.exit(1);
    }
    process.exit(code ?? 0);
});

child.on('error', (err) => {
    // Use process.stderr.write rather than console.error to match the
    // surrounding npm-script output stream and avoid pino-style framing.
    process.stderr.write(`launch-electron: failed to spawn ${electronBin}: ${err.message}\n`);
    process.exit(1);
});
