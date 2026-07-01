/**
 * KageOps Phase Gate Manager
 *
 * Manages phase transitions with configurable trust levels.
 * Enforces approval gates between phases based on project settings.
 */

import { query, getOne } from '../db/client';
import { EventBus } from './event-bus';
import { Phase } from './task-decomposer';
import { createLogger } from '../shared/logger';
import { isHostingDisabled } from '../shared/hosting-mode';
import { BuildVerificationGate, BuildVerificationResult, BuildStepName } from './build-verification-gate';
import { AcceptanceGate, AcceptanceResult, AcceptanceViolation } from './acceptance-gate';
import { loadBundles } from '../bundles/bundle-loader';
import { BundleRegistry } from '../bundles/bundle-registry';
import { parseBundleKey } from '../agents/specialists/forge-bundle-dispatch';
import type { BundleAcceptanceKind } from '../bundles/types';

const log = createLogger('PhaseGates');

// ── Types ────────────────────────────────────────────

export type TrustLevel = 'low' | 'medium' | 'high';

export interface GateStatus {
    readonly projectId: string;
    readonly currentPhase: Phase;
    readonly allTasksComplete: boolean;
    readonly requiresApproval: boolean;
    readonly trustLevel: TrustLevel;
    readonly canAutoAdvance: boolean;
    readonly buildVerificationPassed?: boolean;
    /**
     * P2-03 (D-08): when buildVerificationPassed === false, carries the
     * specific step that failed (install / build / test / e2e / static-check)
     * so Sensei's createBuildRemediationTask can write a focused fix prompt.
     */
    readonly buildFailedStep?: BuildStepName;
    /**
     * P2-03 (D-08): truncated stderr from the failed build step. Embedded
     * in the build-fix task description for Forge. Capped at 4000 chars to
     * keep the prompt small — long npm output is almost always repeat lines
     * of the same root error.
     */
    readonly buildFailedStderr?: string;
    readonly acceptancePassed?: boolean;
    readonly acceptanceViolations?: readonly AcceptanceViolation[];
    /**
     * P2-05: AcceptanceGate v2 dispatch kind for this project. Resolved
     * from `projects.selected_bundle` → bundle.yaml `acceptance.kind`.
     * Undefined when no bundle is selected or when the bundle omits the
     * `acceptance` block (falls back to legacy html-ids behaviour).
     */
    readonly bundleAcceptanceKind?: BundleAcceptanceKind;
    /**
     * P2-05: current `projects.preview_url` value. Set by Aegis after
     * a successful deploy-preview task. Used by Sensei dispatch to
     * decide whether to schedule a deploy-preview or run AcceptanceGate v2.
     */
    readonly previewUrl?: string;
    /**
     * P2-05: preview routes the v2 gate must HTTP-200-check (in addition
     * to `/`). Populated from the bundle's `acceptance.preview_routes`.
     */
    readonly bundlePreviewRoutes?: readonly string[];
    /**
     * F-368: True when the project is in the `awaiting-input` state — reopened
     * after `completed` but no new work has been added. Callers MUST treat this
     * as a "do nothing" signal: no approval modal, no auto-advance, no Forge
     * dispatch. The operator is just viewing artifacts. Cleared the moment new
     * tasks are decomposed into the project (which flips status back to
     * `active`).
     */
    readonly alreadyComplete?: boolean;
}

const BUILD_STDERR_TRUNCATE = 4000;

export interface ProjectPhaseInfo {
    readonly id: string;
    readonly phase: string;
    readonly trust_level: string;
    readonly autonomous_after_design: boolean;
    readonly status: string;
    readonly repo_path?: string;
    readonly description?: string;
    readonly selected_bundle?: string | null;
    readonly preview_url?: string | null;
}

// ── Phase Gates ──────────────────────────────────────

export class PhaseGateManager {
    private readonly eventBus: EventBus;
    private readonly buildVerificationGate: BuildVerificationGate | null;
    private readonly acceptanceGate: AcceptanceGate | null;
    // P2-05: lazy bundle registry for resolving acceptance.kind per project.
    private bundleRegistry: BundleRegistry | null = null;

    constructor(
        eventBus: EventBus,
        buildVerificationGate?: BuildVerificationGate,
        acceptanceGate?: AcceptanceGate
    ) {
        this.eventBus = eventBus;
        this.buildVerificationGate = buildVerificationGate ?? null;
        this.acceptanceGate = acceptanceGate ?? null;
    }

