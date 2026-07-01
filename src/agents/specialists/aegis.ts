/**
 * Aegis — Platform Engineer Agent
 *
 * Handles DevOps, Docker, Terraform, CI/CD, deployment,
 * monitoring, and security hardening.
 */

import { spawn } from 'child_process';
import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import { query } from '../../db/client';
import { loadVercelToken, runDeploy } from '../../deployers/vercel-deployer';
import {
    detectMigrationIntent,
    runDrizzlePush,
    type MigrationIntent,
} from '../../deployers/drizzle-migrator';
import { getSecret } from '../../main/secret-store';
import { type PostDeployHook, noopPostDeployHook } from '../post-deploy-hook';

// ── Constants ────────────────────────────────────────

const AEGIS_SKILLS = [
    'docker',
    'terraform-iac',
    'ci-cd',
    'github-actions',
    'azure',
    'kubernetes',
    'monitoring',
    'networking',
    'security-hardening',
    'deployment',
] as const;

const SYSTEM_PROMPT =
    'You are Aegis, a platform engineer and guardian of infrastructure. You build reliable, ' +
    'secure, automated deployment pipelines. You automate everything and trust nothing without ' +
    'verification. Your configs are well-commented and follow infrastructure-as-code best practices.';

// ── Aegis Agent ──────────────────────────────────────

export class Aegis extends AutonautAgent {
    private readonly postDeployHook: PostDeployHook;

    constructor(
        modelConfig: AgentModelConfig,
        postDeployHook: PostDeployHook = noopPostDeployHook,
    ) {
        super('aegis', 'platform-engineer', AEGIS_SKILLS, modelConfig, SYSTEM_PROMPT);
        this.postDeployHook = postDeployHook;
    }

    async executeTask(task: TaskInfo): Promise<void> {
        switch (task.taskType) {
            case 'setup-cicd':
                await this.setupCicd(task);
                break;
            case 'dockerfile':
                await this.writeDockerfile(task);
                break;
            case 'terraform':
                await this.writeTerraform(task);
                break;
            case 'deploy-staging':
                await this.deployStagingPlan(task);
                break;
            case 'deploy-production':
                await this.deployProductionPlan(task);
                break;
            case 'setup-monitoring':
                await this.setupMonitoring(task);
                break;
            case 'security-hardening':
                await this.hardenInfra(task);
                break;
            case 'trigger-workflow':
                await this.triggerGitHubWorkflow(task);
                break;
            case 'deploy-preview':
                // P2-04: route nextjs-saas (and any future bundle that opts in)
                // to Vercel's preview channel via vercel-deployer.
                await this.deployPreview(task);
                break;
            default:
                await this.handleGenericTask(task);
                break;
        }
    }

