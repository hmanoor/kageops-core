/**
 * Forge — Engineer Agent
 *
 * Handles all code implementation: features, bug fixes, refactoring,
 * API development, UI components, and database migrations.
 * Always writes tests alongside code and commits after each task.
 *
 * Integrates FileDedupChecker (prevents duplicate file creation) and
 * DependencyManager (auto-detects missing npm deps).
 */

import * as path from 'path';
import * as fs from 'fs';
import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import { withGrounding } from '../grounding';
import { buildRedPrompt, buildGreenPrompt, buildImprovePrompt, extractTestFiles, extractImplFiles } from '../tdd-workflow';
import { FileDedupChecker } from '../file-dedup-checker';
import { DependencyManager } from '../dependency-manager';
import { parseFileBlocks, isLikelyArtifactContent, recoverArtifactFromNarration, FileBlock } from '../output-parser';
import { evidenceFromFiles } from '../verification-gate';
import { query } from '../../db/client';
import { detectSimpleApp } from '../../shared/simple-app-detector';
import { buildDesignContext, buildBundleDesignContext } from '../design/design-pack';
import { loadBundles } from '../../bundles/bundle-loader';
import { BundleRegistry } from '../../bundles/bundle-registry';
import { resolveBundleForProject } from './forge-bundle-dispatch';
import { renderBundlePrompt } from '../../bundles/bundle-prompt-renderer';
import { copyBundleScaffold } from '../../bundles/scaffold-copier';
import type { LoadedBundle } from '../../bundles/types';

// ── Constants ────────────────────────────────────────

const FORGE_SKILLS = [
    'typescript',
    'javascript',
    'python',
    'react-nextjs',
    'nodejs',
    'api-development',
    'database-queries',
    'testing',
    'refactoring',
    'debugging',
    'git',
] as const;

const SYSTEM_PROMPT =
    'You are Forge, a senior full-stack engineer. You write clean, tested, production-ready code. ' +
    'You follow the project\'s coding standards and always run tests before committing. ' +
    'You write comprehensive tests alongside your implementation code. ' +
    'Your code is well-documented with JSDoc comments and clear variable names.';

// ── Forge Agent ──────────────────────────────────────

export class Forge extends AutonautAgent {
    private readonly dedupChecker: FileDedupChecker;
    private readonly depManager: DependencyManager;

    // P2-02: lazy-loaded bundle registry. Loaded on first access then
    // cached for the lifetime of this Forge instance. Loader handles its
    // own errors (returns empty result if bundles dir is missing) so
    // bundle dispatch is always safe to call — flag-off + empty registry
    // both fall back to the inline static-HTML / standard switch paths.
    private bundleRegistry: BundleRegistry | null = null;

    constructor(modelConfig: AgentModelConfig) {
        super('forge', 'engineer', FORGE_SKILLS, modelConfig, withGrounding(SYSTEM_PROMPT));
        this.dedupChecker = new FileDedupChecker();
        this.depManager = new DependencyManager();
    }

    async executeTask(task: TaskInfo): Promise<void> {
        // P1-09: revision tasks route through executeRevisionTask for EVERY
        // project shape, including static-HTML. Pre-P1-09 the isStaticHtmlProject
        // guard below ran implementStaticHtmlFeature for every task type, which
        // silently bypassed the revision/diff-card flow — operators driving
        // /add-requirement on Solarsizer-shaped briefs saw no `revision.proposed`
        // event, no staging dir, no diff card. The general revision path
        // already reads workspace files as authoritative and asks the LLM
        // for minimal in-place edits, which is the right shape for HTML/CSS/JS
        // too. See docs/handovers/2026-05-25-quickstart.md (load-bearing
        // architectural finding).
        if (task.taskType === 'revision') {
            await this.executeRevisionTask(task);
            return;
        }

        // P2-02: bundle dispatch for non-vanilla-html stacks (e.g. nextjs-saas).
        // Gated by KAGEOPS_FEATURE_BUNDLES=true + projects.selected_bundle.
        // vanilla-html stays on the legacy inline path until the Pillar 1.3
        // cleanup PR retires it (plan decision #3). Any OTHER stack bundle
        // present in the registry takes precedence over the static-HTML
        // heuristic — Scout (P1-12) is the source of truth on which bundle
        // a project should use; the heuristic is a fallback for projects
        // that pre-date the bundle flag.
        const bundleHit = await this.resolveBundleHit(task);
        if (bundleHit !== null) {
            if (task.taskType === 'setup-project') {
                await this.setupBundleProject(task, bundleHit);
                return;
            }
            await this.implementBundleFeature(task, bundleHit);
            return;
        }

        // Static-HTML projects route EVERYTHING ELSE through the single-shot
        // static path. Skips TDD, build, tests — static sites have no build infra.
        if (await this.isStaticHtmlProject(task)) {
            if (task.taskType === 'setup-project') {
                const docContext = await this.gatherContext(task);
                await this.setupStaticHtmlProject(task, docContext);
                return;
            }
            const docContext = await this.gatherContext(task);
            const filesContext = this.getExistingFilesContext(task.repoPath);
            const context = [docContext, filesContext].filter(Boolean).join('\n\n');
            await this.implementStaticHtmlFeature(task, context);
            return;
        }

        switch (task.taskType) {
            case 'setup-project':
                await this.setupProject(task);
                break;
            case 'implement':
                await this.implementFeature(task);
                break;
            case 'refactor':
                await this.refactorCode(task);
                break;
            case 'fix-bug':
                await this.fixBug(task);
                break;
            case 'create-api':
                await this.createApi(task);
                break;
            case 'create-ui':
                await this.createUi(task);
                break;
            case 'database-migration':
                await this.createMigration(task);
                break;
            default:
                await this.handleGenericTask(task);
                break;
        }
    }

    // ── P1-06b: revision-task handler ───────────────