    private async getBundleRegistry(): Promise<BundleRegistry> {
        if (this.bundleRegistry !== null) return this.bundleRegistry;
        const result = await loadBundles();
        this.bundleRegistry = new BundleRegistry(result);
        return this.bundleRegistry;
    }

    /**
     * P2-05: resolve the AcceptanceGate v2 dispatch metadata for a project.
     * Returns the bundle's acceptance.kind + preview_routes, defaulting to
     * legacy html-ids behaviour when no bundle is selected or the bundle
     * omits the acceptance block.
     */
    private async resolveBundleAcceptance(
        selectedBundle: string | null | undefined
    ): Promise<{
        readonly kind: BundleAcceptanceKind;
        readonly previewRoutes: readonly string[];
    }> {
        if (selectedBundle === null || selectedBundle === undefined || selectedBundle.length === 0) {
            return { kind: 'html-ids', previewRoutes: [] };
        }
        const parsed = parseBundleKey(selectedBundle);
        if (parsed === null) {
            return { kind: 'html-ids', previewRoutes: [] };
        }
        const registry = await this.getBundleRegistry();
        const bundle = registry.get(parsed.kind, parsed.name);
        if (bundle === undefined) {
            return { kind: 'html-ids', previewRoutes: [] };
        }
        const acceptance = bundle.manifest.acceptance;
        if (acceptance === undefined) {
            return { kind: 'html-ids', previewRoutes: [] };
        }
        return {
            kind: acceptance.kind,
            previewRoutes: acceptance.preview_routes ?? [],
        };
    }

