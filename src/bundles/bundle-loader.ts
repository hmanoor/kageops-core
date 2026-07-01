/**
 * P1-10 — Bundle loader.
 *
 * Walks `bundles/{stacks,capabilities,deployers}/<name>/bundle.yaml`,
 * parses each manifest, validates against the schema in `types.ts`,
 * and returns a typed result with both successes and per-bundle errors.
 *
 * Intentional non-features:
 *   - No caching. Bundles are loaded once at process boot; callers cache.
 *   - No hot reload. Edit a bundle → restart KageOps.
 *   - No execution. Scaffold files + check modules are NOT resolved
 *     or required — the loader only captures their string paths.
 *
 * Failure mode: ENOENT on the bundles root is non-fatal (returns
 * empty result). Anything else surfaces as an error in the result;
 * callers decide whether to crash.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { createLogger } from '../shared/logger';
import { checkBundleCompat } from './bundle-compat';
import type {
    BundleKind,
    BundleLoadError,
    BundleLoadResult,
    BundleManifest,
    LoadedBundle,
} from './types';

// Sourced from package.json at bundle build time; resolveJsonModule + esModuleInterop
// make the default import here type-safe. Imported lazily through a helper so tests
// can override per-call without prying into module internals.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG = require('../../package.json') as { readonly version: string };

/**
 * Default host version used for compat checks when callers don't pass
 * one. Exposed for tests that want to assert against it.
 */
export const HOST_KAGEOPS_VERSION = PKG.version;

const log = createLogger('Bundles');

const KIND_DIRS: ReadonlyArray<BundleKind> = ['stack', 'capability', 'deployer'];

/** Map kind enum to its directory name (plural). */
const KIND_TO_DIRNAME: Readonly<Record<BundleKind, string>> = {
    stack: 'stacks',
    capability: 'capabilities',
    deployer: 'deployers',
};

const MANIFEST_FILENAME = 'bundle.yaml';

/**
 * Locate the bundles root. Honours `KAGEOPS_BUNDLES_DIR` for tests +
 * out-of-tree bundle authoring. Otherwise falls back to `<repoRoot>/bundles`.
 *
 * `repoRoot` defaults to `process.cwd()` because both the dev workflow
 * (`npm run dev`) and the production runtime (electron app from `app.asar`)
 * resolve relative to the project root.
 */
export function resolveBundlesRoot(repoRoot: string = process.cwd()): string {
    const override = process.env['KAGEOPS_BUNDLES_DIR'];
    if (override !== undefined && override.length > 0) {
        return path.resolve(override);
    }
    return path.resolve(repoRoot, 'bundles');
}

/**
 * Discover + load every bundle under `bundlesRoot`. Never throws —
 * per-bundle failures land in `result.errors` so a single broken
 * bundle doesn't take the loader down.
 *
 * @param kageOpsVersion Host version used for the P1-13 compat check
 *   on each bundle's `kageops_version` constraint. Defaults to the
 *   running app's `package.json#version`. Tests can pass any value.
 */
export async function loadBundles(
    bundlesRoot: string = resolveBundlesRoot(),
    kageOpsVersion: string = HOST_KAGEOPS_VERSION
): Promise<BundleLoadResult> {
    const bundles: LoadedBundle[] = [];
    const errors: BundleLoadError[] = [];

    let rootExists: boolean;
    try {
        const stat = await fs.stat(bundlesRoot);
        rootExists = stat.isDirectory();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            log.debug({ bundlesRoot }, 'bundles root missing — returning empty result');
            return { bundles: [], errors: [] };
        }
        // Permission errors, etc. — surface as a single root-level error.
        return {
            bundles: [],
            errors: [
                {
                    directory: bundlesRoot,
                    reason: `cannot stat bundles root: ${getErrorMessage(err)}`,
                },
            ],
        };
    }

    if (!rootExists) {
        return { bundles: [], errors: [] };
    }

    for (const kind of KIND_DIRS) {
        const kindDir = path.join(bundlesRoot, KIND_TO_DIRNAME[kind]);
        let entries: readonly string[];
        try {
            entries = await fs.readdir(kindDir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
            errors.push({
                directory: kindDir,
                reason: `cannot read kind directory: ${getErrorMessage(err)}`,
            });
            continue;
        }

        for (const entry of entries) {
            const bundleDir = path.join(kindDir, entry);
            let entryStat: import('node:fs').Stats;
            try {
                entryStat = await fs.stat(bundleDir);
            } catch (err) {
                errors.push({
                    directory: bundleDir,
                    reason: `cannot stat entry: ${getErrorMessage(err)}`,
                });
                continue;
            }
            if (!entryStat.isDirectory()) continue;

            const loaded = await loadBundleFromDirectory(bundleDir, kind, kageOpsVersion);
            if ('manifest' in loaded) {
                bundles.push(loaded);
            } else {
                errors.push(loaded);
            }
        }
    }

    log.info(
        { bundleCount: bundles.length, errorCount: errors.length, bundlesRoot },
        'bundle load complete'
    );
    return { bundles, errors };
}