    /**
     * Modify-in-place handler for `task_type='revision'` tasks. Reads
     * the operator's verbatim change instruction (`task.revisionInstruction`,
     * stamped by Sensei.stampRevisionMetadata in P1-06a) and the
     * current workspace contents, asks the LLM to produce minimal
     * diffs, writes the output through the existing writeOutputFiles
     * path. The P1-01c writeFile sha256 cache means unchanged files
     * are free (zero re-write, zero new checkpoint row).
     *
     * Scope notes (P1-06b is the first cut):
     *   - Target files: when `task.targetFiles` is null (P1-06a-vintage
     *     tasks; the decomposer-side workspace-tree scan that populates
     *     it is P1-07 territory), we scan the workspace root + immediate
     *     subdirs for known artifact extensions (.html, .css, .js, .ts,
     *     .tsx, .json, .md, .py). Cheap enough for the current
     *     single-page-tool sweet spot; multi-file SaaS revisions will
     *     need P1-07's smarter scoping.
     *   - Commit prefix: when git is enabled, the per-task branch's
     *     commit message is prefixed `revision:` so `git log` reflects
     *     the operator's iteration history at a glance.
     *   - No staging dir / accept-reject yet — outputs land directly
     *     in the workspace. P1-08a moves writes to a staging dir +
     *     P1-08b adds the inline-chat accept/reject surface.
     */
    private async executeRevisionTask(task: TaskInfo): Promise<void> {
        const instruction = (task.revisionInstruction ?? '').trim();
        if (instruction === '') {
            // Shouldn't happen — Sensei.stampRevisionMetadata only
            // marks tasks revision when there's an /add-requirement
            // payload. Defensive log + fall through to the generic
            // path so the task doesn't strand at status='in-progress'.
            this.log.warn({ taskId: task.id }, 'P1-06b: revision task missing revisionInstruction — falling back to generic handler');
            await this.handleGenericTask(task);
            return;
        }

        await this.reportProgress(task, `Revision: "${instruction.slice(0, 80)}"…`);

        const filePaths = await this.resolveRevisionTargetFiles(task);
        const files = this.collectRevisionFiles(task.repoPath, filePaths);

        // P1-07: token-budget-aware prompt build. Returns the prompt
        // string plus diagnostics (`estimatedTokens`, `truncatedFiles`).
        // The budget is soft — it never refuses; per-file truncation
        // keeps the prompt under the Haiku 10k guard.
        const { buildRevisionPrompt, REVISION_PROMPT_TOKEN_BUDGET } =
            await import('../forge-revision-prompt');
        const built = buildRevisionPrompt(instruction, files);
        if (built.hitBudget) {
            this.log.warn(
                {
                    taskId: task.id,
                    estimatedTokens: built.estimatedTokens,
                    budget: REVISION_PROMPT_TOKEN_BUDGET,
                    truncated: built.truncatedFiles,
                },
                'P1-07: revision prompt hit token budget — content truncated to fit',
            );
        }
        const response = await this.askAI(built.prompt);

        // P1-08a: feature-flag-gated branch. When
        // KAGEOPS_FEATURE_REVISIONS=true, parse the LLM's file
        // blocks + stage them under KAGEOPS_DATA_DIR/staging/ +
        // emit `revision.proposed`. Sensei chat surface (P1-08b)
        // will then prompt the operator to accept/reject. When the
        // flag is OFF (default) we fall through to the P1-06b
        // straight-to-workspace path.
        if (process.env['KAGEOPS_FEATURE_REVISIONS'] === 'true') {
            await this.stageRevisionProposal(task, instruction, response.text);
            return;
        }

        const written = await this.writeOutputFiles(task, response.text);

        this.log.info(
            { taskId: task.id, instructionLen: instruction.length, considered: filePaths.length, written: written.length },
            'P1-06b: revision task wrote files',
        );

        await this.reportProgress(
            task,
            `Revision complete — ${written.length} file${written.length === 1 ? '' : 's'} updated.`,
        );

        // Commit with the `revision:` prefix when git is on for this task.
        // gitCommit is a no-op when KAGEOPS_DISABLE_GIT is set.
        try {
            await this.gitCommit(task.repoPath, `revision: ${instruction.slice(0, 72)}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ taskId: task.id, err: msg }, 'P1-06b: revision git commit failed (non-fatal)');
        }
    }

    /**
     * P1-08a: parse the LLM's file blocks + stage each one under
     * `KAGEOPS_DATA_DIR/staging/<projectId>/<taskId>/`, then emit
     * `revision.proposed` so the Sensei chat surface (P1-08b) can
     * show the diff + accept/reject buttons.
     *
     * Doesn't commit, doesn't touch the workspace. The operator's
     * accept handler is the only thing that moves staged files into
     * the live workspace (via `acceptProposal` → standard `writeFile`
     * path → P1-01c sha256 cache).
     *
     * Uses the F-390 stub-prose guard from `parseFileBlocks` +
     * `isLikelyArtifactContent` so the staged content is still
     * validated; a revision that produces prose-as-files is rejected
     * before staging.
     */
    private async stageRevisionProposal(
        task: TaskInfo,
        instruction: string,
        responseText: string,
    ): Promise<void> {
        const { parseFileBlocks, isLikelyArtifactContent, recoverArtifactFromNarration, sanitizeAgentOutput } =
            await import('../output-parser');
        const { stageFile } = await import('../revision-staging');

        const blocks = parseFileBlocks(responseText);
        const stagedFiles: import('../revision-staging').ProposedFile[] = [];
        const rejectedBlocks: { path: string; preview: string }[] = [];

        for (const block of blocks) {
            let cleaned = sanitizeAgentOutput(block.content, block.filePath);
            if (!isLikelyArtifactContent(cleaned, block.filePath)) {
                // BPF-4: recover a real artifact hidden behind a narration preamble.
                const recovered = recoverArtifactFromNarration(cleaned, block.filePath);
                if (recovered === null) {
                    rejectedBlocks.push({
                        path: block.filePath,
                        preview: cleaned.replace(/\s+/g, ' ').slice(0, 120),
                    });
                    continue;
                }
                this.log.info(
                    { taskId: task.id, file: block.filePath, strippedChars: cleaned.length - recovered.length },
                    'BPF-4: stripped narration preamble — recovered staged revision block',
                );
                cleaned = recovered;
            }
            try {
                stagedFiles.push(stageFile(task.projectId, task.id, task.repoPath, block.filePath, cleaned));
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn({ taskId: task.id, file: block.filePath, err: msg }, 'P1-08a: failed to stage file (skipped)');
            }
        }

        if (rejectedBlocks.length > 0) {
            this.log.warn(
                { taskId: task.id, rejected: rejectedBlocks },
                'P1-08a: F-390 guard rejected revision file blocks before staging',
            );
        }

        if (stagedFiles.length === 0) {
            this.log.warn({ taskId: task.id }, 'P1-08a: revision produced no stageable files — task completes without proposal');
            await this.reportProgress(task, 'Revision produced no changes to propose.');
            return;
        }

        const changedFiles = stagedFiles.filter((f) => !f.unchanged);
        this.log.info(
            { taskId: task.id, staged: stagedFiles.length, changed: changedFiles.length, instructionLen: instruction.length },
            'P1-08a: revision proposal staged',
        );

        await this.publishEvent('revision.proposed', {
            iterationId: task.iterationId ?? null,
            instruction,
            stagedFileCount: stagedFiles.length,
            changedFileCount: changedFiles.length,
            files: stagedFiles.map((f) => ({
                path: f.path,
                sizeBytes: f.sizeBytes,
                proposedSha256: f.proposedSha256,
                currentSha256: f.currentSha256,
                unchanged: f.unchanged,
            })),
        });

        await this.reportProgress(
            task,
            `Revision staged — ${changedFiles.length} of ${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'} change; awaiting accept/reject.`,
        );
    }

    /**
     * P1-06b: figure out which files the revision should consider.
     *
     *   1. `task.targetFiles` populated → use it verbatim (decomposer-
     *      side scoping per P1-07 once that lands).
     *   2. Null targetFiles → scan workspace root + one level of
     *      subdirs for known artifact extensions. Keeps the prompt
     *      grounded in real files instead of making the LLM guess.
     *
     * Excludes obvious non-artifacts: `node_modules`, `.git`,
     * `.kageops`, `dist`, `build`, lock files. Caps at 20 files to
     * keep the prompt under the Haiku token guard.
     */
    private async resolveRevisionTargetFiles(task: TaskInfo): Promise<readonly string[]> {
        if (task.targetFiles !== null && task.targetFiles !== undefined && task.targetFiles.length > 0) {
            return task.targetFiles;
        }

        const fs = await import('fs');
        const path = await import('path');
        const root = task.repoPath;
        if (root === '' || !fs.existsSync(root)) return [];

        const ARTIFACT_EXTS = new Set(['.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.py']);
        const SKIP_DIRS = new Set(['node_modules', '.git', '.kageops', 'dist', 'build', '.next', '.cache', '.vscode']);
        const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
        const MAX_FILES = 20;

        const collected: string[] = [];

        const walk = (dir: string, depth: number): void => {
            if (depth > 1) return;
            let entries: import('fs').Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (collected.length >= MAX_FILES) return;
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) continue;
                    walk(path.join(dir, entry.name), depth + 1);
                } else if (entry.isFile()) {
                    if (SKIP_FILES.has(entry.name)) continue;
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!ARTIFACT_EXTS.has(ext)) continue;
                    const rel = path.relative(root, path.join(dir, entry.name));
                    collected.push(rel.replace(/\\/g, '/'));
                }
            }
        };
        walk(root, 0);
        return collected;
    }

    /**
     * P1-06b → P1-07: read target file contents into the
     * `RevisionFile` shape the pure prompt-builder consumes.
     * Truncation lives in the prompt-builder (budget-aware) rather
     * than here. Missing/unreadable files are skipped with a warn —
     * the caller continues with what's available.
     */
    private collectRevisionFiles(repoPath: string, filePaths: readonly string[]): readonly { path: string; content: string }[] {
        const out: { path: string; content: string }[] = [];
        for (const rel of filePaths) {
            try {
                out.push({ path: rel, content: this.readFile(repoPath, rel) });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.warn({ rel, err: msg }, 'P1-06b: failed to read revision target file');
            }
        }
        return out;
    }

    // ── Dedup-Aware File Writing ────────────────────

    /**
     * Override writeOutputFiles to run dedup checks before writing each file.
     * After all writes, detect and add missing npm dependencies.
     */
    protected async writeOutputFiles(task: TaskInfo, aiOutput: string): Promise<readonly string[]> {
        const allBlocks = parseFileBlocks(aiOutput);

        // Filter out .js duplicates when a .ts version of the same file exists
        // in the same batch. AI sometimes generates both; the .ts is authoritative.
        const tsBasePaths = new Set(
            allBlocks
                .filter(b => b.filePath.endsWith('.ts') || b.filePath.endsWith('.tsx'))
                .map(b => b.filePath.replace(/\.tsx?$/, ''))
        );
        const blocks = allBlocks.filter(b => {
            if (b.filePath.endsWith('.js') || b.filePath.endsWith('.jsx')) {
                const base = b.filePath.replace(/\.jsx?$/, '');
                if (tsBasePaths.has(base)) {
                    this.log.info({ file: b.filePath }, 'Skipping .js duplicate — .ts version exists in batch');
                    return false;
                }
            }
            return true;
        });

        const written: string[] = [];
        const rejected: { path: string; preview: string }[] = [];

        for (const block of blocks) {
            // F-390 (P1-09 hotfix): the same per-block shape guard the base
            // class AutonautAgent.writeOutputFiles applies. Forge's override
            // had silently dropped it when dedup landed, which let the LLM
            // ship literal placeholder strings ("[Full file written above]",
            // "// ...rest of file...", chat summaries) straight into the
            // workspace during /add-requirement revisions taking the legacy
            // P1-06b path (KAGEOPS_FEATURE_REVISIONS unset). Symptom: a
            // 25-byte index.html in Solarsizer-P1-09 smoke (2026-05-24).
            // Reject + log + continue; if every block is rejected we throw
            // below so the task fails loud and Sensei's retry path kicks in.
            if (!isLikelyArtifactContent(block.content, block.filePath)) {
                // BPF-4: non-premium models (Haiku, qwen-coder, kimi) prepend a
                // narration preamble before the real file body. Recover the
                // artifact before treating the block as unrecoverable prose.
                const recovered = recoverArtifactFromNarration(block.content, block.filePath);
                if (recovered === null) {
                    const preview = block.content.replace(/\s+/g, ' ').slice(0, 160);
                    rejected.push({ path: block.filePath, preview });
                    this.log.warn(
                        { taskId: task.id, agent: this.name, filePath: block.filePath, contentLength: block.content.length, preview },
                        'F-390: Forge rejected file block — content does not look like an artifact for its extension (likely stub prose / placeholder)',
                    );
                    continue;
                }
                this.log.info(
                    { taskId: task.id, agent: this.name, filePath: block.filePath, strippedChars: block.content.length - recovered.length },
                    'BPF-4: stripped narration preamble — recovered Forge file block',
                );
                await this.writeFile(task.repoPath, block.filePath, recovered);
                written.push(block.filePath);
                await this.reportProgress(task, `Wrote: ${block.filePath}`);
                continue;
            }

            const dedupResult = this.dedupChecker.checkForDuplicate(
                task.repoPath,
                block.filePath,
                block.content
            );

            if (dedupResult.recommendation === 'skip') {
                this.log.warn(
                    { file: block.filePath, existing: dedupResult.existingPath, similarity: dedupResult.similarity },
                    'Dedup: skipping duplicate file'
                );
                await this.reportProgress(
                    task,
                    `Skipped duplicate: ${block.filePath} (${Math.round(dedupResult.similarity * 100)}% similar to ${dedupResult.existingPath})`
                );
                continue;
            }

            if (dedupResult.recommendation === 'merge' && dedupResult.existingPath !== null) {
                this.log.info(
                    { file: block.filePath, existing: dedupResult.existingPath, similarity: dedupResult.similarity },
                    'Dedup: merging with existing file'
                );
                await this.reportProgress(
                    task,
                    `Merging with existing: ${dedupResult.existingPath} (${Math.round(dedupResult.similarity * 100)}% overlap)`
                );

                const mergedContent = await this.mergeWithExisting(
                    task,
                    block.filePath,
                    block.content,
                    dedupResult.existingPath
                );

                // Write merged content to the existing path (not the new path)
                await this.writeFile(task.repoPath, dedupResult.existingPath, mergedContent);
                written.push(dedupResult.existingPath);
                await this.reportProgress(task, `Wrote (merged): ${dedupResult.existingPath}`);
                continue;
            }

            // recommendation === 'write' — proceed normally
            await this.writeFile(task.repoPath, block.filePath, block.content);
            written.push(block.filePath);
            await this.reportProgress(task, `Wrote: ${block.filePath}`);
        }

        // F-390 (P1-09 hotfix): if Forge produced blocks but EVERY one was
        // rejected as prose/placeholder, surface it as a hard failure so the
        // task enters Sensei's retry path instead of silently shipping zero
        // files. Mirrors AutonautAgent.writeOutputFiles base-class behaviour.
        if (written.length === 0 && rejected.length > 0) {
            const detail = rejected
                .map((r) => `  - ${r.path}: "${r.preview}${r.preview.length >= 160 ? '…' : ''}"`)
                .join('\n');
            throw new Error(
                `F-390: all ${rejected.length} file block(s) produced by forge for task "${task.title}" ` +
                `look like prose/descriptions or placeholders, not real source. No files written. Rejected blocks:\n${detail}\n` +
                `If this is a real artifact in an unusual shape, broaden isLikelyArtifactContent in src/agents/output-parser.ts.`
            );
        }

        // Fallback: write entire output to the task's designated output path —
        // BUT only when the response actually looks like file content. Wave 4
        // Day 2 fix: blindly writing chat-text replies ("All 4 files exist...",
        // "POC landing exists. Reviewed HTML, CSS, JS...") as the artifact was
        // stomping the real index.html and breaking the AcceptanceGate retry
        // loop. If no FILE blocks AND the response looks like prose, skip.
        if (written.length === 0 && task.outputPath !== null) {
            if (looksLikeFileContent(aiOutput, task.outputPath)) {
                await this.writeFile(task.repoPath, task.outputPath, aiOutput);
                written.push(task.outputPath);
            } else {
                this.log.warn(
                    { taskId: task.id, outputPath: task.outputPath, preview: aiOutput.slice(0, 120) },
                    'Skipped writing fallback: response looks like chat text, not file content',
                );
                await this.reportProgress(
                    task,
                    `Skipped writing ${task.outputPath} — response was chat text, not file content. AcceptanceGate will catch the gap.`,
                );
            }
        }

        // B-201 + F-391: Auto-collect files_written evidence with
        // content-aware shape check (catches the prose-stub regression).
        if (written.length > 0) {
            this.collectEvidence(evidenceFromFiles(written, { repoPath: task.repoPath }));
        }

        // Detect and add missing npm dependencies
        this.addMissingDependencies(task.repoPath, written);

        return written;
    }

    // ── Task Implementations ────────────────────────

    /**
     * Dedicated project scaffold handler.
     * Generates package.json, tsconfig.json, .gitignore, entry point, and test setup.
     * Falls back to `npm init -y` if the AI fails to produce a valid package.json.
     */
    private async setupProject(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Setting up project scaffold...');

        const docContext = await this.gatherContext(task);

        if (await this.isStaticHtmlProject(task)) {
            await this.setupStaticHtmlProject(task, docContext);
            return;
        }

        const response = await this.askAI(
            `Set up the project scaffold for:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Generate these files:\n` +
            `1. package.json — name, version, description, scripts (dev, build, test, start), dependencies, devDependencies\n` +
            `2. tsconfig.json — strict TypeScript config targeting ES2022, outDir: "dist"\n` +
            `3. src/index.ts — entry point with a minimal working implementation\n` +
            `4. tests/index.test.ts — at least one passing test that verifies the entry point works\n\n` +
            `Requirements:\n` +
            `- Use modern TypeScript (strict mode)\n` +
            `- Include vitest for testing (use "vitest run --passWithNoTests" as the test script)\n` +
            `- Include a "start" script that runs the app\n` +
            `- Include a "build" script using tsc\n` +
            `- All dependencies must be listed (no missing imports)\n` +
            `- tsconfig.json MUST set "include": ["src"] ONLY. Do NOT include tests/ in tsconfig.\n` +
            `  Set rootDir: "src", outDir: "dist". Tests run via vitest (not tsc).\n` +
            `- Test files (.test.ts) must use "import { describe, it, expect } from 'vitest'" — NOT bare globals.\n` +
            `- Generate .ts test files ONLY — do NOT generate .js duplicates.\n` +
            `- If src/index.ts starts a server (http/express), guard app.listen() with:\n` +
            `  if (require.main === module) { app.listen(PORT, ...) }\n` +
            `  and export the app for tests to import without port conflicts.\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file ---\n` +
            `[file content]\n` +
            `--- END FILE ---\n` +
            `Inside each FILE block emit ONLY the raw file content — no preamble, no explanation, ` +
            `no "I'll…/Let me…/Here's…" narration before the code.`,
            docContext
        );

        const written = await this.writeOutputFiles(task, response.text);

        // Fallback: if AI didn't produce a package.json, run npm init
        const hasPackageJson = written.some(f => f === 'package.json' || f.endsWith('/package.json'));
        if (!hasPackageJson) {
            const pkgPath = path.join(task.repoPath, 'package.json');
            if (!fs.existsSync(pkgPath)) {
                this.log.warn('AI did not generate package.json — running npm init -y as fallback');
                await this.reportProgress(task, 'Fallback: running npm init -y...');
                try {
                    await this.executeCommand(task, 'npm', ['init', '-y']);
                } catch (err) {
                    this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'npm init -y failed');
                }
            }
        }

        await this.ensureDependencies(task);

        const { ok: buildOk, errorOutput: buildErr } = await this.runBuildWithOutput(task);
        const { ok: testsOk, errorOutput: testErr } = await this.runTestsWithOutput(task);

        if (!buildOk || !testsOk) {
            const errors = [buildErr, testErr].filter(Boolean).join('\n\n');
            await this.fixFailures(task, errors || 'Build or tests failed', docContext);
        }

        // Smoke test: verify the app actually starts
        await this.smokeTest(task);

        await this.reportProgress(task, 'Project scaffold created. Committing...');
        await this.gitCommit(task.repoPath, `feat: scaffold project — ${task.title}`);
    }

    private async implementFeature(task: TaskInfo): Promise<void> {
        const docContext = await this.gatherContext(task);
        const graphContext = await this.getCodeGraphMinimalContext(task.repoPath, task.description);
        const filesContext = this.getExistingFilesContext(task.repoPath);
        const context = [docContext, graphContext, filesContext].filter(Boolean).join('\n\n');

        // Static-HTML projects skip the TDD loop — there's no build/test infra
        // and the RED/GREEN/IMPROVE cycle just burns tokens on fake "tests".
        if (await this.isStaticHtmlProject(task)) {
            await this.implementStaticHtmlFeature(task, context);
            return;
        }

        // TDD Phase 1: RED — write failing tests first
        await this.reportProgress(task, 'TDD RED: Writing tests first...');
        const redResponse = await this.askAI(
            buildRedPrompt(task.title, task.description),
            context
        );
        const testCode = extractTestFiles(redResponse.text);
        await this.writeOutputFiles(task, redResponse.text);

        // TDD Phase 2: GREEN — minimal implementation to pass tests
        await this.reportProgress(task, 'TDD GREEN: Implementing to pass tests...');
        const greenResponse = await this.askAI(
            buildGreenPrompt(task.title, task.description, testCode),
            context
        );
        await this.writeOutputFiles(task, greenResponse.text);

        // TDD Phase 3: IMPROVE — refactor keeping tests green
        await this.reportProgress(task, 'TDD IMPROVE: Refactoring...');
        const implCode = extractImplFiles(greenResponse.text);
        const improveResponse = await this.askAI(
            buildImprovePrompt(task.title, implCode, testCode),
            context
        );
        await this.writeOutputFiles(task, improveResponse.text);

        // Verify: install deps, build, test
        await this.ensureDependencies(task);
        const { ok: buildOk, errorOutput: buildErr } = await this.runBuildWithOutput(task);
        const { ok: testsOk, errorOutput: testErr } = await this.runTestsWithOutput(task);

        if (!buildOk || !testsOk) {
            const errors = [buildErr, testErr].filter(Boolean).join('\n\n');
            await this.fixFailures(task, errors || 'Build or tests failed', context);
        }

        await this.reportProgress(task, 'TDD cycle complete. Committing...');
        await this.gitCommit(task.repoPath, `feat: ${task.title}`);
    }

    private async refactorCode(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Analyzing code for refactoring...');

        const response = await this.askAI(
            `Refactor the following based on review feedback:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Requirements:\n` +
            `- Maintain all existing functionality\n` +
            `- Improve code quality and readability\n` +
            `- Update tests if behavior changes\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file.ts ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
        await this.gitCommit(task.repoPath, `refactor: ${task.title}`);
    }

    private async fixBug(task: TaskInfo): Promise<void> {
        const impactContext = await this.getCodeGraphImpactRadius(task.repoPath, task.title, 2);

        // TDD RED: Write regression test first
        await this.reportProgress(task, 'TDD RED: Writing regression test for bug...');
        const redResponse = await this.askAI(
            buildRedPrompt(`Regression test: ${task.title}`, task.description),
            impactContext ?? undefined
        );
        const testCode = extractTestFiles(redResponse.text);
        await this.writeOutputFiles(task, redResponse.text);

        // TDD GREEN: Fix the bug to make test pass
        await this.reportProgress(task, 'TDD GREEN: Fixing bug...');
        const greenResponse = await this.askAI(
            buildGreenPrompt(task.title, task.description, testCode),
            impactContext ?? undefined
        );
        await this.writeOutputFiles(task, greenResponse.text);

        await this.ensureDependencies(task);
        const { ok: bugBuildOk, errorOutput: bugBuildErr } = await this.runBuildWithOutput(task);
        const { ok: bugTestsOk, errorOutput: bugTestErr } = await this.runTestsWithOutput(task);
        if (!bugBuildOk || !bugTestsOk) {
            const errors = [bugBuildErr, bugTestErr].filter(Boolean).join('\n\n');
            await this.fixFailures(task, errors || 'Build or tests failed', impactContext ?? '');
        }

        await this.reportProgress(task, 'Bug fixed with regression test. Committing...');
        await this.gitCommit(task.repoPath, `fix: ${task.title}`);
    }

    private async createApi(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Implementing API endpoints...');

        const context = await this.gatherContext(task);
        const apiFilesCtx = this.getExistingFilesContext(task.repoPath);

        const response = await this.askAI(
            `Implement API endpoints for:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Requirements:\n` +
            `- RESTful design\n` +
            `- Input validation\n` +
            `- Error handling with proper HTTP status codes\n` +
            `- TypeScript types for request/response\n` +
            `- Integration tests\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file.ts ---\n` +
            `[file content]\n` +
            `--- END FILE ---`,
            [context, apiFilesCtx].filter(Boolean).join('\n\n')
        );

        await this.writeOutputFiles(task, response.text);

        await this.ensureDependencies(task);
        const { ok: apiBuildOk, errorOutput: apiBuildErr } = await this.runBuildWithOutput(task);
        const { ok: apiTestsOk, errorOutput: apiTestErr } = await this.runTestsWithOutput(task);
        if (!apiBuildOk || !apiTestsOk) {
            const errors = [apiBuildErr, apiTestErr].filter(Boolean).join('\n\n');
            await this.fixFailures(task, errors || 'Build or tests failed', [context, apiFilesCtx].filter(Boolean).join('\n\n'));
        }

        await this.gitCommit(task.repoPath, `feat: add API — ${task.title}`);
    }

    private async createUi(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Implementing UI components...');
        const uiFilesCtx = this.getExistingFilesContext(task.repoPath);

        // For createUi tasks the project usually already has its own
        // token sheet (React app, Next page, etc.) — only inject the
        // baseline tokens.css if nothing is on disk yet.
        const hasTokenSheet = fs.existsSync(path.join(task.repoPath, 'src', 'tokens.css'))
            || fs.existsSync(path.join(task.repoPath, 'tokens.css'))
            || fs.existsSync(path.join(task.repoPath, 'src', 'styles', 'tokens.css'));
        const designContext = buildDesignContext({ hasTokenSheet });
        const fullContext = [uiFilesCtx, designContext].filter(Boolean).join('\n\n');

        const response = await this.askAI(
            `Implement UI components for:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Requirements:\n` +
            `- Follow the DESIGN DISCIPLINE in the context above (spacing, hairline\n` +
            `  borders, no shadows, no utility soup). COLOURS come from the project\n` +
            `  description above — do NOT use the moss-green / KageOps palette unless\n` +
            `  the description explicitly asks for it. If the description names brand\n` +
            `  colours (hex, named, or a reference site), use those verbatim.\n` +
            `  No Bootstrap, no Tailwind, no Material-UI, no Chakra.\n` +
            `- Clean, responsive HTML/CSS\n` +
            `- TypeScript for interactivity\n` +
            `- Accessible (WCAG 2.1 AA): keyboard reachable, aria-labels on icon buttons,\n` +
            `  prefers-reduced-motion respected\n` +
            `- Component tests\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file.ts ---\n` +
            `[file content]\n` +
            `--- END FILE ---`,
            fullContext
        );

        await this.writeOutputFiles(task, response.text);

        await this.ensureDependencies(task);
        const { ok: uiBuildOk, errorOutput: uiBuildErr } = await this.runBuildWithOutput(task);
        const { ok: uiTestsOk, errorOutput: uiTestErr } = await this.runTestsWithOutput(task);
        if (!uiBuildOk || !uiTestsOk) {
            const errors = [uiBuildErr, uiTestErr].filter(Boolean).join('\n\n');
            await this.fixFailures(task, errors || 'Build or tests failed', uiFilesCtx);
        }

        await this.gitCommit(task.repoPath, `feat: add UI — ${task.title}`);
    }

    private async createMigration(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing database migration...');

        const response = await this.askAI(
            `Write a database migration for:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Requirements:\n` +
            `- Up and down migration SQL\n` +
            `- Idempotent (safe to run multiple times)\n` +
            `- Seed data if applicable\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file.sql ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
        await this.gitCommit(task.repoPath, `feat: add migration — ${task.title}`);
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on: ${task.title}...`);
        const docContext = await this.gatherContext(task);
        const filesCtx = this.getExistingFilesContext(task.repoPath);
        const context = [docContext, filesCtx].filter(Boolean).join('\n\n');

        const response = await this.askAI(
            `Complete the following engineering task:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Write production-ready code with tests.\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file.ts ---\n` +
            `[file content]\n` +
            `--- END FILE ---`,
            context
        );

        await this.writeOutputFiles(task, response.text);

        await this.ensureDependencies(task);
        const { ok: genBuildOk, errorOutput: genBuildErr } = await this.runBuildWithOutput(task);
        const { ok: genTestsOk, errorOutput: genTestErr } = await this.runTestsWithOutput(task);
        if (!genBuildOk || !genTestsOk) {
            const errors = [genBuildErr, genTestErr].filter(Boolean).join('\n\n');
            await this.fixFailures(task, errors || 'Build or tests failed', context);
        }

        await this.gitCommit(task.repoPath, `feat: ${task.title}`);
    }

    // ── Dedup & Dep Helpers ────────────────────────

    /**
     * Ask AI to merge new content with an existing file.
     */
    private async mergeWithExisting(
        task: TaskInfo,
        newFilePath: string,
        newContent: string,
        existingPath: string
    ): Promise<string> {
        let existingContent: string;
        try {
            existingContent = this.readFile(task.repoPath, existingPath);
        } catch {
            return newContent;
        }

        const mergeResponse = await this.askAI(
            `An existing file at "${existingPath}" overlaps with new code intended for "${newFilePath}".\n\n` +
            `Merge the new functionality into the existing file. Keep all existing exports and functionality.\n` +
            `Add only what's genuinely new from the proposed code.\n\n` +
            `--- EXISTING FILE: ${existingPath} ---\n${existingContent}\n--- END ---\n\n` +
            `--- PROPOSED NEW FILE: ${newFilePath} ---\n${newContent}\n--- END ---\n\n` +
            `Output ONLY the merged file content, no file block markers.`
        );

        // Raw text; writeFile will sanitize via sanitizeAgentOutput.
        return mergeResponse.text;
    }

    /**
     * Detect missing npm dependencies in written files and add them to package.json.
     */
    private addMissingDependencies(repoPath: string, writtenFiles: readonly string[]): void {
        try {
            const missingDeps = this.depManager.findMissingDeps(repoPath, writtenFiles);
            if (missingDeps.length > 0) {
                this.depManager.addToPackageJson(repoPath, missingDeps);
                this.log.info(
                    { deps: missingDeps.map(d => d.name) },
                    `Added ${missingDeps.length} missing dependencies to package.json`
                );
            }
        } catch (err) {
            this.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Failed to detect/add missing dependencies'
            );
        }
    }

    // ── Shell Verification ──────────────────────────

    private async ensureDependencies(task: TaskInfo): Promise<void> {
        const pkgPath = path.join(task.repoPath, 'package.json');
        if (!fs.existsSync(pkgPath)) return;

        await this.reportProgress(task, 'Installing dependencies...');
        try {
            // KO-SEC-004/019: --ignore-scripts stops an AI-generated
            // package.json from running arbitrary lifecycle scripts
            // (preinstall/postinstall etc.) unsandboxed on the host.
            await this.executeCommand(task, 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts']);
        } catch (err) {
            this.log.warn({ err }, 'npm install failed — continuing');
        }
    }

    private async runTests(task: TaskInfo): Promise<boolean> {
        return (await this.runTestsWithOutput(task)).ok;
    }

    private async runTestsWithOutput(task: TaskInfo): Promise<{ readonly ok: boolean; readonly errorOutput: string }> {
        const pkgPath = path.join(task.repoPath, 'package.json');
        if (!fs.existsSync(pkgPath)) return { ok: true, errorOutput: '' };

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (!pkg.scripts?.test) return { ok: true, errorOutput: '' };

            await this.reportProgress(task, 'Running tests...');
            // Run tests — avoid passing --passWithNoTests since some package.json
            // test scripts already include it, causing vitest to error on duplicate flags.
            await this.executeCommand(task, 'npm', ['test']);
            return { ok: true, errorOutput: '' };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg }, 'Tests failed');
            return { ok: false, errorOutput: `TEST ERRORS:\n${msg}` };
        }
    }

    private async runBuild(task: TaskInfo): Promise<boolean> {
        return (await this.runBuildWithOutput(task)).ok;
    }

    private async runBuildWithOutput(task: TaskInfo): Promise<{ readonly ok: boolean; readonly errorOutput: string }> {
        const pkgPath = path.join(task.repoPath, 'package.json');
        if (!fs.existsSync(pkgPath)) return { ok: true, errorOutput: '' };

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (!pkg.scripts?.build) return { ok: true, errorOutput: '' };

            await this.reportProgress(task, 'Building project...');
            await this.executeCommand(task, 'npm', ['run', 'build']);
            return { ok: true, errorOutput: '' };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn({ err: msg }, 'Build failed');
            return { ok: false, errorOutput: `BUILD ERRORS:\n${msg}` };
        }
    }

    private async fixFailures(task: TaskInfo, errorOutput: string, context: string): Promise<void> {
        const maxRetries = 1;
        // Need enough runway for one askAI + npm install + build + test + commit.
        const MIN_BUDGET_MS = 360_000;
        let lastErrors = errorOutput;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const remainingMs = this.getTaskRemainingMs();
            if (remainingMs < MIN_BUDGET_MS) {
                this.log.warn(
                    { taskId: task.id, remainingMs },
                    'Skipping fix attempt — insufficient time budget'
                );
                await this.reportProgress(
                    task,
                    `Skipping fix attempt (only ${Math.round(remainingMs / 1000)}s left before task timeout)`
                );
                return;
            }

            await this.reportProgress(task, `Fix attempt ${attempt + 1}/${maxRetries}...`);

            const fixResponse = await this.askAI(
                `The following build/test errors occurred:\n\n${lastErrors}\n\n` +
                `Fix the code to resolve these errors. Only output files that need changes.\n\n` +
                `Output format: For each file, use this format:\n` +
                `--- FILE: path/to/file.ts ---\n` +
                `[file content]\n` +
                `--- END FILE ---`,
                context
            );

            await this.writeOutputFiles(task, fixResponse.text);
            await this.ensureDependencies(task);

            const { ok: buildOk, errorOutput: buildErr } = await this.runBuildWithOutput(task);
            const { ok: testsOk, errorOutput: testErr } = await this.runTestsWithOutput(task);

            if (buildOk && testsOk) return;

            // Feed actual errors into next retry so AI can see what's still broken
            lastErrors = [buildErr, testErr].filter(Boolean).join('\n\n') || 'Build or tests still failing';
        }

        this.log.warn({ taskId: task.id }, 'Could not fix failures after retries');
    }

    /**
     * Smoke test: verify the app starts without crashing.
     * Runs `npm start` (or `node dist/index.js`) with a short timeout.
     * Returns true if the process starts cleanly (exits 0 or stays alive for 5s).
     */
    private async smokeTest(task: TaskInfo): Promise<boolean> {
        const pkgPath = path.join(task.repoPath, 'package.json');
        if (!fs.existsSync(pkgPath)) return true;

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (!pkg.scripts?.start) return true;

            await this.reportProgress(task, 'Smoke test: verifying app starts...');

            // Run with a 10s timeout — we just want to see it doesn't crash on startup
            const result = await this.spawnWithTimeout('npm', ['start'], task.repoPath, 10_000);

            // Exit code 0 = clean exit (CLI apps), timeout kill = stayed alive (servers) — both are ok
            if (result.exitCode === 0 || result.exitCode === null) {
                await this.reportProgress(task, 'Smoke test passed: app starts without errors');
                return true;
            }

            this.log.warn(
                { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
                'Smoke test: app crashed on startup'
            );
            return false;
        } catch (err) {
            // Timeout errors mean the process stayed alive — that's a PASS for a server
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('timed out') || msg.includes('SIGTERM')) {
                await this.reportProgress(task, 'Smoke test passed: app stayed alive for 10s');
                return true;
            }
            this.log.warn({ err: msg }, 'Smoke test failed');
            return false;
        }
    }

    private getExistingFilesContext(repoPath: string): string {
        try {
            const files = this.listFiles(repoPath, '\\.(ts|tsx|js|jsx|json)$');
            if (files.length === 0) return '';
            return `\nExisting project files:\n${files.map(f => `  - ${f}`).join('\n')}\n\nDo NOT create files that duplicate existing ones. Read and extend existing files instead.\n`;
        } catch {
            return '';
        }
    }

    // ── Helpers ──────────────────────────────────────

    private async gatherContext(task: TaskInfo): Promise<string> {
        const contextParts: string[] = [];

        // 1. Read design docs from well-known paths
        const designDocs = ['docs/design/architecture.md', 'docs/design/api-design.md', 'docs/design/database-design.md'];
        for (const doc of designDocs) {
            try {
                const content = this.readFile(task.repoPath, doc);
                contextParts.push(`--- ${doc} ---\n${content}`);
            } catch {
                // File doesn't exist — skip
            }
        }

        // 2. Read completed task outputs from earlier phases (Blueprint, Scout, etc.)
        //    This gives Forge access to architecture decisions, PRDs, research findings.
        try {
            const { query: dbQuery } = await import('../../db/client');
            const priorTasks = await dbQuery<{ output_path: string | null; response_text: string | null; assigned_agent: string; title: string }>(
                `SELECT output_path, response_text, assigned_agent, title
                 FROM tasks
                 WHERE project_id = $1
                   AND status = 'completed'
                   AND assigned_agent IN ('scout', 'blueprint', 'pixel')
                 ORDER BY completed_at DESC
                 LIMIT 3`,
                [task.projectId]
            );

            for (const prior of priorTasks.rows) {
                if (prior.output_path !== null) {
                    try {
                        const content = this.readFile(task.repoPath, prior.output_path);
                        const clipped = content.length > 1500 ? content.slice(0, 1500) + '\n[...]' : content;
                        contextParts.push(`--- ${prior.assigned_agent}: ${prior.title} (${prior.output_path}) ---\n${clipped}`);
                        continue;
                    } catch {
                        // File not found — fall through to response_text
                    }
                }
                if (prior.response_text !== null && prior.response_text.length > 0) {
                    const truncated = prior.response_text.length > 1500
                        ? prior.response_text.slice(0, 1500) + '\n[...]'
                        : prior.response_text;
                    contextParts.push(`--- ${prior.assigned_agent}: ${prior.title} ---\n${truncated}`);
                }
            }
        } catch {
            // DB unavailable — continue without prior task context
        }

        return contextParts.length > 0
            ? `Relevant design documents and prior agent outputs:\n\n${contextParts.join('\n\n')}`
            : '';
    }

    // ── Static-HTML scaffold path ────────────────────

    // ── P2-02: bundle dispatch helpers ─────────────────

    private async getBundleRegistry(): Promise<BundleRegistry> {
        if (this.bundleRegistry !== null) return this.bundleRegistry;
        const result = await loadBundles();
        this.bundleRegistry = new BundleRegistry(result);
        return this.bundleRegistry;
    }

    /**
     * Resolve which bundle (if any) should drive this task. Returns
     * `null` when the inline path should run instead. Active when:
     *   - `KAGEOPS_FEATURE_BUNDLES === 'true'`
     *   - `projects.selected_bundle` is populated (by Scout in P1-12)
     *   - The bundle is a `stack::` bundle other than `vanilla-html`
     *     (vanilla-html stays on the inline path for now; cleanup in
     *     plan decision #3)
     */
    private async resolveBundleHit(task: TaskInfo): Promise<LoadedBundle | null> {
        const registry = await this.getBundleRegistry();
        const resolution = await resolveBundleForProject({
            projectId: task.projectId,
            registry,
        });
        if (resolution.status !== 'hit') return null;
        const bundle = resolution.hit.bundle;
        if (bundle.manifest.kind !== 'stack') return null;
        // Keep vanilla-html on the inline path. Any other stack bundle
        // (nextjs-saas in PR-B; expo, fastapi, ... in Pillar 3) gets the
        // new dispatch.
        if (bundle.manifest.name === 'vanilla-html') return null;
        return bundle;
    }

    private async setupBundleProject(task: TaskInfo, bundle: LoadedBundle): Promise<void> {
        const bundleName = bundle.manifest.name;
        await this.reportProgress(
            task,
            `Bundle "${bundleName}" detected — copying scaffold + rendering setup prompt...`
        );

        // 1. Copy the frozen scaffold into the workspace with {{var}}
        //    substitution applied to text-like files (package.json name,
        //    README title, etc.). `overwrite: true` because the bundle is
        //    authoritative — the workspace-manager generates legacy stubs
        //    (generic package.json with `build: tsc`, empty README) before
        //    the bundle dispatch runs, and `overwrite: false` would defer
        //    to those stubs and skip the bundle's real Next.js configs.
        //
        //    Resume-mid-task safety: P1-01's writeFile checkpoint cache
        //    makes re-writes free for unchanged files, and Forge's
        //    forge_create_ui prompt always runs AFTER scaffold-copy and
        //    can re-emit any brief-specific customizations.
        const copyResult = await copyBundleScaffold({
            bundle,
            destDir: task.repoPath,
            vars: this.bundlePromptVars(task),
            overwrite: true,
        });
        await this.reportProgress(
            task,
            `Scaffold copied: ${copyResult.filesCopied.length} files (${copyResult.filesSkipped.length} skipped — already existed).`
        );

        // 2. Render the bundle's create-ui prompt and ask Forge to fill
        //    in brief-specific content (schema tables, routes, copy).
        const prompt = await renderBundlePrompt(bundle, {
            promptKey: 'forge_create_ui',
            vars: this.bundlePromptVars(task),
        });
        const docContext = await this.gatherContext(task);
        // Inject the Tailwind/shadcn design discipline so brief-specific UI is
        // styled with restraint + a brief-derived palette via the scaffold's
        // globals.css tokens — not generic, ad-hoc-coloured shadcn defaults.
        const designContext = buildBundleDesignContext();
        const fullContext = [docContext, designContext].filter(Boolean).join('\n\n');
        const response = await this.askAI(`${prompt}\n\n${fullContext}`);
        await this.writeOutputFiles(task, response.text);

        // 3. Commit. npm install + build verification is owned by Vigil
        //    in P2-03/PR-C — this PR is the wiring, not the verifier.
        await this.reportProgress(task, `Bundle scaffold + brief-specific content written. Committing...`);
        await this.gitCommit(
            task.repoPath,
            `feat: scaffold ${bundleName} app — ${task.title}`
        );
    }

    private async implementBundleFeature(task: TaskInfo, bundle: LoadedBundle): Promise<void> {
        await this.reportProgress(
            task,
            `Bundle "${bundle.manifest.name}" — implementing feature "${task.title}"...`
        );

        const prompt = await renderBundlePrompt(bundle, {
            promptKey: 'forge_implement_feature',
            vars: this.bundlePromptVars(task),
        });
        const filesContext = this.getExistingFilesContext(task.repoPath);
        const docContext = await this.gatherContext(task);
        // Same design discipline as setupBundleProject so features added later
        // stay visually coherent with the established palette + restraint.
        const designContext = buildBundleDesignContext();
        const context = [docContext, filesContext, designContext].filter(Boolean).join('\n\n');
        const response = await this.askAI(`${prompt}\n\n${context}`);
        await this.writeOutputFiles(task, response.text);

        await this.reportProgress(task, `Feature implemented. Committing...`);
        await this.gitCommit(task.repoPath, `feat: ${task.title}`);
    }

    private bundlePromptVars(task: TaskInfo): Readonly<Record<string, string>> {
        return {
            title: task.title,
            description: task.description,
        };
    }

    private readonly staticHtmlCache = new Map<string, boolean>();

    private async isStaticHtmlProject(task: TaskInfo): Promise<boolean> {
        const cached = this.staticHtmlCache.get(task.projectId);
        if (cached !== undefined) return cached;

        let projectText = '';
        try {
            const result = await query<{ name: string; description: string | null }>(
                'SELECT name, description FROM projects WHERE id = $1',
                [task.projectId]
            );
            const row = result.rows[0];
            if (row !== undefined) {
                projectText = `${row.name} ${row.description ?? ''}`;
            }
        } catch {
            // If DB lookup fails, fall back to task-level heuristic.
        }

        const text = `${projectText} ${task.title} ${task.description}`.toLowerCase();

        // (1) Explicit static-HTML wording in the description.
        const mentionsHtml = text.includes('html');
        const mentionsStatic =
            text.includes('pure html') ||
            text.includes('static site') ||
            text.includes('static html') ||
            text.includes('no framework') ||
            text.includes('no build') ||
            text.includes('vanilla');
        const explicit = mentionsHtml && mentionsStatic;

        // (1b) Broader heuristic: "html" + website/page/blog keywords.
        // A "multi-page HTML/CSS blog website" is static even without
        // "pure"/"static" qualifiers.
        const mentionsWebContent =
            text.includes('website') ||
            text.includes('web page') ||
            text.includes('webpage') ||
            text.includes('blog') ||
            text.includes('landing page') ||
            text.includes('multi-page') ||
            text.includes('clickable') ||
            (text.includes('html') && text.includes('css') && !text.includes('react') && !text.includes('angular') && !text.includes('vue') && !text.includes('svelte'));
        const broadHtml = mentionsHtml && mentionsWebContent && !text.includes('express') && !text.includes('node server') && !text.includes('api endpoint');

        // (2) v1.6: trivial-app patterns (counter/todo/calculator/clock/...)
        // route through the static-HTML path too — no React/Vite/Fastify for
        // a counter. Shared with the decomposer SIMPLE-APP GUARD.
        const simpleApp = detectSimpleApp(text).simple;

        const result = explicit || broadHtml || simpleApp;
        this.staticHtmlCache.set(task.projectId, result);
        return result;
    }

    private async setupStaticHtmlProject(task: TaskInfo, docContext: string): Promise<void> {
        await this.reportProgress(task, 'Static HTML project detected — generating pure HTML/CSS/JS scaffold...');

        // Inject the design discipline pack (spacing/type/no-shadow rules)
        // — colours and brand-specific tokens are derived from the project
        // brief, not from this pack. See design-pack.ts BRAND COLOR POLICY.
        const designContext = buildDesignContext({ hasTokenSheet: false });
        const fullContext = [docContext, designContext].filter(Boolean).join('\n\n');

        const basePrompt =
            `Set up a PURE STATIC HTML project — no Node, no npm, no build step, no test framework.\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Generate EXACTLY these files at the project root (path strings must match exactly — no\n` +
            `subdirectories like \`landing/\` or \`src/\`):\n` +
            `1. \`index.html\` — at the project root. Semantic HTML5. References \`styles.css\` and \`script.js\`\n` +
            `   as siblings (\`<link rel="stylesheet" href="styles.css">\`, \`<script src="script.js">\`).\n` +
            `2. \`styles.css\` — at the project root. Full DESIGN SYSTEM implementation. Use the provided\n` +
            `   tokens.css SKELETON as the structure, but replace every \`TODO_FROM_BRIEF\` value with a\n` +
            `   colour you derive from the project description. The brief is authoritative: if it names\n` +
            `   colours (hex, named, or a reference site), use those verbatim. If the brief is\n` +
            `   colour-silent, fall back to a neutral monochrome (e.g. #0A0A0A bg / #FAFAFA light, warm\n` +
            `   grey #6B6B6B accent) — do NOT default to KageOps moss-green tokens. styles.css MUST NOT\n` +
            `   contain the literal string \`TODO_FROM_BRIEF\` in the output. Implement components using\n` +
            `   var(--accent) etc.\n` +
            `   Minimum 80 lines, every \`{\` matched by \`}\`. No truncation.\n` +
            `   CSS COMPLETENESS (NON-NEGOTIABLE): for EVERY \`class="..."\` value you put in index.html,\n` +
            `   styles.css MUST contain a matching \`.<className> { ... }\` rule. After you draft the HTML,\n` +
            `   list every distinct class name you used and add a rule for each one before you emit\n` +
            `   styles.css. A page that references \`.sigil-card\` or \`.phase-item\` without those rules\n` +
            `   defined will fail acceptance and you will be asked to redo it.\n` +
            `   F-371: CSS MUST live in styles.css — NOT inlined as a giant <style> block inside\n` +
            `   index.html. Even when the design system is large, emit a separate FILE block for\n` +
            `   styles.css. Vigil will reject any index.html whose inline <style> exceeds 40 lines\n` +
            `   when a separate styles.css could have been written instead.\n` +
            `3. \`script.js\` — at the project root. Vanilla ES2022, no modules, no imports. Always\n` +
            `   null-guard DOM lookups: \`document.querySelector('.x')?.addEventListener(...)\`.\n` +
            `4. \`README.md\` — at the project root. How to open (\`npx serve .\` or double-click).\n` +
            `5. If the description mentions MULTIPLE PAGES, additional .html files at the root only,\n` +
            `   never inside a subdirectory.\n\n` +
            `STRUCTURAL CONTENT (NON-NEGOTIABLE):\n` +
            `- Read the description above CAREFULLY. Use the EXACT section IDs, headlines, and components\n` +
            `  it specifies. Do NOT substitute generic SaaS sections like #features / #pricing / #faq\n` +
            `  unless the description explicitly says so.\n` +
            `- If the description lists required <section id="..."> values (e.g. #top, #agents, #how),\n` +
            `  every listed id MUST appear as a top-level <section id="..."> in index.html.\n\n` +
            `Requirements:\n` +
            `- Follow the DESIGN SYSTEM exactly. No Bootstrap, no Tailwind, no CSS frameworks.\n` +
            `- Output RENDERED HTML directly — NOT TypeScript functions that generate HTML.\n` +
            `- Absolutely NO package.json, NO node_modules, NO bundler, NO test framework.\n` +
            `- No external JS dependencies. CSS may use the system font stack.\n` +
            `- Image placeholders: choose the source based on what the image is FOR.\n` +
            `  - PHOTOGRAPHIC content (hero photography, hospitality, lifestyle, product\n` +
            `    shots, food, people, places, anything that would be a real photo on the\n` +
            `    finished site): use Lorem Picsum with a descriptive seed so every render\n` +
            `    is deterministic — e.g. \`https://picsum.photos/seed/tideline-hero/1200/800\`,\n` +
            `    \`https://picsum.photos/seed/garden-suite/800/1000\`. Seed slugs should\n` +
            `    describe the image (kebab-case). NEVER use placehold.co for photographic\n` +
            `    placeholders — grey text-on-grey rectangles destroy the polish of a\n` +
            `    brand-storytelling site and will look unfinished to the operator.\n` +
            `  - DIAGRAMS / charts / abstract blocks where a real photo wouldn't apply\n` +
            `    (architecture diagrams, dashboard screenshots, logo lockups): use\n` +
            `    \`https://placehold.co/\` with a colour scheme that matches the brand palette.\n` +
            `  - If unsure, default to picsum.photos — real photography always reads better\n` +
            `    than \"Tideline+Hotel\" written on a grey rectangle.\n` +
            `- index.html must be self-contained and open directly in a browser.\n` +
            `- Every <link href> and <script src> MUST point to a file you actually emit in this output.\n\n` +
            `Output format (exact — every file as its own block, no nesting):\n` +
            `--- FILE: index.html ---\n` +
            `[full HTML content here]\n` +
            `--- END FILE ---\n` +
            `--- FILE: styles.css ---\n` +
            `[full CSS content here]\n` +
            `--- END FILE ---\n` +
            `(... etc for each file)\n\n` +
            `Do NOT respond conversationally. Do NOT describe what you wrote. ` +
            `Do NOT use \`landing/index.html\` or any subdirectory path — root paths only.`;

        // Wave 4 Day 1: validate the response actually contains FILE blocks
        // and the required files. If not (Claude CLI sometimes returns chat
        // text like "All files are written"), retry with a stricter format
        // prompt before falling through to writeOutputFiles.
        const responseText = await this.generateValidatedFileBlocks(
            task,
            basePrompt,
            fullContext,
            ['index.html', 'styles.css'],
        );

        await this.writeOutputFiles(task, responseText);

        // Skip npm install, build, tests, smoke-test — none apply to a static site.
        await this.reportProgress(task, 'Static scaffold created. Committing...');
        await this.gitCommit(task.repoPath, `feat: scaffold static HTML site — ${task.title}`);
    }

    private async implementStaticHtmlFeature(task: TaskInfo, context: string): Promise<void> {
        await this.reportProgress(task, 'Static HTML feature — single-shot implementation...');

        // If styles.css already exists from the scaffold, skip emitting a
        // tokens block — just remind the model of the rules.
        const hasTokenSheet = fs.existsSync(path.join(task.repoPath, 'styles.css'))
            || fs.existsSync(path.join(task.repoPath, 'tokens.css'));
        const designContext = buildDesignContext({ hasTokenSheet });
        const fullContext = [context, designContext].filter(Boolean).join('\n\n');

        const basePrompt =
            `Implement the following feature for a pure static HTML site.\n\n` +
            `Feature: ${task.title}\n` +
            `Details: ${task.description}\n\n` +
            `Rules:\n` +
            `- Follow the DESIGN DISCIPLINE in the context above (spacing, type, hairline\n` +
            `  borders, no shadows). Keep colours and fonts consistent with what styles.css\n` +
            `  already established for this project from the project brief — do NOT switch\n` +
            `  to KageOps moss-green tokens. No Bootstrap, no Tailwind, no CSS frameworks.\n` +
            `- Create .html, .css, and .js files directly — output RENDERED HTML, not TypeScript functions.\n` +
            `- File paths MUST be at the project ROOT — \`index.html\` not \`landing/index.html\`,\n` +
            `  \`styles.css\` not \`src/styles.css\`. No subdirectories.\n` +
            `- For multi-page sites, create separate .html files at the root\n` +
            `  (e.g., index.html, about.html, tips.html).\n` +
            `- Each .html page must include a consistent navigation bar linking to all other pages.\n` +
            `- Use a shared styles.css linked from every page.\n` +
            `- Image placeholders: choose the source based on what the image is FOR.\n` +
            `  - PHOTOGRAPHIC content (hero photography, hospitality, lifestyle, product\n` +
            `    shots, food, people, places, anything that would be a real photo on the\n` +
            `    finished site): use Lorem Picsum with a descriptive seed so every render\n` +
            `    is deterministic — e.g. \`https://picsum.photos/seed/tideline-hero/1200/800\`,\n` +
            `    \`https://picsum.photos/seed/garden-suite/800/1000\`. Seed slugs should\n` +
            `    describe the image (kebab-case). NEVER use placehold.co for photographic\n` +
            `    placeholders — grey text-on-grey rectangles destroy the polish of a\n` +
            `    brand-storytelling site and will look unfinished to the operator.\n` +
            `  - DIAGRAMS / charts / abstract blocks where a real photo wouldn't apply\n` +
            `    (architecture diagrams, dashboard screenshots, logo lockups): use\n` +
            `    \`https://placehold.co/\` with a colour scheme that matches the brand palette.\n` +
            `  - If unsure, default to picsum.photos — real photography always reads better\n` +
            `    than \"Tideline+Hotel\" written on a grey rectangle.\n` +
            `- No package.json. No npm. No build step. No test framework. No bundler.\n` +
            `- Use vanilla ES2022 JS, no modules, no imports. Always null-guard DOM lookups.\n` +
            `- Preserve existing content: return FULL contents of any file you modify.\n` +
            `- Every <link href> and <script src> MUST resolve to a file you emit or that already exists.\n` +
            `- styles.css MUST be balanced (every \`{\` has a matching \`}\`) — do not truncate.\n` +
            `- CSS COMPLETENESS (NON-NEGOTIABLE): for EVERY \`class="..."\` value you add or change in\n` +
            `  HTML, styles.css MUST contain a matching \`.<className> { ... }\` rule using the locked\n` +
            `  design tokens. If you introduce a new class name, you MUST also re-emit styles.css with\n` +
            `  that rule in the same response. A page with orphan classes fails acceptance.\n\n` +
            `STRUCTURAL CONTENT (NON-NEGOTIABLE):\n` +
            `- Read the Details above CAREFULLY. Use the EXACT section IDs, headlines, and components\n` +
            `  it specifies. Do NOT substitute generic SaaS sections like #features / #pricing / #faq\n` +
            `  unless the description explicitly says so.\n\n` +
            `Output format (exact):\n` +
            `--- FILE: index.html ---\n` +
            `[file content]\n` +
            `--- END FILE ---\n\n` +
            `Do NOT respond conversationally. Do NOT describe what you wrote.`;

        // Wave 4 Day 1: validate the response actually contains FILE blocks
        // before writing. If only chat text comes back, retry with stricter
        // format. For 'feature' tasks any single FILE block satisfies; the
        // missing-required-file check is only applied to setup tasks.
        const responseText = await this.generateValidatedFileBlocks(
            task,
            basePrompt,
            fullContext,
            [], // no specific required files for feature tasks
        );

        await this.writeOutputFiles(task, responseText);

        await this.reportProgress(task, 'Static HTML feature complete. Committing...');
        await this.gitCommit(task.repoPath, `feat: ${task.title}`);
    }

    // ── Wave 4 Day 1: Output sanity check + retry-with-strict-format ──
    //
    // The Claude CLI subprocess sometimes returns conversational text
    // ("All 4 files exist and are complete...") instead of the required
    // `--- FILE: path ---` blocks. Without this guard, Forge silently
    // wrote the chat reply as the artifact, breaking the whole pipeline.
    //
    // Strategy: ask once. If the response has zero FILE blocks (or is
    // missing a required file like styles.css), retry once with a
    // strict reformat-only prompt. After the retry, accept whatever
    // came back — failing the task is worse than partial output, since
    // AcceptanceGate catches the rest downstream.

    private async generateValidatedFileBlocks(
        task: TaskInfo,
        basePrompt: string,
        context: string,
        requiredFiles: readonly string[],
    ): Promise<string> {
        const first = await this.askAI(basePrompt, context);
        const firstCheck = validateFileBlockOutput(first.text, requiredFiles);
        if (firstCheck.valid) {
            return first.text;
        }

        this.log.warn(
            { reason: firstCheck.reason, missingFiles: firstCheck.missingFiles, blockCount: firstCheck.blockCount },
            'Forge response did not contain valid FILE blocks — retrying with strict format prompt',
        );
        await this.reportProgress(
            task,
            `Output missing required files (${firstCheck.missingFiles.join(', ') || 'no FILE blocks'}) — retrying with strict format...`,
        );

        const strictRetryPrompt =
            `Your previous response did not produce the required output. ${firstCheck.reason}\n\n` +
            `You MUST emit each file as a separate block in this EXACT format:\n` +
            `--- FILE: path/to/file ---\n` +
            `[file content here]\n` +
            `--- END FILE ---\n\n` +
            (requiredFiles.length > 0
                ? `Required files (each MUST appear as its own FILE block): ${requiredFiles.join(', ')}\n\n`
                : ``) +
            `Do NOT respond conversationally. Do NOT describe what you wrote. ` +
            `Do NOT claim files exist. Output ONLY the FILE blocks themselves.\n\n` +
            `Re-emit the original task in the correct format:\n\n${basePrompt}`;

        const retry = await this.askAI(strictRetryPrompt, context);
        const retryCheck = validateFileBlockOutput(retry.text, requiredFiles);
        if (!retryCheck.valid) {
            this.log.error(
                { reason: retryCheck.reason, missingFiles: retryCheck.missingFiles },
                'Forge retry STILL did not produce valid FILE blocks — proceeding with whatever was returned (AcceptanceGate will catch downstream)',
            );
            await this.reportProgress(
                task,
                `Strict retry also incomplete (${retryCheck.missingFiles.join(', ') || 'no FILE blocks'}) — relying on AcceptanceGate.`,
            );
        }
        return retry.text;
    }

}

