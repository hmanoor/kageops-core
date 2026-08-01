/**
 * Template cloner behavioral tests
 *
 * Tests cloneTemplate() file operations, project.json customization,
 * README generation, and git initialization with mocked fs/child_process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// ── Mock setup ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
    const existingPaths = new Set<string>();

    return {
        existingPaths,
        existsSyncFn: vi.fn((p: unknown) => existingPaths.has(String(p))),
        cpSyncFn: vi.fn(),
        mkdirSyncFn: vi.fn(),
        readFileSyncFn: vi.fn(() => '{}'),
        writeFileSyncFn: vi.fn(),
        execSyncFn: vi.fn(),
        addPath: (p: string): void => { existingPaths.add(p); },
        clearPaths: (): void => { existingPaths.clear(); },
    };
});

vi.mock('fs', () => ({
    existsSync: mocks.existsSyncFn,
    cpSync: mocks.cpSyncFn,
    mkdirSync: mocks.mkdirSyncFn,
    readFileSync: mocks.readFileSyncFn,
    writeFileSync: mocks.writeFileSyncFn,
}));

vi.mock('child_process', () => ({
    execSync: mocks.execSyncFn,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { cloneTemplate, getDefaultTemplatePath } from '../../src/orchestrator/template-cloner';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TEMPLATE = path.resolve('/fake/template');
const TARGET = path.resolve('/fake/target');
const PARENT = path.dirname(TARGET);
const CONFIG = { name: 'My Project', description: 'A cool project', trustLevel: 'low' };

// Derived paths the source code constructs via path.join()
const PROJECT_JSON = path.join(TARGET, '.autonauts', 'project.json');
const README = path.join(TARGET, 'README.md');

function setupHappyPath(): void {
    mocks.addPath(TEMPLATE);
    mocks.addPath(PARENT);
}

function setupWithFiles(): void {
    setupHappyPath();
    mocks.addPath(PROJECT_JSON);
    mocks.addPath(README);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('template-cloner', () => {
    beforeEach(() => {
        mocks.clearPaths();
        vi.clearAllMocks();
    });

    describe('cloneTemplate()', () => {
        it('throws when template path does not exist', async () => {
            // Template NOT in existingPaths
            await expect(cloneTemplate(TEMPLATE, TARGET, CONFIG))
                .rejects.toThrow('Template directory not found');
        });

        it('throws when target path already exists', async () => {
            mocks.addPath(TEMPLATE);
            mocks.addPath(TARGET);

            await expect(cloneTemplate(TEMPLATE, TARGET, CONFIG))
                .rejects.toThrow('Target directory already exists');
        });

        it('creates parent directory when it does not exist', async () => {
            mocks.addPath(TEMPLATE);
            // Parent NOT in existingPaths

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            expect(mocks.mkdirSyncFn).toHaveBeenCalledWith(PARENT, { recursive: true });
        });

        it('does not call mkdirSync when parent already exists', async () => {
            setupHappyPath();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            expect(mocks.mkdirSyncFn).not.toHaveBeenCalled();
        });

        it('calls fs.cpSync with recursive: true', async () => {
            setupHappyPath();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            expect(mocks.cpSyncFn).toHaveBeenCalledWith(TEMPLATE, TARGET, { recursive: true });
        });

        it('customizes project.json with provided config', async () => {
            const originalJson = JSON.stringify({ name: '', extra: 'keep-me' });
            mocks.readFileSyncFn.mockReturnValue(originalJson);
            setupWithFiles();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            expect(mocks.writeFileSyncFn).toHaveBeenCalledWith(
                PROJECT_JSON,
                expect.any(String),
                'utf-8'
            );

            // Parse written JSON and verify fields
            const writeCall = mocks.writeFileSyncFn.mock.calls.find(
                (c: unknown[]) => String(c[0]) === PROJECT_JSON
            );
            expect(writeCall).toBeDefined();
            const written = JSON.parse(writeCall![1] as string);
            expect(written.name).toBe('My Project');
            expect(written.description).toBe('A cool project');
            expect(written.trustLevel).toBe('low');
            expect(written.createdAt).toBeDefined();
            // Original field preserved via spread
            expect(written.extra).toBe('keep-me');
        });

        it('writes project.json with ISO 8601 createdAt timestamp', async () => {
            mocks.readFileSyncFn.mockReturnValue('{}');
            setupWithFiles();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const writeCall = mocks.writeFileSyncFn.mock.calls.find(
                (c: unknown[]) => String(c[0]) === PROJECT_JSON
            );
            const written = JSON.parse(writeCall![1] as string);
            // ISO 8601 format check
            expect(() => new Date(written.createdAt)).not.toThrow();
            expect(new Date(written.createdAt).toISOString()).toBe(written.createdAt);
        });

        it('writes project.json with pretty-printing (2-space indent)', async () => {
            mocks.readFileSyncFn.mockReturnValue('{}');
            setupWithFiles();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const writeCall = mocks.writeFileSyncFn.mock.calls.find(
                (c: unknown[]) => String(c[0]) === PROJECT_JSON
            );
            const content = writeCall![1] as string;
            // JSON.stringify(obj, null, 2) uses 2-space indent
            expect(content).toContain('\n  "');
        });

        it('customizes README.md with project name as H1 heading', async () => {
            setupWithFiles();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const writeCall = mocks.writeFileSyncFn.mock.calls.find(
                (c: unknown[]) => String(c[0]) === README
            );
            expect(writeCall).toBeDefined();
            const content = writeCall![1] as string;
            expect(content).toContain('# My Project');
        });

        it('customizes README.md with project description', async () => {
            setupWithFiles();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const writeCall = mocks.writeFileSyncFn.mock.calls.find(
                (c: unknown[]) => String(c[0]) === README
            );
            const content = writeCall![1] as string;
            expect(content).toContain('A cool project');
        });

        it('customizes README.md with KageOps attribution link', async () => {
            setupWithFiles();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const writeCall = mocks.writeFileSyncFn.mock.calls.find(
                (c: unknown[]) => String(c[0]) === README
            );
            const content = writeCall![1] as string;
            expect(content).toContain('kageops.ai');
        });

        it('runs git init, git add, git commit in correct order', async () => {
            setupHappyPath();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            expect(mocks.execSyncFn).toHaveBeenCalledTimes(3);
            expect(mocks.execSyncFn).toHaveBeenNthCalledWith(1, 'git init', { cwd: TARGET, stdio: 'pipe' });
            expect(mocks.execSyncFn).toHaveBeenNthCalledWith(2, 'git add .', { cwd: TARGET, stdio: 'pipe' });
            // The commit pins the committer identity inline. Without it this
            // fails outright on a machine with no global git config — which is
            // how an outside reviewer's local test run broke.
            expect(mocks.execSyncFn).toHaveBeenNthCalledWith(3,
                'git -c user.email=kageops@local -c user.name=KageOps commit -m "Initial project setup via KageOps"',
                { cwd: TARGET, stdio: 'pipe' }
            );
        });

        it('commits with an explicit identity rather than inheriting global git config', async () => {
            setupHappyPath();

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const commitCmd = mocks.execSyncFn.mock.calls[2]?.[0] as string;
            expect(commitCmd).toContain('-c user.email=');
            expect(commitCmd).toContain('-c user.name=');
            // Identity flags must precede the subcommand: `git -c k=v commit`.
            expect(commitCmd.indexOf('-c')).toBeLessThan(commitCmd.indexOf('commit'));
        });

        it('does not throw when git init fails', async () => {
            mocks.execSyncFn.mockImplementation(() => {
                throw new Error('git not found');
            });
            setupHappyPath();

            await expect(cloneTemplate(TEMPLATE, TARGET, CONFIG)).resolves.toBeUndefined();
        });

        it('skips project.json customization when file does not exist in target', async () => {
            setupHappyPath();
            // Only README exists, not project.json
            mocks.addPath(README);

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const projectJsonWrites = mocks.writeFileSyncFn.mock.calls.filter(
                (c: unknown[]) => String(c[0]) === PROJECT_JSON
            );
            expect(projectJsonWrites).toHaveLength(0);
        });

        it('skips README customization when file does not exist in target', async () => {
            setupHappyPath();
            // Only project.json exists, not README
            mocks.addPath(PROJECT_JSON);
            mocks.readFileSyncFn.mockReturnValue('{}');

            await cloneTemplate(TEMPLATE, TARGET, CONFIG);

            const readmeWrites = mocks.writeFileSyncFn.mock.calls.filter(
                (c: unknown[]) => String(c[0]) === README
            );
            expect(readmeWrites).toHaveLength(0);
        });
    });

    describe('getDefaultTemplatePath()', () => {
        it('returns a string containing templates/default', () => {
            mocks.existsSyncFn.mockReturnValue(false);
            const result = getDefaultTemplatePath();
            expect(typeof result).toBe('string');
            expect(result).toContain('templates');
            expect(result).toContain('default');
        });
    });
});