    /**
     * Check the gate status for a project — are all tasks done?
     * Does the phase transition need human approval?
     */
    async checkGate(projectId: string): Promise<GateStatus> {
        const project = await getOne<ProjectPhaseInfo>(
            `SELECT id, phase, trust_level, autonomous_after_design, status, repo_path, description,
                    selected_bundle, preview_url
             FROM projects WHERE id = $1`,
            [projectId]
        );

        if (project === null) {
            throw new Error(`Project not found: ${projectId}`);
        }

        const currentPhase = project.phase as Phase;
        const trustLevel = project.trust_level as TrustLevel;

        // F-368: short-circuit on the reopen-but-no-work state. A project that
        // was reopened from `completed` lands here with phase=launch-growth and
        // all tasks done — there is no next phase, no Forge work to dispatch,
        // and no human approval to request. Surfacing an approval modal in
        // this state confuses operators (clicking approve "re-completes" the
        // project instantly because getNextEnabledPhase returns null). Callers
        // who care render an "Already complete — view artifacts" affordance
        // instead. Cleared automatically when a follow-up brief decomposes
        // new tasks (F-342) and bumps status back to `active`.
        if (project.status === 'awaiting-input') {
            log.info(
                { projectId, currentPhase },
                'Gate check short-circuited — project is awaiting-input (reopened, no new work)',
            );
            return {
                projectId,
                currentPhase,
                allTasksComplete: true,
                requiresApproval: false,
                trustLevel,
                canAutoAdvance: false,
                alreadyComplete: true,
            };
        }

        // Check if all tasks in current phase are completed
        const allTasksComplete = await this.allPhaseTasksComplete(projectId, currentPhase);

        // Determine if approval is required
        const requiresApproval = this.doesRequireApproval(
            trustLevel,
            currentPhase,
            project.autonomous_after_design
        );

        const repoPath = project.repo_path ?? process.cwd();

        // P1-09b: detect revision-only iterations (/add-requirement flow on
        // an already-built project). Computed early so the acceptance gate
        // can be gated on it — see P1-09c below.
        let revisionOnlyIteration = false;
        if (allTasksComplete && currentPhase === 'development') {
            revisionOnlyIteration = await this.allCompletedTasksAreRevisions(
                projectId,
                currentPhase,
            );
        }

        // P1-09c (2026-05-25): when KAGEOPS_FEATURE_REVISIONS=true is in
        // effect AND this is a revision-only iteration, the workspace is
        // intentionally pre-Accept — the staged proposal sits in
        // KAGEOPS_DATA_DIR/staging/<projectId>/<taskId>/ and has not been
        // applied to disk. Running AcceptanceGate against the unchanged
        // workspace produces guaranteed false-negatives because
        // Sensei.addRequirement stamps `[Added <ts>] <text>` onto
        // project.description and parseSpec(description) synthesises
        // text-contains rules from those appended quotes — rules that can
        // only be satisfied once the operator Accepts. Skip the gate; the
        // accept-proposal IPC handler is responsible for re-running
        // acceptance on the post-Accept workspace.
        const stagingMode = process.env['KAGEOPS_FEATURE_REVISIONS'] === 'true';
        const skipAcceptanceForStaging = stagingMode && revisionOnlyIteration;

        let buildVerificationPassed: boolean | undefined;
        let buildFailedStep: BuildStepName | undefined;
        let buildFailedStderr: string | undefined;

        // Run build verification for development phase when all tasks complete
        if (currentPhase === 'development' && allTasksComplete && this.buildVerificationGate !== null) {
            try {
                const buildResult: BuildVerificationResult = await this.buildVerificationGate.verify(
                    projectId,
                    repoPath
                );
                buildVerificationPassed = buildResult.passed;
                if (!buildResult.passed && buildResult.failedStep !== null) {
                    buildFailedStep = buildResult.failedStep;
                    // P2-03: carry the failing step's stderr (truncated) so
                    // Sensei.createBuildRemediationTask can include it in the
                    // build-fix prompt. Sensei is the only consumer.
                    const failed = buildResult.steps.find(
                        (s) => s.step === buildResult.failedStep
                    );
                    // Empty stderr falls through to stdout — many npm failures (peer
                    // dep mismatches, EBADENGINE, etc.) write their useful output to
                    // stdout. `??` would NOT trigger on '' so we check trimmed length.
                    const trimmedStderr = failed?.stderr.trim() ?? '';
                    const trimmedStdout = failed?.stdout.trim() ?? '';
                    const raw = trimmedStderr.length > 0 ? trimmedStderr : trimmedStdout;
                    buildFailedStderr = raw.length > BUILD_STDERR_TRUNCATE
                        ? raw.slice(0, BUILD_STDERR_TRUNCATE - 1) + '…'
                        : raw;
                }
            } catch (err) {
                log.error({ projectId, err }, 'Build verification threw an error');
                buildVerificationPassed = false;
            }
        }

        const buildBlocks = buildVerificationPassed === false;

        // P2-05: resolve the bundle-driven acceptance dispatch metadata.
        // Empty/legacy projects resolve to { kind: 'html-ids', previewRoutes: [] }
        // which preserves backwards-compat behaviour.
        const bundleAcceptance = await this.resolveBundleAcceptance(project.selected_bundle);
        const previewUrl = project.preview_url ?? undefined;

        let acceptancePassed: boolean | undefined;
        let acceptanceViolations: readonly AcceptanceViolation[] | undefined;

        // Run acceptance (spec-fidelity) check whenever development tasks are
        // done. It checks artifacts vs. user spec and catches a different class
        // of failure than BuildVerificationGate, so we run it independently of
        // the build outcome — a build failure for unrelated reasons should not
        // hide a spec violation.
        //
        // P1-09c: skip when the proposal is staged-but-unaccepted (see
        // skipAcceptanceForStaging above).
        //
        // P2-05: for `build-tests-preview` kind, ALSO skip if no preview_url
        // is set yet — Sensei is responsible for scheduling a deploy-preview
        // task first. Running the v2 gate against a null URL would emit a
        // misleading `preview-url-missing` violation when the cause is just
        // "we haven't deployed yet".
        // BPF-33: run-locally (no hosting) must STILL run acceptance — the gate's
        // source-level checks (required HTML ids, vertical-slice, fabrication) need
        // no preview URL. Previously we skipped the whole gate when no preview
        // existed, so a run-locally Next.js project could complete with the stock
        // scaffold landing page (none of the brief's required ids). Only skip the
        // "no preview yet" case when hosting is ENABLED (a deploy-preview is still
        // pending and Sensei will schedule it).
        const skipV2GateForMissingPreview =
            bundleAcceptance.kind === 'build-tests-preview' &&
            (previewUrl === undefined || previewUrl.length === 0) &&
            !isHostingDisabled();

        if (
            currentPhase === 'development' &&
            allTasksComplete &&
            !skipAcceptanceForStaging &&
            !skipV2GateForMissingPreview &&
            this.acceptanceGate !== null &&
            project.description !== undefined &&
            project.description !== null
        ) {
            try {
                const acceptanceResult: AcceptanceResult = await this.acceptanceGate.verify(
                    projectId,
                    repoPath,
                    project.description,
                    {
                        kind: bundleAcceptance.kind,
                        ...(previewUrl !== undefined ? { previewUrl } : {}),
                        previewRoutes: bundleAcceptance.previewRoutes,
                    }
                );
                if (!acceptanceResult.skipped) {
                    acceptancePassed = acceptanceResult.passed;
                    if (!acceptanceResult.passed) {
                        acceptanceViolations = acceptanceResult.violations;
                    }
                }
            } catch (err) {
                log.error({ projectId, err }, 'Acceptance gate threw an error');
                acceptancePassed = false;
            }
        }

        if (skipAcceptanceForStaging) {
            log.info(
                { projectId, currentPhase },
                'P1-09c: skipping acceptance gate — revision-only iteration with KAGEOPS_FEATURE_REVISIONS=true (workspace is pre-Accept, run acceptance after operator Accepts the proposal)',
            );
        }

        const acceptanceBlocks = acceptancePassed === false;

        // P1-09b: park the revision-only iteration in awaiting-input so the
        // next checkGate call hits the F-368 short-circuit at the top of
        // this method; the next /add-requirement flips status back to
        // active. Suppresses auto-advance to launch-growth re-decompose.
        if (revisionOnlyIteration) {
            await query(
                `UPDATE projects
                    SET status = 'awaiting-input', updated_at = NOW()
                  WHERE id = $1
                    AND status NOT IN ('cancelled', 'archived', 'completed')`,
                [projectId],
            );
            log.info(
                { projectId, currentPhase },
                'P1-09b: revision-only iteration complete — parked in awaiting-input (no auto-advance)',
            );
        }

        // Pillar 2.2 PR-F: when the bundle declares the v2 acceptance gate
        // (`build-tests-preview`), the development phase is NOT complete
        // until a preview_url exists. Without this guard, canAutoAdvance
        // fires at end-of-development → Sensei jumps straight to
        // launch-growth → Aegis runs the generic deploy-production task
        // (writes runbook docs) instead of the deploy-preview task that
        // actually ships to Vercel. The HabitForge smoke (2026-05-30)
        // caught this end-to-end: bundle scaffold landed, .env.local
        // materialised, build passed — but no *.vercel.app URL was ever
        // produced because deploy-preview never got scheduled.
        // BPF-7: "run locally / no hosting" — never treat a missing preview as
        // pending work; the operator opted out of the cloud deploy, so a green
        // build+tests completes development (the app still builds/runs locally).
        const deployPreviewPending =
            currentPhase === 'development' &&
            bundleAcceptance.kind === 'build-tests-preview' &&
            buildVerificationPassed === true &&
            (previewUrl === undefined || previewUrl.length === 0) &&
            !isHostingDisabled();

        const canAutoAdvance =
            allTasksComplete &&
            !requiresApproval &&
            !buildBlocks &&
            !acceptanceBlocks &&
            !revisionOnlyIteration &&
            !deployPreviewPending;

        log.info(
            { projectId, currentPhase, allTasksComplete, buildVerificationPassed, acceptancePassed, canAutoAdvance, revisionOnlyIteration, deployPreviewPending },
            'Gate check evaluated'
        );

        return {
            projectId,
            currentPhase,
            allTasksComplete,
            requiresApproval,
            trustLevel,
            canAutoAdvance,
            ...(buildVerificationPassed !== undefined ? { buildVerificationPassed } : {}),
            ...(buildFailedStep !== undefined ? { buildFailedStep } : {}),
            ...(buildFailedStderr !== undefined ? { buildFailedStderr } : {}),
            ...(acceptancePassed !== undefined ? { acceptancePassed } : {}),
            ...(acceptanceViolations !== undefined ? { acceptanceViolations } : {}),
            bundleAcceptanceKind: bundleAcceptance.kind,
            ...(previewUrl !== undefined ? { previewUrl } : {}),
            bundlePreviewRoutes: bundleAcceptance.previewRoutes,
            ...(revisionOnlyIteration ? { alreadyComplete: true } : {}),
        };
    }