// ── Validation helper ────────────────────────────────────

interface FileBlockValidation {
    readonly valid: boolean;
    readonly reason: string;
    readonly blockCount: number;
    readonly missingFiles: readonly string[];
}

/**
 * Decide whether an AI response is a usable file-block payload.
 *
 * Two failure modes worth catching:
 *   1. Zero FILE blocks (model returned conversational text).
 *   2. Required files (e.g. styles.css) missing from the blocks.
 *
 * Empty `requiredFiles` only checks that AT LEAST ONE block exists —
 * useful for feature tasks where the file set is dynamic.
 */
/**
 * Heuristic: does this response look like raw file content (HTML, CSS,
 * JS, JSON, markdown) rather than a chat-style summary? Used to gate
 * the writeOutputFiles fallback so we don't stomp real artifacts with
 * conversational replies.
 *
 * The check is permissive — we'd rather write occasional borderline
 * prose than skip a legitimate fallback. False negatives (real content
 * skipped) get caught by AcceptanceGate; false positives (chat text
 * written) cascade through the pipeline.
 */
function looksLikeFileContent(text: string, expectedPath: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    const lower = expectedPath.toLowerCase();

    // Code-shaped content for known suffixes.
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        // Real HTML almost always has at least one tag in the first 500 chars.
        const head = trimmed.slice(0, 500);
        return /<\s*(html|head|body|div|section|nav|main|header|footer|h[1-6]|p|a|script|link|meta|!doctype)\b/i.test(head);
    }
    if (lower.endsWith('.css')) {
        return /\{|\}|@import|@media|@font-face|--[a-z]/i.test(trimmed);
    }
    if (lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
        return /\b(function|const|let|var|class|import|export|=>)\b/.test(trimmed);
    }
    if (lower.endsWith('.json')) {
        const head = trimmed.slice(0, 5);
        return head.startsWith('{') || head.startsWith('[');
    }
    if (lower.endsWith('.md')) {
        // Markdown is hard to discriminate. Accept anything that starts
        // with markdown-shaped headings / lists or is long enough to be
        // genuinely a doc, not a one-line "done." chat reply.
        if (/^(#|\*|-|\d+\.|>|`)/m.test(trimmed)) return true;
        return trimmed.length > 200;
    }

    // Unknown suffix: only reject obvious chat-summary leads.
    const firstLine = trimmed.split(/\r?\n/, 1)[0].toLowerCase();
    const chatLeads = [
        'done.',
        'all ',
        'i\'ve ',
        'i have ',
        'here is',
        'here are',
        'context gathered',
        'reviewed ',
        'poc landing',
        'looks good',
        'task complete',
    ];
    return !chatLeads.some((lead) => firstLine.startsWith(lead));
}

function validateFileBlockOutput(
    text: string,
    requiredFiles: readonly string[],
): FileBlockValidation {
    const blocks: readonly FileBlock[] = parseFileBlocks(text);

    if (blocks.length === 0) {
        return {
            valid: false,
            reason: 'Response contained no `--- FILE: ... ---` blocks (model likely returned conversational text instead of file emissions).',
            blockCount: 0,
            missingFiles: [...requiredFiles],
        };
    }

    if (requiredFiles.length === 0) {
        return { valid: true, reason: '', blockCount: blocks.length, missingFiles: [] };
    }

    const emittedPaths = new Set(
        blocks.map((b) => b.filePath.toLowerCase().replace(/\\/g, '/')),
    );
    const missing: string[] = [];
    for (const required of requiredFiles) {
        const normalized = required.toLowerCase().replace(/\\/g, '/');
        if (!emittedPaths.has(normalized)) missing.push(required);
    }

    if (missing.length > 0) {
        return {
            valid: false,
            reason: `Response is missing required file blocks: ${missing.join(', ')}.`,
            blockCount: blocks.length,
            missingFiles: missing,
        };
    }

    return { valid: true, reason: '', blockCount: blocks.length, missingFiles: [] };
}
