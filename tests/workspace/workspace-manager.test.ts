/**
 * WorkspaceManager unit tests
 *
 * Uses real file system operations in a temp directory.
 * Each test gets an isolated temp workspace that is cleaned up after.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEMPLATE_DIR = path.resolve(__dirname, '../../templates/default');

/** Create a unique temp directory for each test. */
function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-test-'));
}

/** Check if a path is a git repo. */
function isGitRepo(dir: string): boolean {
    return fs.existsSync(path.join(dir, '.git'));
}

/** Get the first git commit message. */
function getFirstCommitMessage(dir: string): string {
    return execSync('git log --reverse --format=%s -1', { cwd: dir, encoding: 'utf-8' }).trim();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkspaceManager', () => {
    let tempDir: string;
    let manager: WorkspaceManager;

    beforeEach(() => {
        tempDir = makeTempDir();
        manager = new WorkspaceManager(TEMPLATE_DIR);
    });

    afterEach(() => {
        // Clean up temp directory
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors on CI
        }
    });

    // ── createProject() ──────────────────────────────────────────────────────

    describe('createProject()', () => {
        it('creates a project directory from the golden template', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'my-app', 'My App', 'A cool app'
            );

            expect(fs.existsSync(projectPath)).toBe(true);
            expect(projectPath).toBe(path.resolve(tempDir, 'my-app'));
        });

        it('initializes a git repo with an initial commit', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'git-test', 'Git Test', 'desc'
            );

            expect(isGitRepo(projectPath)).toBe(true);
            expect(getFirstCommitMessage(projectPath)).toBe('Initial project scaffold');
        });

        it('copies the golden template directory structure', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'structure-test', 'Structure Test', 'desc'
            );

            // Core directories from template
            expect(fs.existsSync(path.join(projectPath, '.autonauts'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'docs', 'discovery'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'src'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'tests'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, '.gitignore'))).toBe(true);
        });

        // F-351 + F-366: static-HTML briefs should NOT carry the build
        // scaffold (package.json / tsconfig / src / tests). The build
        // verification gate skips correctly when package.json is absent.
        it('strips build scaffold when description matches a static-HTML pattern (F-351)', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'static-app', 'Static App',
                'A simple counter — single-file, no build, vanilla JS'
            );
            expect(fs.existsSync(path.join(projectPath, 'package.json'))).toBe(false);
            expect(fs.existsSync(path.join(projectPath, 'tsconfig.json'))).toBe(false);
            expect(fs.existsSync(path.join(projectPath, 'src'))).toBe(false);
            expect(fs.existsSync(path.join(projectPath, 'tests'))).toBe(false);
            // The non-build assets stay intact
            expect(fs.existsSync(path.join(projectPath, '.autonauts'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'README.md'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'docs', 'discovery'))).toBe(true);
        });

        it('keeps build scaffold when description does not match a static-HTML pattern (F-351)', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'full-app', 'Full App',
                'A Node.js REST API with Postgres and Express'
            );
            // Build scaffold preserved for non-static briefs
            expect(fs.existsSync(path.join(projectPath, 'package.json'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'tsconfig.json'))).toBe(true);
            expect(fs.existsSync(path.join(projectPath, 'src'))).toBe(true);
        });

        it('customizes .autonauts/project.json with name, description, and trust level', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'meta-test', 'Meta Test', 'A test description', 'high'
            );

            const metadata = JSON.parse(
                fs.readFileSync(path.join(projectPath, '.autonauts', 'project.json'), 'utf-8')
            );

            expect(metadata.name).toBe('Meta Test');
            expect(metadata.description).toBe('A test description');
            expect(metadata.trustLevel).toBe('high');
            expect(typeof metadata.createdAt).toBe('string');
            expect(metadata.createdAt.length).toBeGreaterThan(0);
        });

        it('customizes README.md with the project name and description', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'readme-test', 'Readme Project', 'This is the readme desc'
            );

            const readme = fs.readFileSync(path.join(projectPath, 'README.md'), 'utf-8');
            expect(readme).toContain('# Readme Project');
            expect(readme).toContain('This is the readme desc');
            expect(readme).toContain('KageOps');
        });

        it('defaults trust level to "low" when not specified', async () => {
            const projectPath = await manager.createProject(
                tempDir, 'default-trust', 'Default Trust', 'desc'
            );

            const metadata = JSON.parse(
                fs.readFileSync(path.join(projectPath, '.autonauts', 'project.json'), 'utf-8')
            );

            expect(metadata.trustLevel).toBe('low');
        });

        it('throws if workspace already exists', async () => {
            await manager.createProject(tempDir, 'dupe-test', 'Dupe Test', 'desc');

            await expect(
                manager.createProject(tempDir, 'dupe-test', 'Dupe Test 2', 'desc 2')
            ).rejects.toThrow(/already exists/i);
        });

        it('throws for invalid slug with special characters', async () => {
            await expect(
                manager.createProject(tempDir, 'my app!', 'Bad Slug', 'desc')
            ).rejects.toThrow(/invalid project slug/i);
        });

        it('throws for path traversal slug', async () => {
            await expect(
                manager.createProject(tempDir, '..', 'Traversal', 'desc')
            ).rejects.toThrow(/invalid project slug/i);
        });

        it('throws for empty slug', async () => {
            await expect(
                manager.createProject(tempDir, '', 'Empty', 'desc')
            ).rejects.toThrow(/cannot be empty/i);
        });

        it('sanitizes Unicode dashes (em, en, hyphen, minus) to ASCII hyphens', async () => {
            // Em-dash, en-dash, hyphen, minus — all common in pasted project names
            const created = await manager.createProject(
                tempDir, 'my—em-project', 'Em Dash', 'desc'
            );
            expect(fs.existsSync(path.join(tempDir, 'my-em-project'))).toBe(true);
            expect(created).toBe(path.resolve(tempDir, 'my-em-project'));
        });

        it('lowercases and sanitizes mixed-case Unicode slugs', async () => {
            const created = await manager.createProject(
                tempDir, 'GreenThumb—V2', 'Green Thumb', 'desc'
            );
            expect(fs.existsSync(path.join(tempDir, 'greenthumb-v2'))).toBe(true);
            expect(created).toBe(path.resolve(tempDir, 'greenthumb-v2'));
        });

        it('creates parent projectsDir if it does not exist', async () => {
            const deepDir = path.join(tempDir, 'a', 'b', 'c');
            expect(fs.existsSync(deepDir)).toBe(false);

            await manager.createProject(deepDir, 'nested', 'Nested', 'desc');

            expect(fs.existsSync(path.join(deepDir, 'nested'))).toBe(true);
        });

        it('throws if template directory does not exist', async () => {
            const badManager = new WorkspaceManager('/nonexistent/template');

            await expect(
                badManager.createProject(tempDir, 'no-template', 'No Template', 'desc')
            ).rejects.toThrow(/template not found/i);
        });
    });

    // ── getProjectPath() ─────────────────────────────────────────────────────

    describe('getProjectPath()', () => {
        it('returns absolute path for an existing project', async () => {
            await manager.createProject(tempDir, 'exists', 'Exists', 'desc');

            const result = manager.getProjectPath(tempDir, 'exists');

            expect(result).toBe(path.resolve(tempDir, 'exists'));
        });

        it('returns null for a non-existent project', () => {
            const result = manager.getProjectPath(tempDir, 'nope');

            expect(result).toBeNull();
        });

        it('throws for path traversal slug', () => {
            expect(() => manager.getProjectPath(tempDir, '..')).toThrow();
        });
    });

    // ── projectExists() ──────────────────────────────────────────────────────

    describe('projectExists()', () => {
        it('returns true for an existing project', async () => {
            await manager.createProject(tempDir, 'check-exists', 'Check', 'desc');

            expect(manager.projectExists(tempDir, 'check-exists')).toBe(true);
        });

        it('returns false for a non-existent project', () => {
            expect(manager.projectExists(tempDir, 'nope')).toBe(false);
        });
    });

    // ── deleteProject() ──────────────────────────────────────────────────────

    describe('deleteProject()', () => {
        it('removes an existing workspace', async () => {
            await manager.createProject(tempDir, 'to-delete', 'Delete Me', 'desc');
            expect(fs.existsSync(path.join(tempDir, 'to-delete'))).toBe(true);

            await manager.deleteProject(tempDir, 'to-delete');

            expect(fs.existsSync(path.join(tempDir, 'to-delete'))).toBe(false);
        });

        it('does not throw for a non-existent project', async () => {
            await expect(
                manager.deleteProject(tempDir, 'not-here')
            ).resolves.not.toThrow();
        });
    });
});
