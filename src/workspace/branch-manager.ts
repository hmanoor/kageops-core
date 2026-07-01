/**
 * KageOps Branch Manager
 *
 * Manages git branches for task isolation.
 * Each agent task works on its own branch; Sensei merges after review.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withRepoLock } from './repo-lock';

// ── Types ────────────────────────────────────────────

export interface MergeResult {
    readonly success: boolean;
    readonly conflicted: boolean;
    readonly mergeCommit: string | null;
}

// ── Branch Manager ───────────────────────────────────

export class BranchManager {

    /**
     * Create a new task branch and check it out.
     * Branch naming convention: agent/<agentName>/<taskId-first-8-chars>
     *
     * @returns The branch name that was created
     */
    async createTaskBranch(
        repoPath: string,
        taskId: string,
        agentName: string
    ): Promise<string> {
        const branchName = this.buildBranchName(taskId, agentName);

        // Clean up stale index.lock before any git operation
        this.cleanIndexLock(repoPath);

        // Ensure we're on the repo's default branch before branching.
        const defaultBranch = await this.getDefaultBranch(repoPath);
        if (defaultBranch !== null) {
            await this.runGit(repoPath, ['checkout', defaultBranch]);
        }
        // If no default branch exists yet (fresh repo with no commits), stay
        // wherever we are — `checkout -b` will create the branch from HEAD.

        await this.runGit(repoPath, ['checkout', '-b', branchName]);

        return branchName;
    }

    /**
     * Remove stale .git/index.lock if it exists.
     * This is safe because we only call it before starting a NEW operation.
     */
    private cleanIndexLock(repoPath: string): void {
        const lockFile = path.join(repoPath, '.git', 'index.lock');
        try {
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
            }
        } catch {
            // Best effort — if we can't remove it, git will fail and the caller handles it
        }
    }

    /**
     * Switch to an existing branch.
     */
    async switchBranch(repoPath: string, branchName: string): Promise<void> {
        await this.runGit(repoPath, ['checkout', branchName]);
    }

    /**
     * Get the currently checked-out branch name.
     */
    async getCurrentBranch(repoPath: string): Promise<string> {
        const output = await this.runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        return output.trim();
    }

    /**
     * Merge a branch into main using fast-forward when possible.
     * Returns a MergeResult indicating success, conflict, or merge commit.
     */
    async mergeBranch(
        repoPath: string,
        branchName: string,
        commitMessage: string
    ): Promise<MergeResult> {
        // Switch to the repo's default branch (main, master, or fall back
        // to the merge target's parent if neither exists).
        const defaultBranch = await this.getDefaultBranch(repoPath);
        if (defaultBranch === null) {
            return { success: false, conflicted: false, mergeCommit: null };
        }
        await this.runGit(repoPath, ['checkout', defaultBranch]);

        try {
            // Try fast-forward first
            await this.runGit(repoPath, ['merge', '--ff-only', branchName]);

            // Get the merge commit hash
            const mergeCommit = await this.runGit(repoPath, ['rev-parse', 'HEAD']);

            return {
                success: true,
                conflicted: false,
                mergeCommit: mergeCommit.trim(),
            };
        } catch {
            // Fast-forward failed — try regular merge
            try {
                await this.runGit(repoPath, ['merge', branchName, '-m', commitMessage]);

                const mergeCommit = await this.runGit(repoPath, ['rev-parse', 'HEAD']);

                return {
                    success: true,
                    conflicted: false,
                    mergeCommit: mergeCommit.trim(),
                };
            } catch (mergeErr) {
                // Merge failed — check if it's a conflict
                // Git merge conflicts exit with code 1 and leave merge state
                // Abort and report conflict
                try {
                    await this.runGit(repoPath, ['merge', '--abort']);
                } catch {
                    // merge --abort can fail if no merge in progress
                }

                return {
                    success: false,
                    conflicted: true,
                    mergeCommit: null,
                };
            }
        }
    }

    /**
     * Delete a branch (local only).
     */
    async deleteBranch(repoPath: string, branchName: string): Promise<void> {
        // Ensure we're not on the branch we're deleting
        const current = await this.getCurrentBranch(repoPath);
        if (current === branchName) {
            const defaultBranch = await this.getDefaultBranch(repoPath);
            if (defaultBranch !== null) {
                await this.runGit(repoPath, ['checkout', defaultBranch]);
            }
        }

        await this.runGit(repoPath, ['branch', '-d', branchName]);
    }

    /**
     * Check if a branch exists locally.
     */
    async branchExists(repoPath: string, branchName: string): Promise<boolean> {
        try {
            await this.runGit(repoPath, ['rev-parse', '--verify', branchName]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create or move a tag at the given ref (default HEAD). Force-updated
     * so callers can use a fixed tag name as a "best-known-good" pointer
     * that walks forward as the artifact improves.
     *
     * Used by the acceptance-snapshot path (see Sensei.maybeSnapshotBest):
     * each time an acceptance retry produces fewer violations than the
     * prior best, we snap the tag to HEAD. On retry-cap exhaustion the
     * caller can checkout this tag to recover the best version instead
     * of the last (potentially worse) attempt.
     */
    async createTag(
        repoPath: string,
        tagName: string,
        ref: string = 'HEAD',
    ): Promise<void> {
        await this.runGit(repoPath, ['tag', '-f', tagName, ref]);
    }

    /**
     * Check if a tag exists locally. Mirrors branchExists.
     */
    async tagExists(repoPath: string, tagName: string): Promise<boolean> {
        try {
            await this.runGit(repoPath, ['rev-parse', '--verify', `refs/tags/${tagName}`]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check out a tag (detaches HEAD). Used to restore the best-known
     * acceptance state on retry exhaustion.
     */
    async checkoutTag(repoPath: string, tagName: string): Promise<void> {
        await this.runGit(repoPath, ['checkout', tagName]);
    }

    /**
     * Build a branch name from task ID and agent name.
     * Convention: agent/<agentName>/<first-8-chars-of-taskId>
     */
    buildBranchName(taskId: string, agentName: string): string {
        const cleaned = taskId.toLowerCase().replace(/[^a-z0-9]/g, '');
        const shortId = cleaned.slice(0, 8);
        return `agent/${agentName}/${shortId}`;
    }

    /**
     * Return the repo's default integration branch — `main` if it exists,
     * otherwise `master`, otherwise null (fresh repo with no commits).
     */
    async getDefaultBranch(repoPath: string): Promise<string | null> {
        if (await this.branchExists(repoPath, 'main')) return 'main';
        if (await this.branchExists(repoPath, 'master')) return 'master';
        return null;
    }

    // ── Private ──────────────────────────────────────

    private runGit(repoPath: string, args: readonly string[]): Promise<string> {
        return withRepoLock(repoPath, () => this.runGitUnlocked(repoPath, args));
    }

    private runGitUnlocked(repoPath: string, args: readonly string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const proc = spawn('git', [...args], {
                cwd: repoPath,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: isWindows,
                // Suppress the cmd.exe console window that would otherwise
                // flash on every git invocation during agent task dispatch
                // (per-task branch creation, commits, merges). Dozens fire
                // per project run; without this the screen is unusable.
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
                }
            });

            proc.on('error', reject);
        });
    }
}