    /**
     * Request approval for a phase transition.
     * Publishes approval.required event and blocks.
     *
     * @param reason  When set, signals a blocking escalation (e.g. build
     *                failure, acceptance retry exhaustion) — headless
     *                auto-approve MUST refuse these. When omitted, this is
     *                a clean phase-gate pass and auto-approve is safe.
     */
    async requestApproval(projectId: string, reason?: string): Promise<void> {
        const project = await getOne<ProjectPhaseInfo>(
            'SELECT id, phase, trust_level, status FROM projects WHERE id = $1',
            [projectId]
        );

        if (project === null) {
            throw new Error(`Project not found: ${projectId}`);
        }

        // Mark project as waiting for approval
        await query(
            `UPDATE projects SET status = 'awaiting-approval' WHERE id = $1`,
            [projectId]
        );

        const message = reason !== undefined
            ? `Phase "${project.phase}" blocked: ${reason}`
            : `Phase "${project.phase}" complete. Awaiting human approval to proceed.`;

        await this.eventBus.publish('approval.required', {
            projectId,
            agent: 'sensei',
            data: {
                currentPhase: project.phase,
                trustLevel: project.trust_level,
                message,
                ...(reason !== undefined ? { reason } : {}),
            },
        });

        log.info({ projectId, phase: project.phase, reason }, 'Approval requested');
    }

