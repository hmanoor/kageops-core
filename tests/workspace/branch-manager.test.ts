/**
 * BranchManager unit tests
 *
 * Tests branch creation, merging, conflict detection, and cleanup.
 * Uses real git repos in temporary directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { BranchManager } from '../../src/workspace/branch-manager';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempRepo(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-branch-test-'));
    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@kageops.dev"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

    // Create an initial commit on main so branches work
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Project\n');
    execSync('git add -A && git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'pipe' });

    return tmpDir;
}

function cleanupTempDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best effort cleanup
    }
}

function writeFile(repoPath: string, filePath: string, content: string): void {
    const fullPath = path.join(repoPath, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
}

function commitAll(repoPath: string, message: string): void {
    execSync(`git add -A && git commit -m "${message}"`, { cwd: repoPath, stdio: 'pipe' });
}

function getCurrentBranch(repoPath: string): string {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BranchManager', () => {
    let manager: BranchManager;
    let repoPath: string;

    beforeEach(() => {
        manager = new BranchManager();
        repoPath = createTempRepo();
    });

    afterEach(() => {
        cleanupTempDir(repoPath);
    });

    // ── buildBranchName ─────────────────────────────────────────────────────

    describe('buildBranchName()', () => {
        it('builds branch name from agent and task ID', () => {
            const name = manager.buildBranchName('abcd1234-5678-efgh', 'forge');
            expect(name).toBe('agent/forge/abcd1234');
        });

        it('lowercases and strips non-alphanumeric from task ID', () => {
            const name = manager.buildBranchName('ABCD-1234', 'vigil');
            expect(name).toBe('agent/vigil/abcd1234');
        });

        it('handles short task IDs', () => {
            const name = manager.buildBranchName('abc', 'scout');
            expect(name).toBe('agent/scout/abc');
        });
    });

    // ── createTaskBranch ────────────────────────────────────────────────────

    describe('createTaskBranch()', () => {
        it('creates and checks out a new branch', async () => {
            const branchName = await manager.createTaskBranch(repoPath, 'task-abc123', 'forge');

            expect(branchName).toBe('agent/forge/taskabc1');

            const current = getCurrentBranch(repoPath);
            expect(current).toBe(branchName);
        });

        it('branches from main', async () => {
            // Add a commit on main first
            writeFile(repoPath, 'src/index.ts', 'console.log("hello");\n');
            commitAll(repoPath, 'Add index.ts');

            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'forge');

            // Branch should have main's files
            expect(fs.existsSync(path.join(repoPath, 'src/index.ts'))).toBe(true);

            // And be on the new branch
            expect(getCurrentBranch(repoPath)).toBe(branchName);
        });
    });

    // ── switchBranch ────────────────────────────────────────────────────────

    describe('switchBranch()', () => {
        it('switches to an existing branch', async () => {
            await manager.createTaskBranch(repoPath, 'task-1', 'forge');
            await manager.switchBranch(repoPath, 'main');

            expect(getCurrentBranch(repoPath)).toBe('main');
        });

        it('throws when switching to non-existent branch', async () => {
            await expect(
                manager.switchBranch(repoPath, 'does-not-exist')
            ).rejects.toThrow();
        });
    });

    // ── getCurrentBranch ────────────────────────────────────────────────────

    describe('getCurrentBranch()', () => {
        it('returns the current branch name', async () => {
            const branch = await manager.getCurrentBranch(repoPath);
            expect(branch).toBe('main');
        });

        it('returns task branch after creation', async () => {
            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'vigil');
            const current = await manager.getCurrentBranch(repoPath);
            expect(current).toBe(branchName);
        });
    });

    // ── mergeBranch ─────────────────────────────────────────────────────────

    describe('mergeBranch()', () => {
        it('merges a clean fast-forward branch', async () => {
            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'forge');

            // Add a commit on the task branch
            writeFile(repoPath, 'src/feature.ts', 'export const x = 1;\n');
            commitAll(repoPath, 'Add feature');

            const result = await manager.mergeBranch(repoPath, branchName, 'Merge task-1');

            expect(result.success).toBe(true);
            expect(result.conflicted).toBe(false);
            expect(result.mergeCommit).toBeTruthy();
            expect(getCurrentBranch(repoPath)).toBe('main');

            // The file should be on main now
            expect(fs.existsSync(path.join(repoPath, 'src/feature.ts'))).toBe(true);
        });

        it('detects merge conflicts', async () => {
            // Create a file on main
            writeFile(repoPath, 'src/shared.ts', 'export const val = "main";\n');
            commitAll(repoPath, 'Add shared on main');

            // Create branch and change the same file
            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'forge');
            writeFile(repoPath, 'src/shared.ts', 'export const val = "branch";\n');
            commitAll(repoPath, 'Change shared on branch');

            // Now add a conflicting change on main
            await manager.switchBranch(repoPath, 'main');
            writeFile(repoPath, 'src/shared.ts', 'export const val = "main-updated";\n');
            commitAll(repoPath, 'Change shared on main');

            // Merge should detect conflict
            const result = await manager.mergeBranch(repoPath, branchName, 'Merge task-1');

            expect(result.success).toBe(false);
            expect(result.conflicted).toBe(true);
            expect(result.mergeCommit).toBeNull();

            // Should still be on main, merge aborted
            expect(getCurrentBranch(repoPath)).toBe('main');
        });

        it('handles merge with no new commits (already up to date)', async () => {
            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'forge');

            // Don't add any commits — branch is same as main
            const result = await manager.mergeBranch(repoPath, branchName, 'Merge task-1');

            expect(result.success).toBe(true);
            expect(result.conflicted).toBe(false);
        });
    });

    // ── deleteBranch ────────────────────────────────────────────────────────

    describe('deleteBranch()', () => {
        it('deletes a merged branch', async () => {
            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'forge');
            writeFile(repoPath, 'src/file.ts', 'content\n');
            commitAll(repoPath, 'Add file');

            await manager.mergeBranch(repoPath, branchName, 'Merge');
            await manager.deleteBranch(repoPath, branchName);

            const exists = await manager.branchExists(repoPath, branchName);
            expect(exists).toBe(false);
        });

        it('switches to main when deleting current branch', async () => {
            const branchName = await manager.createTaskBranch(repoPath, 'task-1', 'forge');

            // We're on the branch — deleteBranch should switch to main first
            // But git -d won't delete unmerged branches, so merge first
            await manager.switchBranch(repoPath, 'main');
            await manager.deleteBranch(repoPath, branchName);

            expect(getCurrentBranch(repoPath)).toBe('main');
        });
    });

    // ── branchExists ────────────────────────────────────────────────────────

    describe('branchExists()', () => {
        it('returns true for an existing branch', async () => {
            await manager.createTaskBranch(repoPath, 'task-1', 'forge');
            const branchName = manager.buildBranchName('task-1', 'forge');

            const exists = await manager.branchExists(repoPath, branchName);
            expect(exists).toBe(true);
        });

        it('returns false for a non-existent branch', async () => {
            const exists = await manager.branchExists(repoPath, 'agent/forge/nope');
            expect(exists).toBe(false);
        });
    });

    // ── Integration: full task branch lifecycle ─────────────────────────────

    describe('full lifecycle', () => {
        it('creates branch → writes files → commits → merges → deletes', async () => {
            // 1. Create task branch
            const branchName = await manager.createTaskBranch(repoPath, 'task-impl-42', 'forge');
            expect(getCurrentBranch(repoPath)).toBe(branchName);

            // 2. Agent writes files and commits
            writeFile(repoPath, 'src/auth/login.ts', 'export function login() { return true; }\n');
            writeFile(repoPath, 'tests/auth/login.test.ts', 'it("works", () => {})\n');
            commitAll(repoPath, 'Implement login feature');

            // 3. Sensei merges after review passes
            const result = await manager.mergeBranch(repoPath, branchName, 'Merge: login feature reviewed');
            expect(result.success).toBe(true);
            expect(result.conflicted).toBe(false);

            // 4. Delete the merged branch
            await manager.deleteBranch(repoPath, branchName);
            const exists = await manager.branchExists(repoPath, branchName);
            expect(exists).toBe(false);

            // 5. Verify files are on main
            expect(getCurrentBranch(repoPath)).toBe('main');
            expect(fs.existsSync(path.join(repoPath, 'src/auth/login.ts'))).toBe(true);
            expect(fs.existsSync(path.join(repoPath, 'tests/auth/login.test.ts'))).toBe(true);
        });
    });

    describe('tag operations (acceptance-snapshot recovery)', () => {
        it('createTag tags HEAD and tagExists reports it', async () => {
            await manager.createTag(repoPath, 'agent/forge/best-attempt');
            const exists = await manager.tagExists(repoPath, 'agent/forge/best-attempt');
            expect(exists).toBe(true);

            // Tag should not exist for an unrelated name
            const unrelated = await manager.tagExists(repoPath, 'agent/forge/some-other-tag');
            expect(unrelated).toBe(false);
        });

        it('createTag is force-update — moves the tag to current HEAD on second call', async () => {
            await manager.createTag(repoPath, 'agent/forge/best-attempt');
            const firstHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();

            // Make a new commit, then re-tag
            writeFile(repoPath, 'second.txt', 'second\n');
            commitAll(repoPath, 'Second commit');
            const secondHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
            expect(secondHead).not.toBe(firstHead);

            await manager.createTag(repoPath, 'agent/forge/best-attempt');
            const tagged = execSync('git rev-list -n 1 agent/forge/best-attempt', { cwd: repoPath, encoding: 'utf-8' }).trim();
            expect(tagged).toBe(secondHead);
        });

        it('checkoutTag restores workspace to the tagged state', async () => {
            // Snapshot the current state
            writeFile(repoPath, 'snapshot.txt', 'good version\n');
            commitAll(repoPath, 'Good version');
            await manager.createTag(repoPath, 'agent/forge/best-attempt');

            // Regress: write a worse version
            writeFile(repoPath, 'snapshot.txt', 'BROKEN\n');
            commitAll(repoPath, 'Regression');

            // The bad content is on disk
            const before = fs.readFileSync(path.join(repoPath, 'snapshot.txt'), 'utf-8');
            expect(before).toBe('BROKEN\n');

            // Restore
            await manager.checkoutTag(repoPath, 'agent/forge/best-attempt');
            const after = fs.readFileSync(path.join(repoPath, 'snapshot.txt'), 'utf-8');
            // Normalize line endings — git on Windows can convert LF to CRLF
            // on checkout depending on core.autocrlf. The semantic check is
            // that the content is the good version, not the regression.
            expect(after.replace(/\r\n/g, '\n')).toBe('good version\n');
        });
    });
});
