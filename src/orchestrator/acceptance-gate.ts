/**
 * KageOps Acceptance Gate
 *
 * Runs after development phase tasks complete + BuildVerificationGate passes.
 * Verifies the produced artifact actually matches the spec the user wrote
 * — not just "the pipeline ran without crashing".
 *
 * V1 scope (2026-04-16):
 *   1. Parse the project.description into structured SpecRules via
 *      `parseSpec()` (see spec-rule-engine.ts). Rule kinds: id-exists,
 *      tag-exists, class-exists, text-contains, attribute-exists.
 *   2. Optionally merge rules from `.kageops/test-cases.json` in the repo —
 *      this is the Scout/human extension point for structured assertions.
 *   3. Read the produced `index.html`.
 *   4. Check every rule against the artifact; report violations.
 *
 * Future (V2): functional smoke via a DOM engine (click #inc, assert
 * #count text changes). The rule grammar is already prepared for that.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from './event-bus';
import { createLogger } from '../shared/logger';
import {
    checkAllRules,
    loadTestCasesJson,
    parseSpec,
    ruleSeverity,
    type SpecRule,
} from './spec-rule-engine';
import { runStaticAssetChecks } from './static-asset-checks';
import { runCssCompletenessCheck } from './css-completeness-check';
import { runRuntimeSmoke } from './runtime-smoke-check';
import { scanRepoForOrphanedHalves, scanRepoForMissingRequiredInitiator } from './vertical-slice-check';
import { scanRepoForPaymentIntegrity } from './payment-integrity-check';
import { scanRepoForFabrication } from './fabrication-audit-check';
import { gateMode, GATE_ENV } from './gate-modes';
import { checkHtmlIdsInSource } from './html-id-source-check';
import { isHostingDisabled } from '../shared/hosting-mode';

const log = createLogger('AcceptanceGate');

// ── Types ────────────────────────────────────────────

export type AcceptanceCheck =
    | 'missing-id'
    | 'missing-tag'
    | 'missing-class'
    | 'missing-text'
    | 'missing-attribute'
    | 'missing-artifact'
    | 'unparseable-spec'
    | 'invalid-test-cases'
    | 'missing-asset'
    | 'markdown-fenced-asset'
    | 'unbalanced-css-braces'
    | 'orphan-css-classes'
    | 'runtime-error'
    | 'console-error'
    | 'unhandled-rejection'
    // G3 (functional-completeness): a feature wired on only one end
    // (e.g. a Stripe webhook receiver with no checkout-session initiator).
    | 'orphaned-half-feature'
    // PR-2 (required-initiator): the brief implies the app must take payment
    // but no checkout/subscription initiator exists in the source.
    | 'missing-required-initiator'
    // PR-3 (payment-integrity): payments are wired but incorrectly — webhook
    // not signature-verified, hardcoded price, or activation not user-keyed.
    | 'webhook-no-signature-verify'
    | 'hardcoded-price'
    | 'activation-not-keyed-to-user'
    // PR-5 (fabrication audit): placeholder/fabricated values in shipped UI.
    | 'lorem-ipsum'
    | 'placeholder-contact'
    | 'unfilled-placeholder'
    | 'unreplaced-template'
    // P2-05 (AcceptanceGate v2): new checks for build-tests-preview kind.
    | 'preview-url-missing'
    | 'preview-url-not-200'
    | 'preview-url-unreachable';

export interface AcceptanceViolation {
    readonly check: AcceptanceCheck;
    readonly expected: string;
    readonly message: string;
    /**
     * Two-tier severity. 'must' violations block the gate and trigger
     * Forge remediation. 'should' violations log a warning but advance
     * the phase. Static-asset / runtime-smoke checks are always 'must'
     * because they catch broken artifacts. Rule-derived checks inherit
     * severity from the source SpecRule (default 'must').
     */
    readonly severity: 'must' | 'should';
}

export interface AcceptanceResult {
    readonly projectId: string;
    readonly passed: boolean;
    readonly skipped: boolean;
    readonly reason: string;
    readonly requiredIds: readonly string[];
    readonly ruleCount: number;
    readonly rules: readonly SpecRule[];
    readonly violations: readonly AcceptanceViolation[];
}

