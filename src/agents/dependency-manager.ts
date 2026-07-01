/**
 * Dependency Manager
 *
 * When Forge writes code that imports external packages, this module
 * detects missing npm dependencies and adds them to package.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isValidNpmPackageName, sanitizePackageJson } from './output-parser';

// ── Types ───────────────────────────────────────────

export interface DepChange {
    readonly name: string;
    readonly version: string;
    readonly isDev: boolean;
}

// ── Constants ───────────────────────────────────────

const NODE_BUILTINS = new Set([
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'dgram',
    'events', 'stream', 'url', 'util', 'child_process', 'cluster',
    'readline', 'buffer', 'assert', 'tty', 'zlib', 'querystring',
    'string_decoder', 'fs/promises', 'path/posix', 'path/win32',
    'node:fs', 'node:path', 'node:os', 'node:crypto', 'node:http',
    'node:https', 'node:net', 'node:dgram', 'node:events', 'node:stream',
    'node:url', 'node:util', 'node:child_process', 'node:cluster',
    'node:readline', 'node:buffer', 'node:assert', 'node:tty', 'node:zlib',
    'node:querystring', 'node:string_decoder', 'node:fs/promises',
    'worker_threads', 'node:worker_threads', 'perf_hooks', 'node:perf_hooks',
    'timers', 'node:timers', 'dns', 'node:dns', 'v8', 'node:v8',
    'vm', 'node:vm', 'module', 'node:module', 'inspector', 'node:inspector',
    'async_hooks', 'node:async_hooks', 'diagnostics_channel', 'node:diagnostics_channel',
    'process', 'node:process', 'console', 'node:console',
]);

/** Patterns that match ES import, require, and dynamic import */
const IMPORT_PATTERNS = [
    /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|__tests__[/\\])/;

// ── Helpers ─────────────────────────────────────────

/**
 * Extract the npm package name from an import specifier.
 * Handles scoped packages (@foo/bar) and subpath imports (lodash/get → lodash).
 * Returns null for relative imports.
 */
function extractPackageName(specifier: string): string | null {
    // Relative or absolute paths
    if (specifier.startsWith('.') || specifier.startsWith('/')) return null;

    // Scoped package: @scope/name or @scope/name/subpath
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        if (parts.length >= 2) {
            return `${parts[0]}/${parts[1]}`;
        }
        return null;
    }

    // Regular package: name or name/subpath
    return specifier.split('/')[0];
}

/**
 * Extract all import specifiers from a file's content.
 */
function extractImports(content: string): ReadonlySet<string> {
    const imports = new Set<string>();

    for (const pattern of IMPORT_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            const pkg = extractPackageName(match[1]);
            if (pkg !== null) {
                imports.add(pkg);
            }
        }
    }

    return imports;
}

/**
 * Check if a specifier is a Node.js builtin (with or without node: prefix).
 */
function isNodeBuiltin(specifier: string): boolean {
    return NODE_BUILTINS.has(specifier);
}

/**
 * Read the import-alias prefixes declared in the workspace tsconfig
 * (`compilerOptions.paths`). Returns the alias roots with any trailing
 * `/*` / `*` stripped (e.g. `{ "@/*": ["./*"] }` → `["@/"]`).
 *
 * BPF-11a: weak models emit imports against these aliases (`@/components`)
 * which are LOCAL paths, not npm packages — they must never be added to
 * package.json. tsconfig is the authoritative source of which prefixes are
 * local, so we honour whatever the scaffold declared rather than guessing.
 */
function readTsconfigAliasPrefixes(repoPath: string): readonly string[] {
    const tsconfigPath = path.join(repoPath, 'tsconfig.json');
    let raw: string;
    try {
        raw = fs.readFileSync(tsconfigPath, 'utf-8');
    } catch {
        return [];
    }
    let parsed: { compilerOptions?: { paths?: Record<string, unknown> } };
    try {
        // Tolerate `//` and `/* */` comments that some scaffolds include.
        const stripped = raw
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
        parsed = JSON.parse(stripped);
    } catch {
        return [];
    }
    const paths = parsed.compilerOptions?.paths;
    if (paths === undefined || paths === null) return [];
    return Object.keys(paths).map((key) => key.replace(/\*$/, ''));
}

/**
 * Decide whether an import specifier resolves to something LOCAL to the repo
 * (a tsconfig path alias, or a top-level file/dir) rather than an npm package.
 * BPF-11a — prevents `DependencyManager` from polluting package.json with
 * `@/components`, `src`, etc.
 */
