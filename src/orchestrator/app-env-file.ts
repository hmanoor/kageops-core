/**
 * BPF-35 — file-based app-env source for headless self-deploy.
 *
 * The deploy path (build `.env.local` materialise + Vercel `--env` forwarding)
 * reads the project's app credentials — Clerk / Stripe / Neon keys, the app's
 * own DATABASE_URL — from `projects.deployment_config`, which is encrypted with
 * Electron `safeStorage`. That's perfect for the desktop app but DEAD on a
 * headless run: there's no Electron, no keychain, and no New-Project modal to
 * type the secrets into. So a `npx tsx headless-runner` deploy reached Vercel
 * with NO `--env` and the preview crashed at first request — which is exactly
 * why the ClubHub deploy had to be driven by hand outside the run.
 *
 * This module gives the headless runner the missing credential source: point
 * `KAGEOPS_APP_ENV_FILE` at a dotenv file holding the app's runtime env and the
 * deploy path materialises it into `.env.local` (for `next build`) AND forwards
 * it as `vercel deploy --env KEY=VALUE` (for runtime). The Vercel TOKEN stays
 * separate (`KAGEOPS_VERCEL_TOKEN`); this file is purely the deployed app's env.
 *
 * BPF-19 SAFETY (non-negotiable): these values are written to the workspace
 * `.env.local` and passed to the deploy SUBPROCESS only. They are NEVER assigned
 * into the orchestrator's `process.env`. In particular the app's own
 * DATABASE_URL must not leak into the orchestrator, where it would hijack the
 * embedded PGlite/event-bus connection. `loadAppEnvFile` returns a plain map and
 * does no global mutation — callers must keep it that way.
 */

import { createLogger } from '../shared/logger';

const log = createLogger('AppEnvFile');

const APP_ENV_FILE_VAR = 'KAGEOPS_APP_ENV_FILE';

/** Resolve the configured app-env file path, or null when unset/empty. */
export function appEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = (env[APP_ENV_FILE_VAR] ?? '').trim();
    return raw.length > 0 ? raw : null;
}

export interface ReadFileSync {
    (path: string, encoding: 'utf-8'): string;
}

/**
 * Parse a dotenv-style app-env file into a flat KEY→VALUE map. Returns null
 * when the path is unset, missing, unreadable, or yields no keys (the caller
 * then falls back to the encrypted deployment_config). Never throws.
 *
 * Supported syntax (deliberately small + robust — operators hand-write this):
 *   - `KEY=value` and `export KEY=value`
 *   - `# comments` and blank lines (ignored)
 *   - single- or double-quoted values (quotes stripped; preserves `#`, spaces,
 *     and the `&channel_binding=…` tail of a Neon URL that would otherwise be
 *     truncated by an inline-comment strip)
 *   - unquoted values are taken verbatim to end-of-line (no inline-comment
 *     stripping — a Postgres URL legitimately contains no `#`, and stripping
 *     risked eating query strings)
 */
export function loadAppEnvFile(
    path: string,
    readFileSync: ReadFileSync,
): Readonly<Record<string, string>> | null {
    let content: string;
    try {
        content = readFileSync(path, 'utf-8');
    } catch (err) {
        log.warn(
            { path, err: err instanceof Error ? err.message : String(err) },
            'app-env file unreadable — falling back to deployment_config',
        );
        return null;
    }

    const out: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) continue;

        const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
        const eq = withoutExport.indexOf('=');
        if (eq <= 0) continue;

        const key = withoutExport.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        out[key] = unquote(withoutExport.slice(eq + 1).trim());
    }

    const keyCount = Object.keys(out).length;
    if (keyCount === 0) {
        log.warn({ path }, 'app-env file parsed to 0 keys — falling back to deployment_config');
        return null;
    }
    log.info({ path, keyCount }, 'BPF-35: loaded app env from KAGEOPS_APP_ENV_FILE for headless deploy');
    return out;
}

function unquote(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value;
}