// ── Backwards-compat exports (preserve v2.2 public API) ─

/**
 * Pull required HTML element IDs out of a free-text spec.
 *
 * Kept for backwards compatibility with existing callers / tests.
 * Prefer `parseSpec` from spec-rule-engine.ts for new code.
 */
export function extractRequiredIds(description: string): readonly string[] {
    return parseSpec(description)
        .filter((r): r is { kind: 'id-exists'; id: string } => r.kind === 'id-exists')
        .map((r) => r.id);
}

/**
 * Pull `id="..."` values out of an HTML document.
 *
 * Exported for unit testing.
 */
export function extractHtmlIds(html: string): readonly string[] {
    const ids = new Set<string>();
    const pattern = /\sid\s*=\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
        ids.add(match[1]);
    }
    return [...ids];
}

// ── Acceptance Gate ─────────────────────────────────

const TEST_CASES_PATH = path.join('.kageops', 'test-cases.json');

export class AcceptanceGate {
    private readonly eventBus: EventBus;

    constructor(eventBus: EventBus) {
        this.eventBus = eventBus;
    }

    /**
     * P2-05: optional bundle-driven dispatch hint. When supplied with
     * `kind === 'build-tests-preview'`, verify() routes through
     * `verifyBuildTestsPreview` instead of the HTML-ID flow. The previewUrl
     * + previewRoutes come from the caller (PhaseGateManager) which has
     * already done the bundle lookup.
     */
    async verify(
        projectId: string,
        repoPath: string,
        description: string,
        bundleHint?: {
            readonly kind: 'html-ids' | 'build-tests-preview';
            readonly previewUrl?: string;
            readonly previewRoutes?: readonly string[];
        }
    ): Promise<AcceptanceResult> {
        // P2-05: bundle-driven acceptance dispatch.
        if (bundleHint?.kind === 'build-tests-preview') {
            return this.verifyBuildTestsPreview(
                projectId,
                repoPath,
                bundleHint.previewUrl,
                bundleHint.previewRoutes ?? [],
                description
            );
        }

        log.info({ projectId, repoPath }, 'Starting acceptance verification');

        // 1. Gather rules — description-derived + optional Scout test-cases.json
        const descriptionRules = parseSpec(description);

        const testCasesLoad = this.loadOptionalTestCases(repoPath);
        if (testCasesLoad.error !== null) {
            const violation: AcceptanceViolation = {
                check: 'invalid-test-cases',
                expected: TEST_CASES_PATH,
                message: `Failed to parse ${TEST_CASES_PATH}: ${testCasesLoad.error}`,
                severity: 'must',
            };
            const result = this.buildResult({
                projectId,
                passed: false,
                skipped: false,
                reason: 'test-cases.json unparseable',
                rules: descriptionRules,
                violations: [violation],
            });
            await this.publishFailed(projectId, result);
            return result;
        }

        const rules = dedupeRules([...descriptionRules, ...testCasesLoad.rules]);
        const requiredIds = rules
            .filter((r): r is { kind: 'id-exists'; id: string } => r.kind === 'id-exists')
            .map((r) => r.id);

        // 2. Nothing testable in the spec — still run static-asset
        // sanity if an index.html exists. A spec with no structured
        // rules (e.g. "make me a landing page") can still ship a site
        // with markdown-fenced CSS or a missing script.js, and letting
        // that through as passed+skipped is exactly the GreenThumb bug.
        if (rules.length === 0) {
            const indexPath = path.join(repoPath, 'index.html');
            const combined: AcceptanceViolation[] = [];

            if (fs.existsSync(indexPath)) {
                const html = fs.readFileSync(indexPath, 'utf-8');
                const staticViolations = runStaticAssetChecks(repoPath, html);
                for (const v of staticViolations) {
                    combined.push({ check: v.check, expected: v.expected, message: v.message, severity: 'must' });
                }
                const cssViolations = runCssCompletenessCheck(repoPath, html);
                for (const v of cssViolations) {
                    combined.push({ check: v.check, expected: v.expected, message: v.message, severity: 'must' });
                }
                if (staticViolations.length === 0 && cssViolations.length === 0) {
                    const runtimeViolations = await runRuntimeSmoke(repoPath);
                    for (const v of runtimeViolations) {
                        combined.push({ check: v.check, expected: v.expected, message: v.message, severity: 'must' });
                    }
                }
            }

            const allOk = combined.length === 0;
            const result = this.buildResult({
                projectId,
                passed: allOk,
                skipped: allOk,
                reason: allOk
                    ? 'no testable assertions in spec'
                    : `${combined.length} artifact violation${combined.length === 1 ? '' : 's'}`,
                rules: [],
                violations: combined,
            });
            if (allOk) await this.publishPassed(projectId, result);
            else await this.publishFailed(projectId, result);
            return result;
        }

        // 3. Artifact present?
        const indexPath = path.join(repoPath, 'index.html');
        if (!fs.existsSync(indexPath)) {
            const violation: AcceptanceViolation = {
                check: 'missing-artifact',
                expected: 'index.html',
                message: 'Spec has testable assertions but no index.html was produced',
                severity: 'must',
            };
            const result = this.buildResult({
                projectId,
                passed: false,
                skipped: false,
                reason: 'artifact missing',
                rules,
                violations: [violation],
            });
            await this.publishFailed(projectId, result);
            return result;
        }

        // 4. Check each rule. Each rule carries an effective severity
        //    ('must' default, 'should' opt-in) so we can split violations
        //    into blocking vs advisory.
        const html = fs.readFileSync(indexPath, 'utf-8');
        const checks = checkAllRules(rules, html);

        const violations: AcceptanceViolation[] = checks
            .filter((c) => !c.passed)
            .map((c) => ({
                check: mapCheckKind(c.rule.kind),
                expected: c.expected,
                message: c.message,
                severity: ruleSeverity(c.rule),
            }));

        // 5. Static-asset sanity — catches the GreenThumb-class failures
        // (markdown-fenced CSS, truncated CSS, missing script.js) that
        // the rule engine alone can't see because they live in linked
        // files, not in index.html itself. Always 'must': a broken asset
        // means a broken page, not polish.
        const assetViolations = runStaticAssetChecks(repoPath, html);
        for (const v of assetViolations) {
            violations.push({
                check: v.check,
                expected: v.expected,
                message: v.message,
                severity: 'must',
            });
        }

        // 5b. CSS completeness — every HTML class name must have a
        // matching CSS rule, otherwise the page renders as unstyled
        // markup even when the spec rules and static-asset checks
        // pass. Surfaced as the #1 cap on v8 benchmark scores.
        // Always 'must': an unstyled page is not a finished page.
        const cssCompletenessViolations = runCssCompletenessCheck(repoPath, html);
        for (const v of cssCompletenessViolations) {
            violations.push({
                check: v.check,
                expected: v.expected,
                message: v.message,
                severity: 'must',
            });
        }

        // 6. Runtime smoke — load index.html under jsdom and flag any
        // window.onerror / console.error / unhandledrejection. Only
        // bother if static and CSS-completeness checks passed; if
        // they already failed, the runtime load will just re-surface
        // the same noise. Always 'must' for the same reason as
        // static-asset checks.
        if (assetViolations.length === 0 && cssCompletenessViolations.length === 0) {
            const runtimeViolations = await runRuntimeSmoke(repoPath);
            for (const v of runtimeViolations) {
                violations.push({
                    check: v.check,
                    expected: v.expected,
                    message: v.message,
                    severity: 'must',
                });
            }
        }

        // 7. Fabrication audit (PR-5) — placeholder/fabricated values in the
        // shipped HTML (lorem, fake contacts, unfilled gaps). Severity follows
        // the KAGEOPS_GATE_FABRICATION mode.
        for (const v of this.runFabricationAudit(repoPath)) {
            violations.push(v);
        }

        // Pass iff no MUST violations remain. SHOULD violations are
        // advisory: they appear in the result for the operator to see,
        // but they do not block the phase or trigger remediation.
        const mustViolations = violations.filter((v) => v.severity === 'must');
        const shouldViolations = violations.filter((v) => v.severity === 'should');
        const passed = mustViolations.length === 0;

        const result = this.buildResult({
            projectId,
            passed,
            skipped: false,
            reason: passed
                ? shouldViolations.length === 0
                    ? `all ${rules.length} spec rule${rules.length === 1 ? '' : 's'} satisfied`
                    : `${mustViolations.length === 0 ? 'all MUST rules satisfied' : ''}; ${shouldViolations.length} SHOULD warning${shouldViolations.length === 1 ? '' : 's'}`
                : `${mustViolations.length}/${rules.length} MUST rule${mustViolations.length === 1 ? '' : 's'} failed`,
            rules,
            violations,
        });

        if (passed) {
            await this.publishPassed(projectId, result);
            if (shouldViolations.length > 0) {
                log.warn(
                    { projectId, shouldViolations },
                    'Acceptance passed with SHOULD-rule warnings (non-blocking)'
                );
            }
            log.info(
                { projectId, ruleCount: rules.length, requiredIds, shouldWarnings: shouldViolations.length },
                'Acceptance passed'
            );
        } else {
            await this.publishFailed(projectId, result);
            log.warn(
                { projectId, mustViolations, shouldViolations },
                'Acceptance failed'
            );
        }

        return result;
    }