/**
 * Load + validate a single bundle directory. Returned shape is a
 * discriminated union — caller checks `'manifest' in result`.
 *
 * Exported for tests that want to exercise one bundle in isolation.
 *
 * @param kageOpsVersion Host version used for the P1-13 compat
 *   check. Defaults to the running app's `package.json#version`.
 */
export async function loadBundleFromDirectory(
    bundleDir: string,
    expectedKind: BundleKind,
    kageOpsVersion: string = HOST_KAGEOPS_VERSION
): Promise<LoadedBundle | BundleLoadError> {
    const manifestPath = path.join(bundleDir, MANIFEST_FILENAME);

    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                directory: bundleDir,
                reason: `missing ${MANIFEST_FILENAME}`,
            };
        }
        return {
            directory: bundleDir,
            reason: `cannot read ${MANIFEST_FILENAME}: ${getErrorMessage(err)}`,
        };
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(raw);
    } catch (err) {
        return {
            directory: bundleDir,
            reason: `YAML parse error: ${getErrorMessage(err)}`,
        };
    }

    const validation = validateManifest(parsed, expectedKind);
    if (!validation.ok) {
        return { directory: bundleDir, reason: validation.reason };
    }

    // P1-13: bundle declared its host requirement → check it.
    const compat = checkBundleCompat(validation.manifest.kageops_version, kageOpsVersion);
    if (!compat.ok) {
        log.warn(
            {
                bundleDir,
                bundle: `${validation.manifest.kind}::${validation.manifest.name}`,
                reason: compat.reason,
            },
            'P1-13: bundle skipped — host compatibility check failed'
        );
        return { directory: bundleDir, reason: compat.reason };
    }

    return {
        manifest: validation.manifest,
        directory: path.resolve(bundleDir),
    };
}

// ── Validation ──

type ValidationResult =
    | { readonly ok: true; readonly manifest: BundleManifest }
    | { readonly ok: false; readonly reason: string };

function validateManifest(input: unknown, expectedKind: BundleKind): ValidationResult {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, reason: 'manifest is not an object' };
    }
    const obj = input as Record<string, unknown>;

    if (obj['schemaVersion'] !== 1) {
        return {
            ok: false,
            reason: `schemaVersion must be 1 (got ${JSON.stringify(obj['schemaVersion'])})`,
        };
    }

    const name = obj['name'];
    if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, reason: 'name must be a non-empty string' };
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return {
            ok: false,
            reason: `name must be kebab-case (lowercase, digits, hyphens; cannot start with hyphen) — got "${name}"`,
        };
    }

    const kind = obj['kind'];
    if (kind !== 'stack' && kind !== 'capability' && kind !== 'deployer') {
        return {
            ok: false,
            reason: `kind must be one of stack|capability|deployer (got ${JSON.stringify(kind)})`,
        };
    }
    if (kind !== expectedKind) {
        return {
            ok: false,
            reason: `manifest kind="${kind}" does not match directory (expected "${expectedKind}")`,
        };
    }

    const version = obj['version'];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
        return {
            ok: false,
            reason: `version must be a semver string (e.g. "1.0.0") — got ${JSON.stringify(version)}`,
        };
    }

    if (obj['kageops_version'] !== undefined && typeof obj['kageops_version'] !== 'string') {
        return { ok: false, reason: 'kageops_version, if provided, must be a string' };
    }

    const description = obj['description'];
    if (typeof description !== 'string' || description.length === 0) {
        return { ok: false, reason: 'description must be a non-empty string' };
    }

    // Optional sub-shapes — light validation, deep validation is per-PR-future.
    const matchOk = validateMatchBlock(obj['match']);
    if (matchOk !== null) return { ok: false, reason: matchOk };

    const scaffoldOk = validateScaffoldBlock(obj['scaffold']);
    if (scaffoldOk !== null) return { ok: false, reason: scaffoldOk };

    const promptsOk = validatePromptsBlock(obj['prompts']);
    if (promptsOk !== null) return { ok: false, reason: promptsOk };

    const buildOk = validateBuildBlock(obj['build']);
    if (buildOk !== null) return { ok: false, reason: buildOk };

    const checksOk = validateChecksBlock(obj['checks']);
    if (checksOk !== null) return { ok: false, reason: checksOk };

    const acceptanceOk = validateAcceptanceBlock(obj['acceptance']);
    if (acceptanceOk !== null) return { ok: false, reason: acceptanceOk };

    const deploymentOk = validateDeploymentBlock(obj['deployment']);
    if (deploymentOk !== null) return { ok: false, reason: deploymentOk };

    return {
        ok: true,
        manifest: obj as unknown as BundleManifest,
    };
}

function validateMatchBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'match must be an object if provided';
    }
    const m = input as Record<string, unknown>;
    for (const field of ['phrases', 'tags', 'rejectPhrases']) {
        const value = m[field];
        if (value === undefined) continue;
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
            return `match.${field} must be a string[] if provided`;
        }
    }
    return null;
}

function validateScaffoldBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'scaffold must be an object if provided';
    }
    const s = input as Record<string, unknown>;
    if (s['files'] === undefined) {
        return 'scaffold.files is required when scaffold is provided';
    }
    if (!Array.isArray(s['files']) || !s['files'].every((v) => typeof v === 'string')) {
        return 'scaffold.files must be a string[]';
    }
    for (const file of s['files'] as readonly string[]) {
        if (hasParentDirSegment(file)) {
            return `scaffold.files entry "${file}" must not contain a ".." path segment (path traversal)`;
        }
        if (path.isAbsolute(file)) {
            return `scaffold.files entry "${file}" must be relative`;
        }
    }
    return null;
}

/**
 * Detect ".." used as a path SEGMENT (i.e., parent-dir traversal) without
 * rejecting legitimate "..." sequences that App Router catch-all routes
 * use ("[[...sign-in]]"). Splits on both POSIX and Windows separators.
 */
function hasParentDirSegment(p: string): boolean {
    return p.split(/[/\\]/).some((seg) => seg === '..');
}

function validatePromptsBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'prompts must be an object if provided';
    }
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (typeof value !== 'string') {
            return `prompts.${key} must be a string path`;
        }
        if (hasParentDirSegment(value) || path.isAbsolute(value)) {
            return `prompts.${key} path "${value}" must be a relative, non-traversing path`;
        }
    }
    return null;
}

function validateBuildBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'build must be an object if provided';
    }
    const b = input as Record<string, unknown>;
    if (b['skip_npm'] !== undefined && typeof b['skip_npm'] !== 'boolean') {
        return 'build.skip_npm must be a boolean if provided';
    }
    if (
        b['acceptance_required_ids'] !== undefined &&
        b['acceptance_required_ids'] !== 'extract_from_description' &&
        b['acceptance_required_ids'] !== 'none'
    ) {
        return 'build.acceptance_required_ids must be "extract_from_description" | "none" if provided';
    }
    if (b['framework_label'] !== undefined && typeof b['framework_label'] !== 'string') {
        return 'build.framework_label must be a string if provided';
    }
    return null;
}

function validateAcceptanceBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'acceptance must be an object if provided';
    }
    const a = input as Record<string, unknown>;

    const kind = a['kind'];
    if (kind !== 'html-ids' && kind !== 'build-tests-preview') {
        return `acceptance.kind must be "html-ids" | "build-tests-preview" (got ${JSON.stringify(kind)})`;
    }

    if (a['preview_routes'] !== undefined) {
        if (
            !Array.isArray(a['preview_routes']) ||
            !a['preview_routes'].every((v) => typeof v === 'string')
        ) {
            return 'acceptance.preview_routes must be a string[] if provided';
        }
        for (const route of a['preview_routes'] as readonly string[]) {
            if (!route.startsWith('/')) {
                return `acceptance.preview_routes entry "${route}" must start with "/"`;
            }
        }
    }

    if (a['required_test_pass_rate'] !== undefined) {
        const rate = a['required_test_pass_rate'];
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
            return 'acceptance.required_test_pass_rate must be a number in [0, 1] if provided';
        }
    }

    return null;
}

function validateChecksBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'checks must be an object if provided';
    }
    const c = input as Record<string, unknown>;
    if (c['vigil_module'] !== undefined) {
        if (typeof c['vigil_module'] !== 'string') {
            return 'checks.vigil_module must be a string if provided';
        }
        if (hasParentDirSegment(c['vigil_module']) || path.isAbsolute(c['vigil_module'])) {
            return `checks.vigil_module "${c['vigil_module']}" must be a relative, non-traversing path`;
        }
    }
    return null;
}

// P2.2-01 — deployment block validation (D-C).
//
// Provider is a literal 'vercel' in PR-A (D-H scope: Vercel only).
// Every *_url field is validated as `https://…`. Every `format_regex`
// is compile-tested so a malformed pattern fails at load time, not at
// modal-render time.