function isLocalSpecifier(
    specifier: string,
    pkgName: string,
    repoPath: string,
    aliasPrefixes: readonly string[],
): boolean {
    // tsconfig path alias (e.g. `@/...`, `~/...`).
    if (aliasPrefixes.some((prefix) => prefix.length > 0 && specifier.startsWith(prefix))) {
        return true;
    }
    // Bare specifier whose first segment is a real top-level dir/file
    // (e.g. `import 'src/db'` when `src/` exists at the repo root).
    const firstSegment = pkgName.startsWith('@')
        ? pkgName
        : pkgName.split('/')[0];
    if (!firstSegment.startsWith('@')) {
        if (
            fs.existsSync(path.join(repoPath, firstSegment)) ||
            fs.existsSync(path.join(repoPath, `${firstSegment}.ts`)) ||
            fs.existsSync(path.join(repoPath, `${firstSegment}.tsx`))
        ) {
            return true;
        }
    }
    return false;
}

// ── Main Class ──────────────────────────────────────

export class DependencyManager {
    /**
     * Scan written files for import statements that reference npm packages
     * (not relative paths). Compare against existing package.json deps.
     * Return list of missing packages that need to be added.
     */
    findMissingDeps(repoPath: string, writtenFiles: readonly string[]): readonly DepChange[] {
        const pkgJsonPath = path.join(repoPath, 'package.json');

        if (!fs.existsSync(pkgJsonPath)) {
            return [];
        }

        let pkgJson: Record<string, unknown>;
        try {
            pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        } catch {
            return [];
        }

        const existingDeps = new Set<string>([
            ...Object.keys((pkgJson.dependencies as Record<string, string>) ?? {}),
            ...Object.keys((pkgJson.devDependencies as Record<string, string>) ?? {}),
        ]);

        const aliasPrefixes = readTsconfigAliasPrefixes(repoPath);
        const missingMap = new Map<string, { isDev: boolean }>();

        for (const filePath of writtenFiles) {
            const fullPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(repoPath, filePath);

            let content: string;
            try {
                content = fs.readFileSync(fullPath, 'utf-8');
            } catch {
                continue;
            }

            const isTestFile = TEST_FILE_PATTERN.test(filePath);

            // Re-extract with the raw specifiers so we can test alias prefixes
            // (extractImports collapses to package names and drops the alias).
            for (const pattern of IMPORT_PATTERNS) {
                const regex = new RegExp(pattern.source, pattern.flags);
                let m: RegExpExecArray | null;
                while ((m = regex.exec(content)) !== null) {
                    const specifier = m[1];
                    const pkg = extractPackageName(specifier);
                    if (pkg === null) continue;
                    if (isNodeBuiltin(pkg)) continue;
                    if (existingDeps.has(pkg)) continue;
                    // BPF-11a: never add local paths or malformed npm names.
                    if (isLocalSpecifier(specifier, pkg, repoPath, aliasPrefixes)) continue;
                    if (!isValidNpmPackageName(pkg)) continue;

                    const existing = missingMap.get(pkg);
                    if (existing === undefined) {
                        missingMap.set(pkg, { isDev: isTestFile });
                    } else if (!isTestFile) {
                        // If any non-test file imports it, it's a regular dep.
                        missingMap.set(pkg, { isDev: false });
                    }
                }
            }
        }

        return [...missingMap.entries()].map(([name, { isDev }]) => ({
            name,
            version: '*',
            isDev,
        }));
    }

    /**
     * Add missing dependencies to package.json without overwriting existing ones.
     * Does NOT run npm install.
     */
    addToPackageJson(repoPath: string, deps: readonly DepChange[]): void {
        if (deps.length === 0) return;

        const pkgJsonPath = path.join(repoPath, 'package.json');
        const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(raw) as Record<string, unknown>;

        const dependencies = { ...((pkgJson.dependencies as Record<string, string>) ?? {}) };
        const devDependencies = { ...((pkgJson.devDependencies as Record<string, string>) ?? {}) };

        for (const dep of deps) {
            // BPF-11a: defence in depth — never write a malformed npm name even
            // if a caller hands one in (findMissingDeps already filters these).
            if (!isValidNpmPackageName(dep.name)) continue;
            if (dep.isDev) {
                if (!(dep.name in devDependencies) && !(dep.name in dependencies)) {
                    devDependencies[dep.name] = dep.version;
                }
            } else {
                if (!(dep.name in dependencies) && !(dep.name in devDependencies)) {
                    dependencies[dep.name] = dep.version;
                }
            }
        }

        const updated = {
            ...pkgJson,
            dependencies,
            devDependencies,
        };

        // Final pass through the shared package.json sanitizer (BPF-9) so the
        // on-disk manifest is always clean regardless of what was already there.
        const serialized = sanitizePackageJson(JSON.stringify(updated, null, 2) + '\n');
        fs.writeFileSync(pkgJsonPath, serialized, 'utf-8');
    }
}

// ── Exported Helpers (for testing) ──────────────────

export { extractPackageName, extractImports, isNodeBuiltin };