    /**
     * P2-05 AcceptanceGate v2 — `build-tests-preview` flavour.
     *
     * Per D-14, the v2 gate is a three-signal check:
     *   1. Build verifier passed (already verified by BuildVerificationGate
     *      before this gate runs — PhaseGateManager.checkGate runs the build
     *      gate first and gates this one behind it). We do NOT re-run npm
     *      install/build/test here.
     *   2. Test suite passed (same — covered by the build verifier's `test`
     *      step in D-07 Tier 2).
     *   3. Preview URL `/` returns HTTP 200, AND every URL in
     *      `acceptance.preview_routes` returns 200.
     *
     * What's checked HERE is (3) only. (1) and (2) are gateStatus
     * preconditions enforced by the caller.
     *
     * The preview_url itself is populated by Aegis's deploy-preview task
     * (P2-04). If it's missing when this method is called, that's a
     * scheduling bug in Sensei — surface as missing rather than failing
     * silently.
     */
    async verifyBuildTestsPreview(
        projectId: string,
        repoPath: string,
        previewUrl: string | undefined,
        previewRoutes: readonly string[],
        description?: string
    ): Promise<AcceptanceResult> {
        log.info({ projectId, previewUrl, previewRoutes }, 'Starting build-tests-preview acceptance');

        // G3 functional-completeness: scan the generated source for orphaned
        // half-features (e.g. a Stripe webhook receiver with no checkout
        // initiator — the exact MCC defect), plus the PR-2 required-initiator
        // rule (brief implies payments ⇒ an initiator must exist). Source-level,
        // so they run even when the preview URL is missing.
        // BPF-33: required-id checks against the SOURCE. The build-tests-preview
        // path previously only did HTTP-200 on preview routes — it never checked
        // that the brief's required ids (#hero, #pricing, …) actually exist, so a
        // run-locally project could "complete" with the stock scaffold landing
        // page. Scan the app source for each required id, source-level so it runs
        // even with no preview URL.
        const requiredIds = parseSpec(description ?? '')
            .filter((r): r is { kind: 'id-exists'; id: string } => r.kind === 'id-exists')
            .map((r) => r.id);
        const idViolations: AcceptanceViolation[] = checkHtmlIdsInSource(repoPath, requiredIds, fs).map((v) => ({
            check: v.check,
            expected: v.expected,
            message: v.message,
            severity: 'must' as const,
        }));

        const sliceViolations = [
            ...this.runVerticalSliceChecks(repoPath, description),
            ...this.runFabricationAudit(repoPath),
            ...idViolations,
        ];

        if (previewUrl === undefined || previewUrl.length === 0) {
            // BPF-33: run-locally (no hosting) — the source checks (ids + slice +
            // fabrication) ARE the acceptance result; only the HTTP preview-route
            // checks are skipped. So a run-locally project must STILL carry the
            // brief's required ids to complete. With hosting enabled a missing
            // preview is a real scheduling bug → keep surfacing it.
            if (isHostingDisabled()) {
                const mustViolations = sliceViolations.filter((v) => v.severity === 'must');
                const passed = mustViolations.length === 0;
                const result = this.buildResult({
                    projectId,
                    passed,
                    skipped: false,
                    reason: passed
                        ? 'run-locally: source acceptance checks passed (required ids present, no orphaned slices)'
                        : `run-locally: ${mustViolations.length} source acceptance violation${mustViolations.length === 1 ? '' : 's'}`,
                    rules: [],
                    violations: sliceViolations,
                });
                if (passed) await this.publishPassed(projectId, result);
                else await this.publishFailed(projectId, result);
                return result;
            }

            const violation: AcceptanceViolation = {
                check: 'preview-url-missing',
                expected: 'projects.preview_url set after Aegis deploy-preview task',
                message:
                    'AcceptanceGate v2 requires preview_url but the column was empty. ' +
                    'Sensei should schedule a deploy-preview task before invoking this gate.',
                severity: 'must',
            };
            const result = this.buildResult({
                projectId,
                passed: false,
                skipped: false,
                reason: 'preview_url not set',
                rules: [],
                violations: [...sliceViolations, violation],
            });
            await this.publishFailed(projectId, result);
            return result;
        }

        const routesToCheck = ['/', ...previewRoutes];
        const violations: AcceptanceViolation[] = [...sliceViolations];

        for (const route of routesToCheck) {
            const fullUrl = joinUrl(previewUrl, route);
            const check = await this.fetchStatus(fullUrl);
            if (check.kind === 'unreachable') {
                violations.push({
                    check: 'preview-url-unreachable',
                    expected: `200 from ${fullUrl}`,
                    message: `Preview URL unreachable: ${check.error}`,
                    severity: 'must',
                });
            } else if (check.status !== 200) {
                violations.push({
                    check: 'preview-url-not-200',
                    expected: `200 from ${fullUrl}`,
                    message: `Preview URL responded ${check.status} on ${route}`,
                    severity: 'must',
                });
            }
        }

        // Severity-aware: only MUST violations block. SHOULD violations (e.g.
        // a required-initiator downgraded via KAGEOPS_GATE_REQUIRED_INITIATOR=warn)
        // are advisory — surfaced in the result + logged, but they pass the gate.
        const mustViolations = violations.filter((v) => v.severity === 'must');
        const shouldViolations = violations.filter((v) => v.severity === 'should');
        const passed = mustViolations.length === 0;
        const sliceCount = sliceViolations.filter((v) => v.severity === 'must').length;
        const previewCount = mustViolations.length - sliceCount;
        const result = this.buildResult({
            projectId,
            passed,
            skipped: false,
            reason: passed
                ? shouldViolations.length === 0
                    ? `preview URL responded 200 on ${routesToCheck.length} route${routesToCheck.length === 1 ? '' : 's'}`
                    : `MUST checks satisfied; ${shouldViolations.length} advisory warning${shouldViolations.length === 1 ? '' : 's'}`
                : [
                      previewCount > 0 ? `${previewCount} preview-route violation${previewCount === 1 ? '' : 's'}` : '',
                      sliceCount > 0 ? `${sliceCount} functional-completeness violation${sliceCount === 1 ? '' : 's'}` : '',
                  ].filter(Boolean).join(' + '),
            rules: [],
            violations,
        });

        if (passed) {
            await this.publishPassed(projectId, result);
            if (shouldViolations.length > 0) {
                log.warn({ projectId, shouldViolations }, 'Build-tests-preview acceptance passed with advisory warnings');
            }
            log.info({ projectId, previewUrl, routes: routesToCheck.length }, 'Build-tests-preview acceptance passed');
        } else {
            await this.publishFailed(projectId, result);
            log.warn({ projectId, previewUrl, violations: mustViolations.length }, 'Build-tests-preview acceptance failed');
        }

        return result;
    }