const SUPPORTED_DEPLOYMENT_PROVIDERS: readonly string[] = ['vercel'];
const ENV_VAR_URL_FIELDS = ['signup_url', 'dashboard_url', 'docs_url'] as const;
const PROVIDER_HELP_URL_FIELDS = ['signup_url', 'token_url', 'docs_url'] as const;
// Conservative `key` shape — uppercase letters, digits, underscores. Matches POSIX env-var convention
// and what Next.js + Node both expect. Catches lowercase typos and accidental dots/dashes early.
const ENV_VAR_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function validateDeploymentBlock(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'deployment must be an object if provided';
    }
    const d = input as Record<string, unknown>;

    const provider = d['provider'];
    if (typeof provider !== 'string') {
        return 'deployment.provider must be a string';
    }
    if (!SUPPORTED_DEPLOYMENT_PROVIDERS.includes(provider)) {
        return `deployment.provider "${provider}" not supported — must be one of ${SUPPORTED_DEPLOYMENT_PROVIDERS.join('|')}`;
    }

    const providerHelpErr = validateProviderHelp(d['provider_help']);
    if (providerHelpErr !== null) return providerHelpErr;

    const requiredEnvErr = validateEnvList(d['required_env'], 'required_env');
    if (requiredEnvErr !== null) return requiredEnvErr;

    const optionalEnvErr = validateEnvList(d['optional_env'], 'optional_env');
    if (optionalEnvErr !== null) return optionalEnvErr;

    return null;
}

function validateProviderHelp(input: unknown): string | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'deployment.provider_help must be an object if provided';
    }
    const h = input as Record<string, unknown>;
    for (const field of PROVIDER_HELP_URL_FIELDS) {
        const urlErr = validateOptionalHttpsUrl(h[field], `deployment.provider_help.${field}`);
        if (urlErr !== null) return urlErr;
    }
    if (h['token_scope'] !== undefined && typeof h['token_scope'] !== 'string') {
        return 'deployment.provider_help.token_scope must be a string if provided';
    }
    return null;
}

function validateEnvList(input: unknown, fieldName: 'required_env' | 'optional_env'): string | null {
    if (input === undefined) return null;
    if (!Array.isArray(input)) {
        return `deployment.${fieldName} must be an array if provided`;
    }
    const seenKeys = new Set<string>();
    for (let i = 0; i < input.length; i++) {
        const entryErr = validateEnvEntry(input[i], `deployment.${fieldName}[${i}]`, seenKeys);
        if (entryErr !== null) return entryErr;
    }
    return null;
}

function validateEnvEntry(input: unknown, prefix: string, seenKeys: Set<string>): string | null {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return `${prefix} must be an object`;
    }
    const e = input as Record<string, unknown>;

    const key = e['key'];
    if (typeof key !== 'string' || key.length === 0) {
        return `${prefix}.key must be a non-empty string`;
    }
    if (!ENV_VAR_KEY_PATTERN.test(key)) {
        return `${prefix}.key "${key}" must be UPPER_SNAKE_CASE (start with letter; letters/digits/underscores only)`;
    }
    if (seenKeys.has(key)) {
        return `${prefix}.key "${key}" is duplicated within the same env list`;
    }
    seenKeys.add(key);

    const label = e['label'];
    if (typeof label !== 'string' || label.length === 0) {
        return `${prefix}.label must be a non-empty string`;
    }

    for (const field of ['help', 'format_hint'] as const) {
        if (e[field] !== undefined && typeof e[field] !== 'string') {
            return `${prefix}.${field} must be a string if provided`;
        }
    }

    if (e['secret'] !== undefined && typeof e['secret'] !== 'boolean') {
        return `${prefix}.secret must be a boolean if provided`;
    }

    for (const field of ENV_VAR_URL_FIELDS) {
        const urlErr = validateOptionalHttpsUrl(e[field], `${prefix}.${field}`);
        if (urlErr !== null) return urlErr;
    }

    if (e['format_regex'] !== undefined) {
        if (typeof e['format_regex'] !== 'string') {
            return `${prefix}.format_regex must be a string if provided`;
        }
        try {
            // Smoke-compile so bad regex fails at load time, not in the renderer.
            new RegExp(e['format_regex']);
        } catch (err) {
            return `${prefix}.format_regex is not a valid regular expression: ${getErrorMessage(err)}`;
        }
    }

    return null;
}

function validateOptionalHttpsUrl(input: unknown, fieldPath: string): string | null {
    if (input === undefined) return null;
    if (typeof input !== 'string' || input.length === 0) {
        return `${fieldPath} must be a non-empty string if provided`;
    }
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        return `${fieldPath} is not a valid URL: ${JSON.stringify(input)}`;
    }
    if (parsed.protocol !== 'https:') {
        return `${fieldPath} must use https:// (got ${parsed.protocol}) — vendor docs always live behind https`;
    }
    return null;
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
