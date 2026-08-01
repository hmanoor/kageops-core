/**
 * KageOps Template Cloner
 *
 * Clones the golden template directory into a new project directory,
 * customizes project metadata, and initializes a git repository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { gitIdentityArgs } from '../shared/git-config';
import { createLogger } from '../shared/logger';
import {
    streamSubprocessOutput,
    type SubprocessEventPublisher,
} from './subprocess-stream';

const log = createLogger('TemplateCloner');

// ── Types ────────────────────────────────────────────

export interface ProjectConfig {
    readonly name: string;
    readonly description: string;
    readonly trustLevel: string;
}

/**
 * Optional context to wire git stdout/stderr into the Agent Terminal panel
 * via the `subprocess.output` event bus channel. Both fields must be
 * present to enable streaming; otherwise `cloneTemplate` falls back to
 * the original `execSync` path silently.
 */
export interface CloneTemplateStreamContext {
    readonly bus: SubprocessEventPublisher;
    readonly projectId: string;
}

// ── Public API ───────────────────────────────────────

/**
 * Clone a golden template into a new project directory.
 *
 * Steps:
 * 1. Verify template exists
 * 2. Verify target does not exist (prevent overwriting)
 * 3. Recursively copy template → target
 * 4. Customize project.json with provided config
 * 5. Customize README.md with project name/description
 * 6. Initialize git repo
 */
export async function cloneTemplate(
    templatePath: string,
    targetPath: string,
    config: ProjectConfig,
    streamCtx?: CloneTemplateStreamContext,
): Promise<void> {
    // 1. Validate template exists
    if (!fs.existsSync(templatePath)) {
        throw new Error(
            `[TemplateCloner] Template directory not found: ${templatePath}`
        );
    }

    // 2. Validate target does not exist
    if (fs.existsSync(targetPath)) {
        throw new Error(
            `[TemplateCloner] Target directory already exists: ${targetPath}`
        );
    }

    // 3. Recursively copy template → target
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.cpSync(templatePath, targetPath, { recursive: true });
    log.info({ targetPath }, 'Copied template');

    // 4. Customize project.json
    const projectJsonPath = path.join(targetPath, '.autonauts', 'project.json');
    if (fs.existsSync(projectJsonPath)) {
        const raw = fs.readFileSync(projectJsonPath, 'utf-8');
        const projectJson = JSON.parse(raw) as Record<string, unknown>;
        const updated = {
            ...projectJson,
            name: config.name,
            description: config.description,
            trustLevel: config.trustLevel,
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(projectJsonPath, JSON.stringify(updated, null, 2), 'utf-8');
        log.info('Customized project.json');
    }

    // 5. Customize README.md
    const readmePath = path.join(targetPath, 'README.md');
    if (fs.existsSync(readmePath)) {
        const readme = [
            `# ${config.name}`,
            '',
            config.description,
            '',
            '---',
            '',
            'Created by [KageOps](https://kageops.ai)',
        ].join('\n');
        fs.writeFileSync(readmePath, readme, 'utf-8');
        log.info('Customized README.md');
    }

    // 6. Initialize git repo
    try {
        if (streamCtx !== undefined) {
            // Streamed path: spawn so the Agent Terminal panel receives
            // each git stdout/stderr chunk live via the event bus.
            await runGitStreamed(targetPath, ['init'], streamCtx);
            await runGitStreamed(targetPath, ['add', '.'], streamCtx);
            await runGitStreamed(
                targetPath,
                [...gitIdentityArgs(), 'commit', '-m', 'Initial project setup via KageOps'],
                streamCtx,
            );
        } else {
            // Legacy synchronous path — preserved for callers that don't
            // care about live tailing (e.g. tests, CLI bootstrap).
            execSync('git init', { cwd: targetPath, stdio: 'pipe' });
            execSync('git add .', { cwd: targetPath, stdio: 'pipe' });
            // Identity pinned per-invocation: inheriting the developer's
            // global config attributed machine commits to the human, and
            // failed outright where no global identity was configured.
            execSync(
                `git ${gitIdentityArgs().join(' ')} commit -m "Initial project setup via KageOps"`,
                { cwd: targetPath, stdio: 'pipe' }
            );
        }
        log.info('Initialized git repository');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'Git init failed (git may not be installed)');
        // Non-fatal — directory is still usable without git
    }
}

function runGitStreamed(
    cwd: string,
    args: readonly string[],
    streamCtx: CloneTemplateStreamContext,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const stop = streamSubprocessOutput(proc, streamCtx.bus, {
            projectId: streamCtx.projectId,
            source: 'template-cloner',
            agent: 'system',
        });
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            stop();
            if (code === 0) resolve();
            else reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
        });
        proc.on('error', (err) => {
            stop();
            reject(err);
        });
    });
}

/**
 * Get the default template directory path.
 * Resolves relative to the project root (works in both src/ and dist/ contexts).
 */
export function getDefaultTemplatePath(): string {
    // Try dist location first, then src location
    const distPath = path.resolve(__dirname, '..', '..', 'templates', 'default');
    if (fs.existsSync(distPath)) {
        return distPath;
    }

    const srcPath = path.resolve(__dirname, '..', '..', '..', 'templates', 'default');
    if (fs.existsSync(srcPath)) {
        return srcPath;
    }

    // Fallback: project root relative
    return path.resolve(process.cwd(), 'templates', 'default');
}
