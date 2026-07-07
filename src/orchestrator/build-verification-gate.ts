/**
 * KageOps Build Verification Gate
 *
 * Runs npm install, build, and test in a project repo after the
 * development phase completes. Fails the gate if any step fails,
 * preventing transition to launch-growth.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from './event-bus';
import { streamSubprocessOutput } from './subprocess-stream';
import { createLogger } from '../shared/logger';
import { query } from '../db/client';
import { detectRouteCollisionsInRepo, formatCollisionWarning } from './route-collision-check';
import { scanRepoForModuleLoadInit, formatModuleLoadInitWarning } from './module-load-init-check';
import { autofixRepoModuleLoadInit } from './module-load-init-autofix';
import { autofixRepoDuplicateImports } from './duplicate-import-fix';
import { autofixRepoRouteCollisions } from './route-collision-fix';
import { resolveDualAppDir } from './dual-app-dir-fix';
import { validateMigrations, formatMigrationWarning } from './migration-validation-check';
import { gateMode, GATE_ENV } from './gate-modes';

const log = createLogger('BuildGate');

// BPF-11b: how many times to strip E404 packages and retry `npm install`. npm
// aborts on the first unresolvable package, so a handful of cycles peels off a
// short tail of hallucinated/phantom deps without looping unbounded.
const MAX_E404_RETRIES = 4;

// ── Types ────────────────────────────────────────────

/**
 * Build-verification step kinds. `install`/`build`/`test` are real npm steps.
 * `e2e` runs the generated Playwright suite (PR-2, opt-in). `static-check` is
 * the synthetic deploy-readiness step — the G5/G6 source scans surfaced as a
 * single blocking failure so they flow through the existing build-fix loop.
 */
export type BuildStepName = 'install' | 'build' | 'test' | 'e2e' | 'static-check';

export interface BuildStepResult {
    readonly step: BuildStepName;
    readonly passed: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
}

export interface BuildVerificationResult {
    readonly projectId: string;
    readonly passed: boolean;
    readonly steps: readonly BuildStepResult[];
    readonly failedStep: BuildStepName | null;
}

// ── Constants ───────────────────────────────────────

const STEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const DANGEROUS_ENV_VARS: readonly string[] = [
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
] as const;

// ── Helpers ─────────────────────────────────────────

/**
 * BPF-27 auto-fix dial. ON by default; opt out with a falsey
 * KAGEOPS_AUTOFIX_MODULE_INIT (0/false/off/no). Independent of the gate MODE so
 * an operator can keep the check blocking while disabling the auto-rewrite.
 */
function moduleInitAutofixEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env.KAGEOPS_AUTOFIX_MODULE_INIT ?? '').trim().toLowerCase();
    return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

/** BPF-17 duplicate-import dedup dial. ON by default; opt out with a falsey
 * KAGEOPS_AUTOFIX_DUP_IMPORTS (0/false/off/no). */
function dupImportAutofixEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env.KAGEOPS_AUTOFIX_DUP_IMPORTS ?? '').trim().toLowerCase();
    return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

/** BPF-29 route-collision auto-resolve dial. ON by default; opt out with a
 * falsey KAGEOPS_AUTOFIX_ROUTE_COLLISION (0/false/off/no). */
function routeCollisionAutofixEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env.KAGEOPS_AUTOFIX_ROUTE_COLLISION ?? '').trim().toLowerCase();
    return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

/** BPF-34 dual-app-dir merge dial. ON by default; opt out with a falsey
 * KAGEOPS_AUTOFIX_DUAL_APP_DIR (0/false/off/no). */
function dualAppDirAutofixEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env.KAGEOPS_AUTOFIX_DUAL_APP_DIR ?? '').trim().toLowerCase();
    return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