    /**
     * Approve a phase gate — advance project to next phase.
     */
    async approveGate(projectId: string): Promise<Phase | null> {
        const project = await getOne<ProjectPhaseInfo & { readonly name?: string }>(
            'SELECT id, name, phase, trust_level, status FROM projects WHERE id = $1',
            [projectId]
        );

        if (project === null) {
            throw new Error(`Project not found: ${projectId}`);
        }

        const nextPhase = await this.getNextEnabledPhase(projectId, project.phase as Phase);

        if (nextPhase === null) {
            // Project is complete
            await query(
                `UPDATE projects SET status = 'completed' WHERE id = $1`,
                [projectId]
            );

            // P1-05a: close the current iteration so the next reopen
            // opens a fresh cycle. Non-fatal — legacy data dirs without
            // migration 026 simply have nothing to close.
            try {
                const { iterationRepository } = await import('../db/iteration-repo');
                await iterationRepository.closeCurrent(projectId);
            } catch {
                // Best-effort; iterations table may be absent on pre-026 data dirs.
            }

            await this.eventBus.publish('approval.granted', {
                projectId,
                agent: 'human',
                data: { currentPhase: project.phase, nextPhase: null, message: 'Project completed!' },
            });

            // Dedicated project.completed event so the main process can
            // surface an OS-level notification (system toast + sound).
            // approval.granted is also fired but it's noisy — listeners
            // that only care about end-of-project subscribe to this.
            await this.eventBus.publish('project.completed', {
                projectId,
                agent: 'system',
                data: { finalPhase: project.phase, name: project.name ?? null },
            });

            return null;
        }

        // Advance to next phase — atomic guard: only advance if phase still
        // matches what we read. Prevents concurrent callers from each
        // re-decomposing the next phase (root cause of task duplication).
        // RETURNING id is required: PGlite reports rowCount=0 for UPDATE
        // without RETURNING even when rows are modified.
        const advance = await query(
            `UPDATE projects SET phase = $1, status = 'active'
             WHERE id = $2 AND phase = $3
             RETURNING id`,
            [nextPhase, projectId, project.phase]
        );
        if (advance.rowCount === 0) {
            log.info(
                { projectId, expectedPhase: project.phase },
                'Phase gate approve no-op: phase already advanced by another caller'
            );
            return null;
        }

        await this.eventBus.publish('approval.granted', {
            projectId,
            agent: 'human',
            data: {
                previousPhase: project.phase,
                nextPhase,
                message: `Approved. Advancing to phase "${nextPhase}".`,
            },
        });

        log.info({ projectId, previousPhase: project.phase, nextPhase }, 'Phase gate approved');
        return nextPhase;
    }

    /**
     * Deny a phase gate — keep project in current phase.
     */
    async denyGate(projectId: string, reason?: string): Promise<void> {
        const project = await getOne<ProjectPhaseInfo>(
            'SELECT id, phase, status FROM projects WHERE id = $1',
            [projectId]
        );

        if (project === null) {
            throw new Error(`Project not found: ${projectId}`);
        }

        await query(
            `UPDATE projects SET status = 'active' WHERE id = $1`,
            [projectId]
        );

        await this.eventBus.publish('approval.denied', {
            projectId,
            agent: 'human',
            data: {
                currentPhase: project.phase,
                reason: reason ?? 'Denied by human. Review and revise.',
            },
        });

        log.info({ projectId, phase: project.phase }, 'Phase gate denied');
    }

