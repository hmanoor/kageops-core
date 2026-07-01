/**
 * P1-11 — Bundle prompt renderer.
 *
 * Loads a prompt template file from a bundle directory, substitutes
 * `{{var}}` placeholders, returns the final string. Pure module —
 * easy to unit test, easy to swap out if a future bundle wants a
 * fancier template engine.
 *
 * Conventions:
 *   - Templates are .md files in `<bundle>/prompts/`. Path comes
 *     from `bundle.yaml`'s `prompts.<key>` mapping (e.g.
 *     `prompts/forge-create-ui.md`).
 *   - Placeholders are `{{name}}` — no spaces inside, no expressions,
 *     no conditionals. Anything fancier and you should be using
 *     code, not a template.
 *   - Trailing newlines on the template file are stripped to match
 *     the JS string-literal convention used by the inline Forge
 *     prompts being extracted in P1-11. This keeps equivalence
 *     tests strict without forcing bundle authors to omit the
 *     final newline their editor inserts.
 *   - Missing placeholder vars throw — silent substitution of an
 *     empty string would hide a prompt-author bug behind an LLM that
 *     still produces *something*.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LoadedBundle } from './types';

const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

export interface RenderPromptOptions {
    /** Key from the bundle's `prompts:` map (e.g. `'forge_create_ui'`). */
    readonly promptKey: string;
    /** Vars substituted into `{{name}}` placeholders. Throws if any are missing. */
    readonly vars: Readonly<Record<string, string>>;
}

export async function renderBundlePrompt(
    bundle: LoadedBundle,
    opts: RenderPromptOptions
): Promise<string> {
    const promptRelativePath = bundle.manifest.prompts?.[opts.promptKey];
    if (promptRelativePath === undefined) {
        throw new Error(
            `bundle "${bundle.manifest.kind}::${bundle.manifest.name}" has no prompt "${opts.promptKey}"`
        );
    }

    const promptAbsPath = path.join(bundle.directory, promptRelativePath);

    // Defensive — the loader already validates paths in bundle.yaml,
    // but the bundle author could symlink or use a path we already
    // rejected. Confirm at render time that we're still inside the
    // bundle directory.
    const resolvedPrompt = path.resolve(promptAbsPath);
    const resolvedBundleDir = path.resolve(bundle.directory);
    if (!resolvedPrompt.startsWith(resolvedBundleDir + path.sep) && resolvedPrompt !== resolvedBundleDir) {
        throw new Error(
            `bundle "${bundle.manifest.name}" prompt path escapes bundle directory: ${promptRelativePath}`
        );
    }

    const raw = await fs.readFile(promptAbsPath, 'utf8');
    // Normalise CRLF → LF before placeholder substitution so bundle
    // prompts read identically on Windows (where git's autocrlf can
    // rewrite .md files to CRLF on stage) and on macOS/Linux. The
    // equivalence test against inline `\n`-only JS string literals
    // depends on this.
    const normalised = raw.replace(/\r\n/g, '\n');
    const trimmed = stripSingleTrailingNewline(normalised);
    return substituteVars(trimmed, opts.vars);
}

/**
 * Pure helper exposed for tests + for callers that already have the
 * template string in memory (e.g. equivalence tests).
 */
export function substituteVars(
    template: string,
    vars: Readonly<Record<string, string>>
): string {
    const missing = new Set<string>();
    const result = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
        const value = vars[name];
        if (value === undefined) {
            missing.add(name);
            return '';
        }
        return value;
    });
    if (missing.size > 0) {
        throw new Error(
            `prompt template references undefined vars: ${Array.from(missing).sort().join(', ')}`
        );
    }
    return result;
}

function stripSingleTrailingNewline(s: string): string {
    if (s.endsWith('\r\n')) return s.slice(0, -2);
    if (s.endsWith('\n')) return s.slice(0, -1);
    return s;
}
