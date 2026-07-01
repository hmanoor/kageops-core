/**
 * P2-02 — Bundle scaffold copier.
 *
 * Copies the files declared in `bundle.scaffold.files` from the bundle
 * directory into a project workspace, applying {{var}} substitution on
 * text-like files so the scaffold reflects the brief (title, description).
 *
 * Pure module — easy to unit-test against tempdirs without spinning up
 * Forge. Used by the bundled setup-project path in forge.ts (P2-02).
 *
 * Substitution rules (mirrors bundle-prompt-renderer.ts conventions):
 *   - Placeholders are `{{name}}` — no spaces, no expressions.
 *   - Applied to files matching `TEXTLIKE_EXTENSIONS` (markdown, json,
 *     yaml, tsx, ts, js, css, html, env files). Binary files (images,
 *     fonts) are copied byte-for-byte without parsing.
 *   - Missing vars throw — silent omission of a project name into a
 *     `{{title}}` placeholder would land the literal `{{title}}` in
 *     the operator's package.json, which is worse than failing fast.
 *
 * Safety:
 *   - Each destination path is path.resolve'd and must remain inside
 *     `destDir` — a malicious bundle.yaml entry like
 *     `scaffold/../../../etc/passwd` would already be caught by the
 *     bundle-loader's segment-aware check, but defense in depth.
 *   - Existing files are overwritten only if `overwrite: true` is
 *     passed. Default is to throw on collision so an operator can't
 *     accidentally clobber a half-written workspace.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LoadedBundle } from './types';

/**
 * File extensions that get {{var}} substitution applied. Anything else
 * is copied byte-for-byte. Conservative list — we'd rather miss a
 * substitution in a less-common file type than corrupt a binary.
 */
const TEXTLIKE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.md',
    '.txt',
    '.json',
    '.yaml',
    '.yml',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.css',
    '.scss',
    '.html',
    '.htm',
    '.svg',
    '.xml',
    '.toml',
    '.env',
    '.gitignore',
    '.example',
]);

const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

export interface CopyScaffoldInput {
    readonly bundle: LoadedBundle;
    /** Absolute path to the project workspace. Created if missing. */
    readonly destDir: string;
    /** Vars substituted into `{{name}}` placeholders in text-like files. */
    readonly vars: Readonly<Record<string, string>>;
    /** Overwrite collisions instead of throwing. Default false. */
    readonly overwrite?: boolean;
}

export interface CopyScaffoldResult {
    readonly filesCopied: readonly string[];
    /** Paths that were skipped because they collided and overwrite=false. */
    readonly filesSkipped: readonly string[];
}

export async function copyBundleScaffold(
    input: CopyScaffoldInput
): Promise<CopyScaffoldResult> {
    const files = input.bundle.manifest.scaffold?.files ?? [];
    if (files.length === 0) {
        return { filesCopied: [], filesSkipped: [] };
    }

    await fs.mkdir(input.destDir, { recursive: true });
    const resolvedDest = path.resolve(input.destDir);

    const copied: string[] = [];
    const skipped: string[] = [];

    for (const rel of files) {
        // Source: bundle/<rel> (e.g. bundle/scaffold/package.json)
        const src = path.join(input.bundle.directory, rel);

        // Destination: workspace/<rel-without-leading-scaffold>
        // e.g. scaffold/app/page.tsx → app/page.tsx
        const relInWorkspace = stripScaffoldPrefix(rel);
        const dest = path.resolve(resolvedDest, relInWorkspace);

        if (!isInside(dest, resolvedDest)) {
            throw new Error(
                `scaffold entry "${rel}" resolves outside destination: ${dest}`
            );
        }

        const exists = await fileExists(dest);
        if (exists && input.overwrite !== true) {
            skipped.push(relInWorkspace);
            continue;
        }

        await fs.mkdir(path.dirname(dest), { recursive: true });

        const ext = path.extname(rel).toLowerCase();
        const baseName = path.basename(rel);
        const shouldSubstitute =
            TEXTLIKE_EXTENSIONS.has(ext) ||
            // Dotfile names like .env.example / .gitignore have no
            // useful extname; match by full basename instead.
            TEXTLIKE_EXTENSIONS.has(baseName);

        if (shouldSubstitute) {
            const raw = await fs.readFile(src, 'utf8');
            const substituted = substituteVars(raw, input.vars);
            await fs.writeFile(dest, substituted, 'utf8');
        } else {
            await fs.copyFile(src, dest);
        }

        copied.push(relInWorkspace);
    }

    return { filesCopied: copied, filesSkipped: skipped };
}

/**
 * Pure helper exposed for tests + parity with bundle-prompt-renderer.
 * Identical behaviour to renderer's substituteVars — duplicated here to
 * keep the scaffold-copier module dependency-free of the renderer.
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
            `scaffold template references undefined vars: ${Array.from(missing)
                .sort()
                .join(', ')}`
        );
    }
    return result;
}

/**
 * Strip the leading `scaffold/` (or `scaffold\`) segment so files land
 * at the workspace root, not under workspace/scaffold/. Bundles
 * conventionally namespace their declared files under `scaffold/`
 * (matches vanilla-html's pattern — and avoids collision with the
 * bundle's own `prompts/`, `checks/` directories).
 */
function stripScaffoldPrefix(rel: string): string {
    const normalised = rel.replace(/\\/g, '/');
    if (normalised.startsWith('scaffold/')) {
        return normalised.slice('scaffold/'.length);
    }
    return normalised;
}

function isInside(child: string, parent: string): boolean {
    const c = path.resolve(child);
    const p = path.resolve(parent);
    if (c === p) return true;
    return c.startsWith(p + path.sep);
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}