    /**
     * HEAD-first, fall back to GET — some hosts (Vercel preview included)
     * disable HEAD for specific paths. Caps redirects at 5 to bound time
     * spent here. Network failures bubble up as `unreachable`.
     *
     * Exposed for tests so the fetch surface can be replaced via the
     * `fetchFn` constructor override if a future PR wants to inject one.
     */
    private async fetchStatus(
        url: string
    ): Promise<{ kind: 'ok'; status: number } | { kind: 'unreachable'; error: string }> {
        const fetchImpl = this.fetchOverride ?? globalThis.fetch;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10_000);
            try {
                let response = await fetchImpl(url, {
                    method: 'HEAD',
                    redirect: 'follow',
                    signal: controller.signal,
                });
                if (response.status === 405 || response.status === 501) {
                    // HEAD not allowed → retry with GET
                    response = await fetchImpl(url, {
                        method: 'GET',
                        redirect: 'follow',
                        signal: controller.signal,
                    });
                }
                return { kind: 'ok', status: response.status };
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            return {
                kind: 'unreachable',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /** Test seam: when set, overrides `globalThis.fetch` for HTTP checks. */
    private fetchOverride: typeof globalThis.fetch | undefined;

    /**
     * Test seam — installs a custom fetch for the preview-URL HTTP checks.
     * Used by unit tests to drive deterministic statuses without hitting
     * the network. Production code does not call this.
     */
    setFetchOverrideForTests(fetchFn: typeof globalThis.fetch | undefined): void {
        this.fetchOverride = fetchFn;
    }

    // ── Private ──────────────────────────────────────

    /**
     * G3 + PR-2: scan the generated app's source for orphaned half-features
     * (always 'must') AND, when a brief is supplied, the required-payment
     * initiator (severity driven by the `KAGEOPS_GATE_REQUIRED_INITIATOR`
     * kill-switch — block ⇒ 'must', warn ⇒ 'should', off ⇒ skipped). Guarded
     * to real code apps (package.json present) so it is a no-op for static
     * sites and the unit-test `/tmp` repoPath. Never throws — a scan failure
     * must not block the gate.
     */
    private runVerticalSliceChecks(repoPath: string, brief?: string): readonly AcceptanceViolation[] {
        try {
            if (!fs.existsSync(path.join(repoPath, 'package.json'))) return [];

            const violations: AcceptanceViolation[] = scanRepoForOrphanedHalves(repoPath, fs).map((v) => ({
                check: v.check,
                expected: v.expected,
                message: v.message,
                severity: 'must' as const,
            }));

            // Required-initiator (PR-2). Only meaningful with a brief to read
            // intent from. `off` skips it; `warn` downgrades to advisory.
            const mode = gateMode(GATE_ENV.requiredInitiator);
            if (brief !== undefined && brief.length > 0 && mode !== 'off') {
                const initiatorViolations = scanRepoForMissingRequiredInitiator(repoPath, fs, brief);
                for (const v of initiatorViolations) {
                    violations.push({
                        check: v.check,
                        expected: v.expected,
                        message: v.message,
                        severity: mode === 'block' ? 'must' : 'should',
                    });
                }
            }

            // Payment-integrity (PR-3). Fires only when payments are actually
            // wired, so it's a correctness guard on top of required-initiator.
            const integrityMode = gateMode(GATE_ENV.paymentIntegrity);
            if (integrityMode !== 'off') {
                for (const v of scanRepoForPaymentIntegrity(repoPath, fs)) {
                    violations.push({
                        check: v.check,
                        expected: v.expected,
                        message: v.message,
                        severity: integrityMode === 'block' ? 'must' : 'should',
                    });
                }
            }

            return violations;
        } catch (err) {
            log.warn(
                { repoPath, err: err instanceof Error ? err.message : String(err) },
                'vertical-slice check threw — continuing acceptance',
            );
            return [];
        }
    }

    /**
     * PR-5 fabrication audit: scan rendered files for placeholder/fabricated
     * values that must not ship (lorem, fake contacts, unfilled gaps, unreplaced
     * template vars). Behind `KAGEOPS_GATE_FABRICATION` — block ⇒ 'must',
     * warn ⇒ 'should', off ⇒ skipped. Applies to static sites AND bundle apps
     * (no package.json guard). Never throws.
     */
    private runFabricationAudit(repoPath: string): readonly AcceptanceViolation[] {
        const mode = gateMode(GATE_ENV.fabrication);
        if (mode === 'off') return [];
        try {
            return scanRepoForFabrication(repoPath, fs).map((v) => ({
                check: v.check,
                expected: 'real content from the brief (or a resolved gap) — no placeholders',
                message: `${v.file}: ${v.message}`,
                severity: mode === 'block' ? ('must' as const) : ('should' as const),
            }));
        } catch (err) {
            log.warn(
                { repoPath, err: err instanceof Error ? err.message : String(err) },
                'fabrication audit threw — continuing acceptance',
            );
            return [];
        }
    }

    private buildResult(input: {
        projectId: string;
        passed: boolean;
        skipped: boolean;
        reason: string;
        rules: readonly SpecRule[];
        violations: readonly AcceptanceViolation[];
    }): AcceptanceResult {
        const requiredIds = input.rules
            .filter((r): r is { kind: 'id-exists'; id: string } => r.kind === 'id-exists')
            .map((r) => r.id);
        return {
            projectId: input.projectId,
            passed: input.passed,
            skipped: input.skipped,
            reason: input.reason,
            requiredIds,
            ruleCount: input.rules.length,
            rules: input.rules,
            violations: input.violations,
        };
    }

    private loadOptionalTestCases(repoPath: string): {
        readonly rules: readonly SpecRule[];
        readonly error: string | null;
    } {
        const fullPath = path.join(repoPath, TEST_CASES_PATH);
        if (!fs.existsSync(fullPath)) {
            return { rules: [], error: null };
        }
        try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            return { rules: loadTestCasesJson(raw), error: null };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { rules: [], error: msg };
        }
    }

    private async publishPassed(projectId: string, result: AcceptanceResult): Promise<void> {
        await this.eventBus.publish('acceptance.passed', {
            projectId,
            agent: 'system',
            data: {
                skipped: result.skipped,
                reason: result.reason,
                requiredIds: result.requiredIds,
                ruleCount: result.ruleCount,
            },
        });
    }

    private async publishFailed(projectId: string, result: AcceptanceResult): Promise<void> {
        await this.eventBus.publish('acceptance.failed', {
            projectId,
            agent: 'system',
            data: {
                reason: result.reason,
                requiredIds: result.requiredIds,
                ruleCount: result.ruleCount,
                violations: result.violations,
            },
        });
    }
}

// ── Helpers ─────────────────────────────────────────

/**
 * Combine a base URL with a route, accepting both relative and absolute
 * route paths. Idempotent against trailing slashes on the base.
 * Exposed for tests.
 */
export function joinUrl(base: string, route: string): string {
    if (/^https?:\/\//.test(route)) return route;
    const trimmedBase = base.replace(/\/$/, '');
    const prefixedRoute = route.startsWith('/') ? route : `/${route}`;
    return `${trimmedBase}${prefixedRoute}`;
}

function dedupeRules(rules: readonly SpecRule[]): readonly SpecRule[] {
    const seen = new Set<string>();
    const out: SpecRule[] = [];
    for (const rule of rules) {
        const key = ruleKey(rule);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(rule);
        }
    }
    return out;
}

function ruleKey(rule: SpecRule): string {
    switch (rule.kind) {
        case 'id-exists': return `id:${rule.id}`;
        case 'tag-exists': return `tag:${rule.tag}`;
        case 'class-exists': return `class:${rule.className}`;
        case 'text-contains': return `text:${rule.text.toLowerCase()}`;
        case 'attribute-exists':
            return `attr:${rule.name}=${rule.value ?? ''}`;
    }
}

function mapCheckKind(kind: SpecRule['kind']): AcceptanceCheck {
    switch (kind) {
        case 'id-exists': return 'missing-id';
        case 'tag-exists': return 'missing-tag';
        case 'class-exists': return 'missing-class';
        case 'text-contains': return 'missing-text';
        case 'attribute-exists': return 'missing-attribute';
    }
}