function hasTypeScriptSources(repoPath: string): boolean {
    const srcDir = path.join(repoPath, 'src');
    if (!fs.existsSync(srcDir)) return false;
    try {
        const entries = fs.readdirSync(srcDir, { recursive: true }) as string[];
        return entries.some((e) => /\.tsx?$/.test(String(e)));
    } catch {
        return false;
    }
}

// ── Build Plan Resolution ───────────────────────────

type BuildStepDef = { readonly name: 'install' | 'build' | 'test'; readonly args: readonly string[] };

export interface BuildPlan {
    readonly skip: boolean;
    readonly reason: string;
    readonly steps: readonly BuildStepDef[];
}

/**
 * Inspect the project's package.json (if any) and decide which npm steps
 * to run. Skips verification entirely for static-only projects. Only runs
 * scripts that actually exist — a package.json without a 'build' script
 * shouldn't fail because 'npm run build' can't find the script.
 *
 * Exported for unit testing.
 */
export function resolveBuildPlan(repoPath: string): BuildPlan {
    const pkgPath = path.join(repoPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        return { skip: true, reason: 'no package.json — static-only project', steps: [] };
    }

    let pkg: { scripts?: Record<string, string> } = {};
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    } catch (err) {
        // Malformed package.json — don't block the gate; Vigil's review will flag it.
        return {
            skip: true,
            reason: `package.json unparseable: ${err instanceof Error ? err.message : String(err)}`,
            steps: [],
        };
    }

    const scripts = pkg.scripts ?? {};
    const rawBuild = typeof scripts['build'] === 'string' && scripts['build'].length > 0;
    const hasTest =
        typeof scripts['test'] === 'string' &&
        scripts['test'].length > 0 &&
        !/echo.+error.+no test specified/i.test(scripts['test']);

    // If build script is `tsc`, only include it when .ts source files exist.
    // The default scaffold template always sets `build: "tsc"` even for static
    // sites — running tsc with zero inputs is a guaranteed failure.
    const hasBuild = rawBuild && !(
        /^\s*tsc\b/.test(scripts['build']) &&
        !hasTypeScriptSources(repoPath)
    );

    if (!hasBuild && !hasTest) {
        return {
            skip: true,
            reason: 'package.json has no actionable build or test scripts — nothing to verify',
            steps: [],
        };
    }

    // KO-SEC-004/019: --ignore-scripts stops an AI-generated package.json
    // from running arbitrary lifecycle scripts (preinstall/postinstall etc.)
    // unsandboxed on the host during install.
    const steps: BuildStepDef[] = [{ name: 'install', args: ['install', '--ignore-scripts'] }];
    if (hasBuild) steps.push({ name: 'build', args: ['run', 'build'] });
    if (hasTest) steps.push({ name: 'test', args: ['test'] });

    return { skip: false, reason: 'package.json with build/test scripts', steps };
}

/**
 * Resolve the package.json script that runs the e2e suite, preferring the
 * conventional names. Returns null when none exist (so the e2e step is a no-op
 * for apps without one). Exported for unit testing.
 */
export function resolveE2eScript(repoPath: string): string | null {
    const pkgPath = path.join(repoPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    let scripts: Record<string, string> = {};
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        scripts = pkg.scripts ?? {};
    } catch {
        return null;
    }
    for (const name of ['test:e2e', 'e2e', 'test:playwright', 'playwright']) {
        if (typeof scripts[name] === 'string' && scripts[name].length > 0) return name;
    }
    return null;
}

// ── BPF-11b — install-resilience (E404 recovery) ─────

/**
 * Parse the npm `E404` package names out of a failed `npm install` stderr.
 * npm reports unresolvable packages two ways; we capture both and de-dupe:
 *   - `GET https://registry.npmjs.org/@neondatabase%2fneon - Not found`
 *   - `The requested resource '@neondatabase/neon@*' could not be found`
 */