    /**
     * P2-04: ship the project workspace to Vercel as a preview deployment.
     * Token resolution is layered (env > keychain > ~/.vercel/auth.json).
     * Preview URL persists to projects.preview_url so AcceptanceGate v2
     * (PR-E) can read it for the build-tests-preview gate.
     */
    private async deployPreview(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Vercel preview: resolving token + invoking vercel deploy --prebuilt...');

        const tokenSource = await loadVercelToken({
            getKeychainSecret: (service, account) => getSecret(service, account),
        });

        if (tokenSource === null) {
            const message =
                'Vercel token not found in env (KAGEOPS_VERCEL_TOKEN), OS keychain, or ' +
                '~/.vercel/auth.json. Paste a token in the New-Project modal (Pillar 2.2) ' +
                'or set KAGEOPS_VERCEL_TOKEN for CI.';
            await this.reportProgress(task, `Deploy aborted: ${message}`);
            throw new Error(message);
        }

        // Pillar 2.2 / PR-D — load per-project secrets from the
        // encrypted store so the deployed site has runtime env (Clerk,
        // Neon, Stripe). Empty/missing → no --env flags; deploy still
        // proceeds but the preview page may crash at first request.
        // That's the D-B "skip-for-now" behaviour — operator can fix
        // by reopening the modal and saving.
        let runtimeEnv: Record<string, string> | undefined;
        try {
            const { readDeploymentEnv } = await import('../../orchestrator/materialize-deployment-env');
            const values = await readDeploymentEnv(task.projectId);
            if (values !== null && Object.keys(values).length > 0) {
                runtimeEnv = { ...values };
                await this.reportProgress(
                    task,
                    `Vercel preview: forwarding ${Object.keys(values).length} env var(s) from deployment_config.`
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.reportProgress(
                task,
                `Vercel preview: deployment_config unreadable (${msg}) — deploying without --env flags.`
            );
        }

        // P2.3-02 — push Drizzle migrations to the live DB BEFORE
        // shipping the build to Vercel. Without this, the nextjs-saas
        // bundle deploys cleanly but `/dashboard` 500s on first SELECT
        // because the tables Forge declared in `drizzle/*.sql` were
        // never applied (FleetPulse smoke 2026-05-31, Bug #8).
        const databaseUrl = runtimeEnv?.['DATABASE_URL'];
        if (databaseUrl !== undefined && databaseUrl.length > 0) {
            const intent = await detectMigrationIntent(task.repoPath);
            if (intent.kind !== 'none') {
                await this.reportProgress(
                    task,
                    `Drizzle: ${describeIntent(intent)} — pushing schema to live DB before deploy...`
                );
                const push = await runDrizzlePush(
                    { cwd: task.repoPath, databaseUrl },
                    (cmd, args, opts) => spawn(cmd, [...args], opts) as never
                );
                if (push.status !== 'pushed') {
                    const tail = (push.stderr || push.stdout).trim().slice(-1000);
                    await this.reportProgress(
                        task,
                        `Drizzle push failed (exit ${push.exitCode ?? 'null'}) — aborting deploy.`
                    );
                    throw new Error(`drizzle-kit push failed: ${tail || 'no output'}`);
                }
                await this.reportProgress(
                    task,
                    `Drizzle: schema pushed (${push.durationMs}ms). Proceeding with vercel deploy.`
                );
            }
        }

        // BPF-13: when the operator has a Vercel team/username, pass it as
        // `--scope` so the CLI never has to interactively resolve teams for a
        // first/unlinked deploy (the "Loading teams…" hang). Unset → unchanged
        // behaviour, now backed by the runDeploy timeout.
        const scope = process.env.KAGEOPS_VERCEL_SCOPE;
        const result = await runDeploy(
            {
                cwd: task.repoPath,
                token: tokenSource,
                runtimeEnv,
                ...(scope !== undefined && scope.length > 0 ? { scope } : {}),
            },
            (cmd, args, opts) => spawn(cmd, [...args], opts) as never
        );

        if (result.status !== 'success' || result.previewUrl === undefined) {
            const tail = (result.stderr || result.stdout).trim().slice(-1000);
            await this.reportProgress(task, `Vercel deploy failed (exit ${result.exitCode ?? 'null'}).`);
            throw new Error(`vercel deploy failed: ${tail || 'no output'}`);
        }

        await query(
            'UPDATE projects SET preview_url = $1 WHERE id = $2',
            [result.previewUrl, task.projectId]
        );

        await this.reportProgress(
            task,
            `Vercel preview live at ${result.previewUrl} (token from ${tokenSource.origin}, ${result.durationMs}ms).`
        );

        // MCC-8 / Slice 5 — late-bound Stripe webhook. With KAGEOPS_AUTO_PROVISION
        // on, register the webhook + capture its signing secret hands-free now that
        // we have a deployed URL (test-mode only). Default OFF → the credential
        // ledger surfaces it as a one-click action instead. Never fails the deploy.
        await this.maybeAutoRegisterStripeWebhook(task, result.previewUrl, runtimeEnv);
    }

    /** Post-deploy webhook auto-registration (opt-in, test-mode). Never throws. */
    private async maybeAutoRegisterStripeWebhook(
        task: TaskInfo,
        previewUrl: string,
        runtimeEnv: Record<string, string> | undefined
    ): Promise<void> {
        // Commercial post-deploy provisioning (Stripe webhook auto-register) is
        // injected via the PostDeployHook seam; the open core uses the no-op.
        const note = await this.postDeployHook.onDeployed({
            projectId: task.projectId,
            deployedUrl: previewUrl,
            runtimeEnv,
        });
        if (note !== null) {
            await this.reportProgress(task, note);
        }
    }

    private async setupCicd(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Creating CI/CD pipeline...');

        const response = await this.askAI(
            `Create a GitHub Actions CI/CD workflow for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Build job (install deps, compile, verify clean build)\n` +
            `2. Test job (run test suite, report coverage)\n` +
            `3. Lint job (ESLint + Prettier check)\n` +
            `4. Security scan job (dependency audit)\n` +
            `5. Deploy job (staging on merge to main, prod on release tag)\n\n` +
            `Requirements:\n` +
            `- Node 20, ubuntu-latest\n` +
            `- Caching for node_modules\n` +
            `- Parallel jobs where possible\n` +
            `- Status badges\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: .github/workflows/ci.yml ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
        await this.gitCommit(task.repoPath, `ci: add GitHub Actions CI/CD pipeline`);
    }

    private async writeDockerfile(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing Dockerfiles...');

        const response = await this.askAI(
            `Write Dockerfiles for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Requirements:\n` +
            `- Multi-stage build (builder + production)\n` +
            `- Minimal final image (node:20-slim or alpine)\n` +
            `- Non-root user\n` +
            `- Health check\n` +
            `- .dockerignore\n` +
            `- docker-compose.yml for local development\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: Dockerfile ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
        await this.gitCommit(task.repoPath, `infra: add Docker configuration`);
    }

    private async writeTerraform(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing Terraform/Bicep infrastructure code...');

        const response = await this.askAI(
            `Write Terraform infrastructure for Azure:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Resource group\n` +
            `2. Container instances (ACI) for the app\n` +
            `3. Azure Database for PostgreSQL Flexible Server\n` +
            `4. Key Vault for secrets\n` +
            `5. Storage account\n` +
            `6. Networking (VNet, subnets)\n` +
            `7. Variables and outputs\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: infra/terraform/main.tf ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
        await this.gitCommit(task.repoPath, `infra: add Terraform configuration`);
    }

    private async deployStagingPlan(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Creating staging deployment plan...');

        const response = await this.askAI(
            `Create a staging deployment plan for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Pre-deployment checklist\n` +
            `2. Deployment steps\n` +
            `3. Smoke tests to run after deploy\n` +
            `4. Rollback procedure\n` +
            `5. Monitoring during deployment`
        );

        const outputPath = task.outputPath ?? 'docs/deployment/staging-plan.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async deployProductionPlan(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Creating production deployment plan...');

        const response = await this.askAI(
            `Create a production deployment plan for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Pre-deployment checklist (comprehensive)\n` +
            `2. Blue/green or rolling deployment strategy\n` +
            `3. Database migration steps\n` +
            `4. Feature flags\n` +
            `5. Post-deployment verification\n` +
            `6. Rollback procedure\n` +
            `7. Communication plan (who to notify)`
        );

        const outputPath = task.outputPath ?? 'docs/deployment/production-plan.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async setupMonitoring(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Setting up monitoring and alerting...');

        const response = await this.askAI(
            `Set up monitoring for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Health check endpoints\n` +
            `2. Application metrics (latency, errors, throughput)\n` +
            `3. Infrastructure metrics (CPU, memory, disk)\n` +
            `4. Alert rules (critical, warning)\n` +
            `5. Dashboard configuration\n` +
            `6. Log aggregation setup\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
    }

    private async hardenInfra(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Hardening infrastructure security...');

        const response = await this.askAI(
            `Review and harden infrastructure for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Check and fix:\n` +
            `1. Network policies (least privilege)\n` +
            `2. Secret rotation\n` +
            `3. Container security (non-root, read-only fs, no cap)\n` +
            `4. TLS/SSL configuration\n` +
            `5. RBAC policies\n` +
            `6. Backup strategy\n` +
            `7. Disaster recovery plan`
        );

        const outputPath = task.outputPath ?? 'docs/security/infrastructure-hardening.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on: ${task.title}...`);

        const response = await this.askAI(
            `Complete the following infrastructure task:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Output well-structured infrastructure code or documentation.`
        );

        const outputPath = task.outputPath ?? `infra/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    /**
     * Trigger a GitHub Actions workflow_dispatch run (v0.9).
     * Task description format: "workflow: <filename> ref: <branch> [input.key=value ...]"
     * Falls back to AI interpretation if format is not parseable.
     */
    private async triggerGitHubWorkflow(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Triggering GitHub Actions workflow...');

        const client = this.githubClient;
        if (client === null) {
            await this.reportProgress(task, 'GitHub client not configured — skipping workflow dispatch');
            return;
        }

        // Load project GitHub config
        const projectRows = await query<{ github_owner: string | null; github_repo: string | null }>(
            'SELECT github_owner, github_repo FROM projects WHERE id = $1',
            [task.projectId]
        );
        if (projectRows.rows.length === 0) return;

        const { github_owner, github_repo } = projectRows.rows[0];
        if (github_owner === null || github_repo === null) {
            await this.reportProgress(task, 'No GitHub repo configured for this project');
            return;
        }

        // Parse workflow params from description
        const parsed = parseWorkflowDispatchParams(task.description);
        if (parsed === null) {
            await this.reportProgress(task, 'Could not parse workflow dispatch params from task description');
            return;
        }

        const { getApiKey } = await import('../../main/secret-store');
        const token = await getApiKey('github');
        if (token === null) {
            await this.reportProgress(task, 'GitHub token not configured');
            return;
        }

        await client.triggerWorkflowDispatch({
            config: { owner: github_owner, repo: github_repo, token },
            workflowId: parsed.workflowId,
            ref: parsed.ref,
            inputs: parsed.inputs,
        });

        await this.reportProgress(task, `Triggered workflow '${parsed.workflowId}' on ref '${parsed.ref}'`);
    }
}

// ── Helpers ───────────────────────────────────────────

function describeIntent(intent: MigrationIntent): string {
    if (intent.kind === 'sql-files') {
        return `${intent.count} migration file${intent.count === 1 ? '' : 's'} in ${intent.directory}`;
    }
    if (intent.kind === 'db-push-script') {
        return `db:push script (${intent.script})`;
    }
    return 'no migration intent';
}

interface WorkflowParams {
    readonly workflowId: string;
    readonly ref: string;
    readonly inputs: Record<string, string>;
}

/**
 * Parse "workflow: deploy.yml ref: main input.env=staging" from a task description.
 * Returns null if required fields are missing.
 */
function parseWorkflowDispatchParams(description: string): WorkflowParams | null {
    const workflowMatch = description.match(/workflow:\s*(\S+)/i);
    const refMatch = description.match(/ref:\s*(\S+)/i);

    if (workflowMatch === null || refMatch === null) return null;

    const inputs: Record<string, string> = {};
    const inputMatches = description.matchAll(/input\.(\w+)=(\S+)/gi);
    for (const match of inputMatches) {
        inputs[match[1]] = match[2];
    }

    return {
        workflowId: workflowMatch[1],
        ref: refMatch[1],
        inputs,
    };
}
