/**
 * P1-06b/P1-07 — Forge revision helpers (workspace scan only).
 *
 * Locks in the part of the revision path that still lives on the
 * Forge class — namely `resolveRevisionTargetFiles`. The prompt
 * builder + file content collection moved to
 * `src/agents/forge-revision-prompt.ts` in P1-07 and are tested
 * directly there (no Forge subclassing required).
 *
 * Uses a real temp dir so the workspace walk gets actual coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Forge } from '../../../src/agents/specialists/forge';
import type { AgentModelConfig, TaskInfo } from '../../../src/agents/autonaut-agent';

vi.mock('../../../src/agents/ai-adapter', () => ({
    sendPrompt: vi.fn().mockResolvedValue({
        text: '', model: 'test-model', tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0,
    }),
    sendConversation: vi.fn(),
}));

const MODEL: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
};

class TestForge extends Forge {
    constructor() { super(MODEL); }
    public testResolveTargets(task: TaskInfo): Promise<readonly string[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any).resolveRevisionTargetFiles(task);
    }
    public testCollectRevisionFiles(repoPath: string, paths: readonly string[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any).collectRevisionFiles(repoPath, paths);
    }
}

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 't-1',
        projectId: 'p-1',
        title: 'Add a contact form',
        description: 'desc',
        taskType: 'revision',
        phase: 'development',
        outputPath: null,
        repoPath: '/tmp/no-such-repo',
        revisionInstruction: 'add a contact form',
        iterationId: 'it-1',
        targetFiles: null,
        ...overrides,
    };
}

describe('Forge.resolveRevisionTargetFiles (P1-06b)', () => {
    let tempDir: string;
    let forge: TestForge;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-rev-'));
        forge = new TestForge();
    });

    afterEach(() => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('returns task.targetFiles verbatim when populated', async () => {
        const task = makeTask({
            repoPath: tempDir,
            targetFiles: ['src/index.ts', 'index.html'],
        });
        expect(await forge.testResolveTargets(task)).toEqual(['src/index.ts', 'index.html']);
    });

    it('walks workspace + returns known artifact extensions (POSIX-normalised paths)', async () => {
        fs.writeFileSync(path.join(tempDir, 'index.html'), '<html></html>');
        fs.writeFileSync(path.join(tempDir, 'styles.css'), 'body{}');
        fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export {};');
        fs.writeFileSync(path.join(tempDir, 'random.bin'), 'binary');
        fs.mkdirSync(path.join(tempDir, 'src'));
        fs.writeFileSync(path.join(tempDir, 'src', 'main.tsx'), 'export {};');

        const task = makeTask({ repoPath: tempDir, targetFiles: null });
        const result = await forge.testResolveTargets(task);
        const set = new Set(result);
        expect(set.has('index.html')).toBe(true);
        expect(set.has('styles.css')).toBe(true);
        expect(set.has('app.ts')).toBe(true);
        expect(set.has('src/main.tsx')).toBe(true);
        expect(set.has('random.bin')).toBe(false);
    });

    it('skips node_modules, .git, .kageops, dist, build', async () => {
        for (const dir of ['node_modules', '.git', '.kageops', 'dist', 'build']) {
            fs.mkdirSync(path.join(tempDir, dir));
            fs.writeFileSync(path.join(tempDir, dir, 'leak.ts'), 'export {};');
        }
        fs.writeFileSync(path.join(tempDir, 'real.ts'), 'export {};');

        const result = await forge.testResolveTargets(makeTask({ repoPath: tempDir, targetFiles: null }));
        expect(result).toEqual(['real.ts']);
    });

    it('skips package-lock.json + lockfiles', async () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
        fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '');
        fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');

        const result = await forge.testResolveTargets(makeTask({ repoPath: tempDir, targetFiles: null }));
        expect(result).toContain('package.json');
        expect(result).not.toContain('package-lock.json');
        expect(result).not.toContain('yarn.lock');
        expect(result).not.toContain('pnpm-lock.yaml');
    });

    it('caps at MAX_FILES (20) on a sprawling workspace', async () => {
        for (let i = 0; i < 30; i++) {
            fs.writeFileSync(path.join(tempDir, `f${i}.ts`), 'export {};');
        }
        const result = await forge.testResolveTargets(makeTask({ repoPath: tempDir, targetFiles: null }));
        expect(result.length).toBeLessThanOrEqual(20);
    });

    it('returns [] when workspace path does not exist', async () => {
        const result = await forge.testResolveTargets(makeTask({ repoPath: '/no/such/dir', targetFiles: null }));
        expect(result).toEqual([]);
    });

    it('returns [] when repoPath is empty', async () => {
        const result = await forge.testResolveTargets(makeTask({ repoPath: '', targetFiles: null }));
        expect(result).toEqual([]);
    });
});

describe('Forge.collectRevisionFiles (P1-06b → P1-07)', () => {
    let tempDir: string;
    let forge: TestForge;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-rev-read-'));
        forge = new TestForge();
    });

    afterEach(() => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('returns RevisionFile entries for each readable file', () => {
        fs.writeFileSync(path.join(tempDir, 'a.html'), '<html>a</html>');
        fs.writeFileSync(path.join(tempDir, 'b.css'), 'body { color: red; }');

        const out = forge.testCollectRevisionFiles(tempDir, ['a.html', 'b.css']);
        expect(out).toEqual([
            { path: 'a.html', content: '<html>a</html>' },
            { path: 'b.css', content: 'body { color: red; }' },
        ]);
    });

    it('skips unreadable files but keeps the rest', () => {
        fs.writeFileSync(path.join(tempDir, 'good.html'), '<html>good</html>');
        const out = forge.testCollectRevisionFiles(tempDir, ['good.html', 'missing.html']);
        expect(out).toHaveLength(1);
        expect(out[0].path).toBe('good.html');
    });

    it('returns empty array when given an empty list', () => {
        expect(forge.testCollectRevisionFiles(tempDir, [])).toEqual([]);
    });
});