export function parseUnresolvablePackages(stderr: string): readonly string[] {
    if (!/E404|404 Not Found|could not be found/i.test(stderr)) return [];
    const names = new Set<string>();
    const urlRe = /registry\.npmjs\.org\/(\S+?)\s+-\s+Not found/gi;
    const resourceRe = /requested resource '([^']+?)@[^']*' could not be found/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(stderr)) !== null) {
        names.add(decodeURIComponent(m[1]));
    }
    while ((m = resourceRe.exec(stderr)) !== null) {
        names.add(m[1]);
    }
    return [...names];
}

/**
 * BPF-11b: remove the given (unresolvable, E404) package names from every
 * dependency field of the workspace package.json and rewrite it. Returns the
 * names actually removed. Pure filesystem op — no install side effects.
 */
export function pruneUnresolvablePackages(repoPath: string, stderr: string): readonly string[] {
    const names = parseUnresolvablePackages(stderr);
    if (names.length === 0) return [];

    const pkgPath = path.join(repoPath, 'package.json');
    let pkg: Record<string, unknown>;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return [];
    }

    const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const removed: string[] = [];
    for (const field of fields) {
        const deps = pkg[field];
        if (deps === null || typeof deps !== 'object') continue;
        const map = deps as Record<string, string>;
        for (const name of names) {
            if (name in map) {
                delete map[name];
                if (!removed.includes(name)) removed.push(name);
            }
        }
    }
    if (removed.length === 0) return [];

    try {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    } catch {
        return [];
    }
    return removed;
}

// ── Build Verification Gate ─────────────────────────

export class BuildVerificationGate {
    private readonly eventBus: EventBus;

    constructor(eventBus: EventBus) {
        this.eventBus = eventBus;
    }

    async verify(projectId: string, repoPath: string): Promise<BuildVerificationResult> {
        log.info({ projectId, repoPath }, 'Starting build verification');

        const startedAt = new Date();

        // Pillar 2.2 / PR-D — materialise .env.local from the encrypted
        // deployment_config column BEFORE npm install / build / test
        // see the workspace. Idempotent across iterations; safe to call
        // even when the operator picked "Skip for now" (returns 'skipped').
        try {
            const { materializeDeploymentEnv } = await import('./materialize-deployment-env');
            const matResult = await materializeDeploymentEnv(projectId, repoPath);
            log.info(
                { projectId, status: matResult.status, varCount: matResult.varCount },
                `.env.local: ${matResult.reason}`
            );
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'env materialisation threw — continuing build (may fail if vars are required)'
            );
        }

