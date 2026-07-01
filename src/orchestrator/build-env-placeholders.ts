/**
 * Build-time env placeholders (BPF-31).
 *
 * Credential-free build verification (run-locally / no deployment_config) runs
 * `next build` with no secrets. That's the intended thesis — prove the OSS app
 * COMPILES without the operator's keys — but some frameworks need a
 * syntactically-valid PUBLIC key even to PRERENDER static pages. Clerk's
 * `<ClerkProvider>` (in the scaffold's root layout) throws
 * "@clerk/clerk-react: Missing publishableKey" during static export, so the
 * build fails even on a perfect app.
 *
 * The fix: before the build, fill ONLY the build-required keys the operator
 * hasn't supplied with the bundle-declared well-formed placeholders. Real
 * deployment_config values always win (we never overwrite an existing key), and
 * these are used solely for build verification — never a real deploy.
 *
 * Pure merge function + an fs-injected on-disk wrapper. Never throws in the
 * wrapper — a placeholder failure must not block the gate.
 */

import * as path from 'path';

const ENV_LOCAL = '.env.local';
const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Keys already defined in an existing `.env.local` body. */
export function existingEnvKeys(envLocal: string | null): ReadonlySet<string> {
    const keys = new Set<string>();
    if (envLocal === null) return keys;
    for (const line of envLocal.split(/\r?\n/)) {
        if (line.trim().startsWith('#')) continue;
        const m = ENV_KEY_RE.exec(line);
        if (m !== null) keys.add(m[1]);
    }
    return keys;
}

/**
 * Merge placeholders into an existing `.env.local` body, adding ONLY keys not
 * already present. Returns the new contents + the keys added, or null when
 * there's nothing to add. Pure.
 */
export function applyBuildEnvPlaceholders(
    envLocal: string | null,
    placeholders: Readonly<Record<string, string>>,
): { readonly contents: string; readonly added: readonly string[] } | null {
    const present = existingEnvKeys(envLocal);
    const toAdd = Object.keys(placeholders).filter((k) => !present.has(k)).sort();
    if (toAdd.length === 0) return null;

    const lines: string[] = [];
    const base = envLocal ?? '';
    if (base.length > 0) {
        lines.push(base.replace(/\s*$/, ''));
        lines.push('');
    }
    lines.push('# BPF-31 — build-only placeholders (credential-free build verification).');
    lines.push('# Real deployment_config values override these; never used for a real deploy.');
    for (const key of toAdd) {
        lines.push(`${key}=${quoteIfNeeded(placeholders[key])}`);
    }
    return { contents: `${lines.join('\n')}\n`, added: toAdd };
}

/**
 * Read `<repoPath>/.env.local`, fill missing build-required keys with the
 * bundle's placeholders, write it back. Returns the keys added. Never throws.
 */
export async function ensureBuildEnvPlaceholders(
    repoPath: string,
    placeholders: Readonly<Record<string, string>>,
    fsImpl: typeof import('fs'),
): Promise<readonly string[]> {
    if (Object.keys(placeholders).length === 0) return [];
    const filePath = path.join(repoPath, ENV_LOCAL);
    try {
        let current: string | null = null;
        try {
            current = fsImpl.readFileSync(filePath, 'utf-8');
        } catch {
            current = null; // no .env.local yet — materialize skipped
        }
        const merged = applyBuildEnvPlaceholders(current, placeholders);
        if (merged === null) return [];
        fsImpl.writeFileSync(filePath, merged.contents, { encoding: 'utf-8', mode: 0o600 });
        return merged.added;
    } catch {
        return [];
    }
}

function quoteIfNeeded(value: string): string {
    const needsQuote = /[\s=#$`"']/u.test(value);
    if (!needsQuote) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