    // ── Private ──────────────────────────────────────

    private doesRequireApproval(
        trustLevel: TrustLevel,
        currentPhase: Phase,
        autonomousAfterDesign: boolean
    ): boolean {
        // After design phase, if autonomous flag is set, auto-approve
        const postDesignPhases: Phase[] = ['development', 'launch-growth'];
        if (autonomousAfterDesign && postDesignPhases.includes(currentPhase)) {
            return false;
        }

        switch (trustLevel) {
            case 'low':
                // Always require approval
                return true;

            case 'medium':
                // Only require approval at phase transitions (which is where we are)
                return true;

            case 'high':
                // Auto-approve, just log
                return false;

            default:
                return true;
        }
    }

    /**
     * P1-09b: returns true when, **scoped to the latest iteration only**,
     * there is at least one completed task in the phase AND every completed
     * task in that iteration has task_type='revision'. Used by checkGate to
     * detect /add-requirement-driven iterations so the gate can park the
     * project in awaiting-input rather than auto-advance to launch-growth
     * (which would re-decompose unrelated polish work that bypasses the
     * revision/diff-card flow).
     *
     * Iteration scoping matters: a project that has been through several
     * /add-requirement iterations accumulates many completed non-revision
     * tasks in earlier iterations. A naive "all completed in phase are
     * revisions" check would always return false on such a project. We
     * therefore filter to the most recent iteration row.
     *
     * Returns false on legacy projects with no iterations (pre-migration)
     * so the guard never blocks normal advancement on those.
     */
    private async allCompletedTasksAreRevisions(projectId: string, phase: Phase): Promise<boolean> {
        const result = await getOne<{ total: string; revisions: string }>(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'completed') AS total,
                COUNT(*) FILTER (WHERE status = 'completed' AND task_type = 'revision') AS revisions
             FROM tasks
             WHERE project_id = $1
               AND phase = $2
               AND iteration_id = (
                   SELECT id FROM iterations
                    WHERE project_id = $1
                    ORDER BY iteration_index DESC
                    LIMIT 1
               )`,
            [projectId, phase],
        );
        if (result === null) return false;
        const total = parseInt(result.total, 10);
        const revisions = parseInt(result.revisions, 10);
        return total > 0 && total === revisions;
    }

    private async allPhaseTasksComplete(projectId: string, phase: Phase): Promise<boolean> {
        // Tasks that reached a terminal state ('completed' OR 'failed') count as done.
        // A 'failed' task has exhausted MAX_TASK_RETRIES — it will never complete, and
        // blocking the phase forever on it causes headless runs to time out.
        // Failed tasks still surface via comms notifications and approval.required events;
        // they just no longer gate phase advancement.
        const result = await getOne<{ total: string; done: string }>(
            `SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS done
             FROM tasks
             WHERE project_id = $1 AND phase = $2`,
            [projectId, phase]
        );

        if (result === null) {
            return false;
        }

        const total = parseInt(result.total, 10);
        const done = parseInt(result.done, 10);

        return total > 0 && total === done;
    }

    private getNextPhase(current: Phase): Phase | null {
        const phases: Phase[] = [
            'discovery',
            'poc',
            'business-viability',
            'design-planning',
            'development',
            'launch-growth',
        ];

        const idx = phases.indexOf(current);
        if (idx < 0 || idx >= phases.length - 1) {
            return null;
        }

        return phases[idx + 1];
    }

    /**
     * Resolve the next phase that's actually enabled for this project.
     * If the user opted out of (e.g.) discovery + POC + business
     * viability when starting the project, this method walks past
     * those entries and returns the next phase the user wants to run.
     */
    private async getNextEnabledPhase(
        projectId: string,
        current: Phase,
    ): Promise<Phase | null> {
        const row = await getOne<{ enabled_phases: string[] | null }>(
            'SELECT enabled_phases FROM projects WHERE id = $1',
            [projectId],
        );
        const enabled = row?.enabled_phases ?? null;

        let next = this.getNextPhase(current);
        // No enabled_phases column or empty → legacy behaviour.
        if (next === null || enabled === null || enabled.length === 0) return next;

        const enabledSet = new Set<string>(enabled);
        while (next !== null && !enabledSet.has(next)) {
            next = this.getNextPhase(next);
        }
        return next;
    }
}