        // BPF-31 — fill build-required keys the operator didn't supply with the
        // bundle's well-formed PLACEHOLDERS so a credential-free `next build`
        // can PRERENDER (e.g. Clerk's <ClerkProvider> throws "Missing
        // publishableKey" during static export without a syntactically-valid
        // key). Real deployment_config values always win (only missing keys are
        // added); build-only, never a real deploy.
        try {
            const placeholders = await this.resolveBuildEnvPlaceholders(projectId);
            if (Object.keys(placeholders).length > 0) {
                const { ensureBuildEnvPlaceholders } = await import('./build-env-placeholders');
                const added = await ensureBuildEnvPlaceholders(repoPath, placeholders, fs);
                if (added.length > 0) {
                    log.info(
                        { projectId, added },
                        'BPF-31: injected build-only placeholder env for credential-free build',
                    );
                }
            }
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'BPF-31 placeholder injection threw — continuing build',
            );
        }

        // BPF-9b: sanitize the workspace package.json BEFORE npm install. Weak
        // (OSS/budget) models add TypeScript path aliases (`@/components`) as
        // dependencies; `npm install` then fails with EINVALIDPACKAGENAME and
        // blocks the whole gate. The on-write guard (BPF-9) only fires when an
        // agent rewrites the file, so a stale/leftover bad manifest slips
        // through — re-sanitize here so the build can install regardless of how
        // the manifest got onto disk.
        try {
            const pkgPath = path.join(repoPath, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const { sanitizePackageJson } = await import('../agents/output-parser');
                const raw = fs.readFileSync(pkgPath, 'utf8');
                const cleaned = sanitizePackageJson(raw);
                if (cleaned !== raw) {
                    fs.writeFileSync(pkgPath, cleaned, 'utf8');
                    log.warn(
                        { projectId },
                        'BPF-9b: stripped invalid dependency names from package.json before install',
                    );
                }
            }
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'BPF-9b package.json sanitize threw — continuing build',
            );
        }

        // 2026-06 App Router collision guard. A live Next.js project shipped
        // BOTH a root `app/` and a `src/app/` tree (the stray one shadowed
        // the real one) plus a duplicate `/login` route — every page 500'd.
        // Surface a blocking warning here before the build runs so the
        // operator (and the failed-build log) names the root cause; the
        // `next build` step below is what actually fails the gate.
        try {
            const collisions = detectRouteCollisionsInRepo(repoPath, fs);
            const warning = formatCollisionWarning(collisions);
            if (warning !== null) {
                log.warn({ projectId, ...collisions }, `App Router collision detected:\n${warning}`);
                await this.eventBus.publish('build.verification.warning', {
                    projectId,
                    agent: 'system',
                    data: { kind: 'route-collision', warning, collisions },
                });
            }
        } catch (err) {
            log.warn(
                { projectId, err: err instanceof Error ? err.message : String(err) },
                'route-collision check threw — continuing build',
            );
        }

        // G5 + G6 deploy-readiness (PR-2 "verification teeth"). These were the
        // two MCC-class defects a passing local build hid:
        //   G5 — `new Stripe(process.env.X!)` / a Drizzle client constructed at
        //        module top level. `next build` evaluates module top-level code
        //        with NO secrets present, so it crashes on a secret-less host
        //        (Vercel) even though the app runs fine locally with .env.local.
        //   G6 — generated SQL migrations that "parse" but fail a FRESH apply
        //        (undeclared enum) or seed a password column under delegated
        //        auth (Clerk/Supabase).
        // Both now BLOCK by default — the local build below runs WITH
        // materialised secrets, so it would pass and ship the latent crash. Each
        // is dial-able to `warn` (the pre-PR-2 behaviour) or `off` via its
        // KAGEOPS_GATE_* env var. When a block-mode check fires, we short-circuit
        // to a `static-check` failure so Sensei's existing build-fix loop spawns
        // a Forge remediation task.
        // BPF-34 — consolidate a dual App Router dir before anything else. When
        // both `app/` and `src/app/` exist, Next renders root `app/` and ignores
        // `src/app/`; an OSS model that wrote the real page to `src/app/page.tsx`
        // ships the stock `app/page.tsx`. Merge the shadowed `src/app/` into the
        // active `app/` so the real page renders (then BPF-29/17 + acceptance see
        // the consolidated tree). Opt out with KAGEOPS_AUTOFIX_DUAL_APP_DIR=0.
        if (dualAppDirAutofixEnabled()) {
            try {
                const res = resolveDualAppDir(repoPath, fs);
                if (res.merged) {
                    log.info(
                        { projectId, movedFiles: res.movedFiles },
                        'BPF-34: merged shadowed src/app into the active app/ dir',
                    );
                }
            } catch (err) {
                log.warn(
                    { projectId, err: err instanceof Error ? err.message : String(err) },
                    'dual-app-dir resolve threw — continuing build',
                );
            }
        }

        // BPF-29 — resolve plain-vs-optional-catch-all route collisions before
        // the build. The scaffold ships Clerk catch-all sign-in/sign-up pages;
        // an OSS model also emits a plain `app/sign-in/page.tsx` (re-implementing
        // a shipped feature) → `next build` aborts ("same specificity as an
        // optional catch-all"). The catch-all already serves the path, so delete
        // the redundant plain page. Opt out with KAGEOPS_AUTOFIX_ROUTE_COLLISION=0.
        if (routeCollisionAutofixEnabled()) {
            try {
                const fix = autofixRepoRouteCollisions(repoPath, fs);
                if (fix.resolved.length > 0) {
                    log.info(
                        { projectId, resolved: fix.resolved },
                        'BPF-29: removed redundant plain page(s) colliding with a catch-all route',
                    );
                }
            } catch (err) {
                log.warn(
                    { projectId, err: err instanceof Error ? err.message : String(err) },
                    'route-collision autofix threw — continuing build',
                );
            }
        }

        // BPF-17 — dedupe duplicate imports before the build. OSS models emit a
        // file as concatenated blocks, re-importing per block (`import { eq }
        // from 'drizzle-orm';` ×5 in the ClubHubOSS webhook) → TS "Duplicate
        // identifier" → next build fails, and the OSS build-fix loop can't
        // reliably clean it. Absorb it deterministically (same thesis as
        // BPF-26/27). Opt out with KAGEOPS_AUTOFIX_DUP_IMPORTS=0.
        if (dupImportAutofixEnabled()) {
            try {
                const fix = autofixRepoDuplicateImports(repoPath, fs);
                if (fix.filesFixed.length > 0) {
                    log.info(
                        { projectId, filesFixed: fix.filesFixed },
                        'BPF-17: deduped duplicate imports before build',
                    );
                }
            } catch (err) {
                log.warn(
                    { projectId, err: err instanceof Error ? err.message : String(err) },
                    'duplicate-import dedup threw — continuing build',
                );
            }
        }

        const blockingStatic = await this.evaluateStaticReadiness(projectId, repoPath);
        if (blockingStatic.length > 0) {
            return this.failStaticReadiness(projectId, startedAt, blockingStatic);
        }

        // Static-site fast path: no package.json means no npm-based build.
        // Static HTML/CSS/JS projects must be allowed to advance past
        // development without running npm install/build/test.
        const plan = resolveBuildPlan(repoPath);
        if (plan.skip) {
            log.info({ projectId, reason: plan.reason }, 'Build verification skipped');
            const passResult: BuildVerificationResult = {
                projectId,
                passed: true,
                steps: [],
                failedStep: null,
            };
            await this.eventBus.publish('build.verification.passed', {
                projectId,
                agent: 'system',
                data: { steps: [], skipped: true, reason: plan.reason },
            });
            await persistBuildStatus(projectId, 'skipped', startedAt, plan.reason);
            return passResult;
        }

        const completedSteps: BuildStepResult[] = [];

        for (const step of plan.steps) {
            log.info({ projectId, step: step.name }, 'Running step');

            let result = await this.runStep(step.name, step.args, repoPath, projectId);

            // BPF-11b: weak (OSS/budget) models import well-formed but nonexistent
            // packages (e.g. `@neondatabase/neon` instead of `…/serverless`), or
            // DependencyManager leaves a phantom dep behind after the import is
            // rewritten. Either way `npm install` dies with E404 and the gate can
            // never advance — Forge can't fix it because the bad name isn't in any
            // source file. npm aborts on the FIRST unresolvable package, so peel
            // them off one batch at a time: strip the E404 names from package.json
            // and retry, up to a bounded number of cycles. Deterministic.
            if (step.name === 'install') {
                for (let attempt = 0; attempt < MAX_E404_RETRIES && !result.passed; attempt++) {
                    const removed = pruneUnresolvablePackages(repoPath, result.stderr);
                    if (removed.length === 0) break;
                    log.warn(
                        { projectId, removed, attempt: attempt + 1 },
                        'BPF-11b: removed unresolvable (E404) packages from package.json — retrying install',
                    );
                    result = await this.runStep(step.name, step.args, repoPath, projectId);
                }
            }

            completedSteps.push(result);

            if (!result.passed) {
                log.error(
                    { projectId, step: step.name, durationMs: result.durationMs },
                    'Step failed — aborting remaining steps'
                );
                return this.emitStepFailure(projectId, startedAt, completedSteps, step.name, result);
            }

            log.info({ projectId, step: step.name, durationMs: result.durationMs }, 'Step passed');
        }

        // Generated Playwright e2e (PR-2). Opt-in: KAGEOPS_GATE_E2E defaults to
        // `off` because Playwright needs browser binaries + a running server +
        // real secrets, which most build hosts lack — making it default-on would
        // false-fail. When enabled and the app ships an e2e script, run it as a
        // final step: `block` fails the gate (→ build-fix loop), `warn` logs.
        const e2eFailure = await this.maybeRunE2e(projectId, repoPath, startedAt, completedSteps);
        if (e2eFailure !== null) return e2eFailure;

        const passResult: BuildVerificationResult = {
            projectId,
            passed: true,
            steps: completedSteps,
            failedStep: null,
        };

        await this.eventBus.publish('build.verification.passed', {
            projectId,
            agent: 'system',
            data: { steps: completedSteps },
        });

        await persistBuildStatus(
            projectId,
            'passed',
            startedAt,
            `${completedSteps.map((s) => s.step).join(' → ')} ok`,
        );

        log.info({ projectId }, 'Build verification passed');
        return passResult;
    }

    // ── Private ──────────────────────────────────────

    /**
     * Emit a single build-step failure: failed event + persisted status, and
     * return the BuildVerificationResult. Shared by the npm-step loop and the
     * e2e step so both surface identically to Sensei's build-fix loop.
     */
    private async emitStepFailure(
        projectId: string,
        startedAt: Date,
        completedSteps: readonly BuildStepResult[],
        failedStep: BuildStepName,
        result: BuildStepResult,
    ): Promise<BuildVerificationResult> {
        const failResult: BuildVerificationResult = {
            projectId,
            passed: false,
            steps: completedSteps,
            failedStep,
        };
        await this.eventBus.publish('build.verification.failed', {
            projectId,
            agent: 'system',
            data: { failedStep, stderr: result.stderr, steps: completedSteps },
        });
        await persistBuildStatus(
            projectId,
            'failed',
            startedAt,
            `${failedStep}: ${truncateLogSummary(result.stderr || result.stdout)}`,
        );
        return failResult;
    }

    /**
     * BPF-31 — the build-only placeholder env declared by the project's selected
     * bundle (`build_env_placeholders`). Empty when there's no bundle / none
     * declared. Never throws.
     */
    private async resolveBuildEnvPlaceholders(projectId: string): Promise<Readonly<Record<string, string>>> {
        try {
            const row = await query<{ selected_bundle: string | null }>(
                'SELECT selected_bundle FROM projects WHERE id = $1',
                [projectId],
            );
            const key = row.rows[0]?.selected_bundle ?? null;
            if (key === null || key.trim().length === 0) return {};
            const { loadBundles } = await import('../bundles/bundle-loader');
            const { BundleRegistry } = await import('../bundles/bundle-registry');
            const registry = new BundleRegistry(await loadBundles());
            if (registry.size() === 0) return {};
            const full = key.includes('::') ? key : `stack::${key}`;
            const [kindStr, name] = full.split('::');
            const bundle = registry.get(kindStr as 'stack' | 'capability' | 'deployer', name);
            return bundle?.manifest.build_env_placeholders ?? {};
        } catch {
            return {};
        }
    }

    /**
     * Run the G5 (module-load init) + G6 (migration) deploy-readiness scans,
     * each gated by its KAGEOPS_GATE_* mode. Returns the warning text of every
     * BLOCK-mode check that fired (empty ⇒ nothing blocks). WARN-mode findings
     * are published as non-blocking warnings as a side effect; `off` skips the
     * check entirely. Never throws — a scan failure must not block the gate.
     */
    private async evaluateStaticReadiness(projectId: string, repoPath: string): Promise<readonly string[]> {
        const blocking: string[] = [];

        const moduleMode = gateMode(GATE_ENV.moduleInit);
        if (moduleMode !== 'off') {
            try {
                // BPF-27 — deterministically DEFER eager module-load initializers
                // before judging them. The OSS build-fix loop routinely can't
                // apply this fix even though the error text spells it out, so the
                // harness absorbs it (mirrors the BPF-26 migration baseline). The
                // rewrite is the scaffold's proven lazy-Proxy shape and is only
                // kept when it strictly reduces findings. Only in `block` mode —
                // `warn` is advisory ("tell me, don't touch my files"). Opt out
                // entirely with KAGEOPS_AUTOFIX_MODULE_INIT=0.
                if (moduleMode === 'block' && moduleInitAutofixEnabled()) {
                    try {
                        const fix = autofixRepoModuleLoadInit(repoPath, fs);
                        if (fix.filesFixed.length > 0) {
                            log.info(
                                { projectId, filesFixed: fix.filesFixed, remaining: fix.remaining.length },
                                'BPF-27: deferred eager module-load initializer(s) to lazy access',
                            );
                        }
                    } catch (err) {
                        log.warn(
                            { projectId, err: err instanceof Error ? err.message : String(err) },
                            'module-load-init autofix threw — falling through to scan',
                        );
                    }
                }

                const findings = scanRepoForModuleLoadInit(repoPath, fs);
                const warning = formatModuleLoadInitWarning(findings);
                if (warning !== null) {
                    if (moduleMode === 'block') {
                        blocking.push(warning);
                    } else {
                        await this.publishWarning(projectId, 'module-load-init', warning, { findings });
                    }
                }
            } catch (err) {
                log.warn(
                    { projectId, err: err instanceof Error ? err.message : String(err) },
                    'module-load-init check threw — continuing build',
                );
            }
        }

        const migrationMode = gateMode(GATE_ENV.migration);
        if (migrationMode !== 'off') {
            try {
                const result = await validateMigrations(repoPath, fs);
                const warning = formatMigrationWarning(result);
                if (warning !== null) {
                    if (migrationMode === 'block') {
                        blocking.push(warning);
                    } else {
                        await this.publishWarning(projectId, 'migration-validation', warning, { ...result });
                    }
                }
            } catch (err) {
                log.warn(
                    { projectId, err: err instanceof Error ? err.message : String(err) },
                    'migration-validation check threw — continuing build',
                );
            }
        }

        return blocking;
    }

    /** Short-circuit the gate with a synthetic `static-check` failure. */
    private async failStaticReadiness(
        projectId: string,
        startedAt: Date,
        warnings: readonly string[],
    ): Promise<BuildVerificationResult> {
        const stderr = warnings.join('\n\n');
        const step: BuildStepResult = {
            step: 'static-check',
            passed: false,
            stdout: '',
            stderr,
            durationMs: 0,
        };
        log.warn({ projectId, checks: warnings.length }, 'Build verification failed at static deploy-readiness checks');
        return this.emitStepFailure(projectId, startedAt, [step], 'static-check', step);
    }

    /** Publish a non-blocking build warning (route-collision / warn-mode checks). */
    private async publishWarning(
        projectId: string,
        kind: string,
        warning: string,
        extra: Record<string, unknown>,
    ): Promise<void> {
        log.warn({ projectId, ...extra }, `${kind}:\n${warning}`);
        await this.eventBus.publish('build.verification.warning', {
            projectId,
            agent: 'system',
            data: { kind, warning, ...extra },
        });
    }

    /**
     * Run the generated Playwright e2e suite when KAGEOPS_GATE_E2E is enabled
     * and the app ships an e2e script. Pushes the step result onto
     * `completedSteps`. Returns a failed BuildVerificationResult when the suite
     * fails in BLOCK mode, otherwise null (passed, warn-logged, or not run).
     */
    private async maybeRunE2e(
        projectId: string,
        repoPath: string,
        startedAt: Date,
        completedSteps: BuildStepResult[],
    ): Promise<BuildVerificationResult | null> {
        const mode = gateMode(GATE_ENV.e2e, 'off');
        if (mode === 'off') return null;

        const e2eScript = resolveE2eScript(repoPath);
        if (e2eScript === null) {
            log.info({ projectId }, 'e2e gate enabled but no e2e script found — skipping');
            return null;
        }

        log.info({ projectId, e2eScript, mode }, 'Running e2e step');
        const result = await this.runStep('e2e', ['run', e2eScript], repoPath, projectId);
        completedSteps.push(result);

        if (result.passed) {
            log.info({ projectId, durationMs: result.durationMs }, 'e2e step passed');
            return null;
        }

        if (mode === 'warn') {
            await this.publishWarning(projectId, 'e2e', result.stderr || result.stdout, {});
            return null;
        }

        log.error({ projectId, durationMs: result.durationMs }, 'e2e step failed (blocking)');
        return this.emitStepFailure(projectId, startedAt, completedSteps, 'e2e', result);
    }

    private runStep(
        name: BuildStepName,
        args: readonly string[],
        cwd: string,
        projectId: string,
    ): Promise<BuildStepResult> {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            const sanitizedEnv = this.buildSanitizedEnv();

            // Windows resolves `npm` to `npm.cmd`, which child_process.spawn
            // cannot launch directly without `shell: true`. Args are a closed
            // set of static enum values defined in this module, so shell
            // interpolation is safe here.
            const useShell = process.platform === 'win32';
            const command = useShell ? 'npm.cmd' : 'npm';
            const child = spawn(command, [...args], {
                cwd,
                shell: useShell,
                env: sanitizedEnv,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            // Tail stdout/stderr to the Agent Terminal panel via the bus.
            // Always disposed on close — never leaks listeners.
            const stopStream = streamSubprocessOutput(child, this.eventBus, {
                projectId,
                source: 'build-verification',
                agent: 'system',
            });

            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                stderrChunks.push(`Timeout: step "${name}" exceeded ${STEP_TIMEOUT_MS}ms`);
            }, STEP_TIMEOUT_MS);

            child.stdout.on('data', (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
            });

            child.stderr.on('data', (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                stopStream();
                resolve({
                    step: name,
                    passed: code === 0,
                    stdout: stdoutChunks.join(''),
                    stderr: stderrChunks.join(''),
                    durationMs: Date.now() - startTime,
                });
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                stopStream();
                resolve({
                    step: name,
                    passed: false,
                    stdout: stdoutChunks.join(''),
                    stderr: err instanceof Error ? err.message : String(err),
                    durationMs: Date.now() - startTime,
                });
            });
        });
    }

    private buildSanitizedEnv(): Record<string, string> {
        const env: Record<string, string> = {};

        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && !DANGEROUS_ENV_VARS.includes(key)) {
                env[key] = value;
            }
        }

        return env;
    }
}

// ── Persistence ──────────────────────────────────────────
//
// The Build Status panel in Mission Control reads from this table.
// Without these inserts the panel is permanently empty even when
// builds run successfully.

async function persistBuildStatus(
    projectId: string,
    status: 'passed' | 'failed' | 'skipped',
    startedAt: Date,
    logSummary: string,
): Promise<void> {
    try {
        await query(
            `INSERT INTO build_status (project_id, pipeline, status, log_summary, started_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [projectId, 'build-verification', status, logSummary, startedAt],
        );
    } catch (err) {
        // Never let persistence failures block the gate result.
        log.warn(
            { err: err instanceof Error ? err.message : String(err), projectId },
            'Failed to persist build_status row',
        );
    }
}

function truncateLogSummary(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= 800) return trimmed;
    return trimmed.slice(0, 797) + '…';
}
