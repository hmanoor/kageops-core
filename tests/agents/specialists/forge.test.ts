/**
 * Forge (Engineer Agent) — unit tests
 *
 * Tests the fix sprint additions: setupProject, error capture in
 * runBuild/runTests, fixFailures with real error context, and smokeTest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { Forge } from '../../../src/agents/specialists/forge';
import type { AgentModelConfig } from '../../../src/agents/autonaut-agent';

// ── Mock fs module ───────────────────────────────────

const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue('{}');
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    };
});

// ── Mock everything the base class needs ─────────────

vi.mock('../../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

vi.mock('../../../src/agents/ai-adapter', () => ({
    sendPrompt: vi.fn().mockResolvedValue({
        text: '--- FILE: src/index.ts ---\nconsole.log("hello");\n--- END FILE ---',
        model: 'test-model',
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.01,
        durationMs: 500,
    }),
    sendConversation: vi.fn(),
}));

vi.mock('../../../src/agents/output-parser', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/agents/output-parser')>();
    return {
        ...actual,
        parseFileBlocks: vi.fn((text: string) => {
            const blocks: { filePath: string; content: string }[] = [];
            const regex = /--- FILE: (.+?) ---\n([\s\S]*?)(?=--- (?:FILE|END FILE)|$)/g;
            let match;
            while ((match = regex.exec(text)) !== null) {
                blocks.push({ filePath: match[1].trim(), content: match[2].trim() });
            }
            return blocks;
        }),
    };
});

vi.mock('../../../src/agents/verification-gate', () => ({
    evidenceFromFiles: vi.fn(() => ({ kind: 'files_written', paths: [] })),
    evidenceFromShell: vi.fn(() => ({ kind: 'shell', command: '', stdout: '', stderr: '', exitCode: 0 })),
    evaluateEvidence: vi.fn(() => ({ pass: true, grade: 'A', details: [] })),
}));

vi.mock('../../../src/agents/security-scanner', () => ({
    SecurityScanner: vi.fn().mockImplementation(() => ({
        scan: vi.fn().mockReturnValue([]),
    })),
    createSessionScanner: vi.fn(() => ({
        scan: vi.fn().mockReturnValue([]),
    })),
}));

vi.mock('../../../src/agents/context-compressor', () => ({
    compressIfLarge: vi.fn((text: string) => text),
}));

vi.mock('../../../src/agents/file-dedup-checker', () => ({
    FileDedupChecker: vi.fn().mockImplementation(() => ({
        checkForDuplicate: vi.fn().mockReturnValue({ recommendation: 'write', existingPath: null, similarity: 0 }),
    })),
}));

vi.mock('../../../src/agents/dependency-manager', () => ({
    DependencyManager: vi.fn().mockImplementation(() => ({
        findMissingDeps: vi.fn().mockReturnValue([]),
        addToPackageJson: vi.fn(),
    })),
}));

vi.mock('../../../src/agents/system-prompt-builder', () => ({
    buildAgentSystemPrompt: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../../src/agents/model-fallback', () => ({
    executeFallbackChain: vi.fn(),
    getFallbackChain: vi.fn(),
}));

vi.mock('../../../src/db/client', () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
}));

// Bundle-path collaborators (used only by the PR-4 design-injection tests).
vi.mock('../../../src/bundles/bundle-prompt-renderer', () => ({
    renderBundlePrompt: vi.fn().mockResolvedValue('RENDERED BUNDLE PROMPT'),
}));

vi.mock('../../../src/bundles/scaffold-copier', () => ({
    copyBundleScaffold: vi.fn().mockResolvedValue({ filesCopied: ['package.json'], filesSkipped: [] }),
}));

// ── Helpers ──────────────────────────────────────────

const MODEL_CONFIG: AgentModelConfig = {
    model: 'test-model',
    maxTokens: 4096,
    temperature: 0.7,
};

function createTaskInfo(overrides: Record<string, unknown> = {}) {
    return {
        id: 'task-001',
        projectId: 'proj-001',
        title: 'Test task',
        description: 'A test task description',
        taskType: 'implement' as string,
        repoPath: '/tmp/fake-repo',
        outputPath: null as string | null,
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────

describe('Forge', () => {
    let forge: Forge;

    beforeEach(() => {
        forge = new Forge(MODEL_CONFIG);
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('creates forge with engineer role', () => {
            expect(forge.name).toBe('forge');
            expect(forge.role).toBe('engineer');
        });
    });

    describe('executeTask routing', () => {
        it('routes setup-project to setupProject handler', async () => {
            const task = createTaskInfo({ taskType: 'setup-project' });

            // Spy on private method via prototype
            const spy = vi.spyOn(forge as any, 'setupProject').mockResolvedValue(undefined);

            await forge.executeTask(task as any);
            expect(spy).toHaveBeenCalledWith(task);
        });

        it('routes implement to implementFeature handler', async () => {
            const spy = vi.spyOn(forge as any, 'implementFeature').mockResolvedValue(undefined);
            const task = createTaskInfo({ taskType: 'implement' });

            await forge.executeTask(task as any);
            expect(spy).toHaveBeenCalledWith(task);
        });

        it('routes fix-bug to fixBug handler', async () => {
            const spy = vi.spyOn(forge as any, 'fixBug').mockResolvedValue(undefined);
            const task = createTaskInfo({ taskType: 'fix-bug' });

            await forge.executeTask(task as any);
            expect(spy).toHaveBeenCalledWith(task);
        });

        it('routes create-api to createApi handler', async () => {
            const spy = vi.spyOn(forge as any, 'createApi').mockResolvedValue(undefined);
            const task = createTaskInfo({ taskType: 'create-api' });

            await forge.executeTask(task as any);
            expect(spy).toHaveBeenCalledWith(task);
        });

        it('routes create-ui to createUi handler', async () => {
            const spy = vi.spyOn(forge as any, 'createUi').mockResolvedValue(undefined);
            const task = createTaskInfo({ taskType: 'create-ui' });

            await forge.executeTask(task as any);
            expect(spy).toHaveBeenCalledWith(task);
        });

        it('routes unknown types to handleGenericTask', async () => {
            const spy = vi.spyOn(forge as any, 'handleGenericTask').mockResolvedValue(undefined);
            const task = createTaskInfo({ taskType: 'something-weird' });

            await forge.executeTask(task as any);
            expect(spy).toHaveBeenCalledWith(task);
        });

        // P1-09 (2026-05-25): revision tasks must reach executeRevisionTask
        // even on static-HTML projects. Pre-fix the isStaticHtmlProject guard
        // ran implementStaticHtmlFeature for every task type, which silently
        // bypassed the staging / diff-card flow when KAGEOPS_FEATURE_REVISIONS
        // was on. Operator-facing symptom: no diff card on Solarsizer-shaped
        // /add-requirement runs. See docs/handovers/2026-05-25-quickstart.md.
        it('routes revision tasks to executeRevisionTask even when project is static-HTML', async () => {
            const revisionSpy = vi.spyOn(forge as any, 'executeRevisionTask').mockResolvedValue(undefined);
            const staticHtmlSpy = vi.spyOn(forge as any, 'implementStaticHtmlFeature').mockResolvedValue(undefined);
            // Force the static-HTML detector to true regardless of task text.
            vi.spyOn(forge as any, 'isStaticHtmlProject').mockResolvedValue(true);

            const task = createTaskInfo({ taskType: 'revision' });
            await forge.executeTask(task as any);

            expect(revisionSpy).toHaveBeenCalledWith(task);
            expect(staticHtmlSpy).not.toHaveBeenCalled();
        });

        it('routes non-revision tasks to the static-HTML path when project is static-HTML', async () => {
            // Sibling regression: the hoisted revision branch must NOT
            // accidentally catch other task types — the static-HTML guard
            // still owns implement/setup-project/etc for static projects.
            const revisionSpy = vi.spyOn(forge as any, 'executeRevisionTask').mockResolvedValue(undefined);
            const staticHtmlSpy = vi.spyOn(forge as any, 'implementStaticHtmlFeature').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'isStaticHtmlProject').mockResolvedValue(true);
            vi.spyOn(forge as any, 'gatherContext').mockResolvedValue('');
            vi.spyOn(forge as any, 'getExistingFilesContext').mockReturnValue('');

            const task = createTaskInfo({ taskType: 'implement' });
            await forge.executeTask(task as any);

            expect(staticHtmlSpy).toHaveBeenCalled();
            expect(revisionSpy).not.toHaveBeenCalled();
        });
    });

    describe('runBuildWithOutput', () => {
        it('returns ok=true when no package.json exists', async () => {
            mockExistsSync.mockReturnValue(false);

            const result = await (forge as any).runBuildWithOutput(createTaskInfo());
            expect(result).toEqual({ ok: true, errorOutput: '' });
        });

        it('returns ok=true when no build script', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: {} }));

            const result = await (forge as any).runBuildWithOutput(createTaskInfo());
            expect(result).toEqual({ ok: true, errorOutput: '' });
        });

        it('captures error output on build failure', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { build: 'tsc' } }));
            vi.spyOn(forge as any, 'executeCommand').mockRejectedValue(new Error('error TS2322: Type mismatch'));
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);

            const result = await (forge as any).runBuildWithOutput(createTaskInfo());
            expect(result.ok).toBe(false);
            expect(result.errorOutput).toContain('BUILD ERRORS');
            expect(result.errorOutput).toContain('TS2322');
        });
    });

    describe('runTestsWithOutput', () => {
        it('returns ok=true when no package.json exists', async () => {
            mockExistsSync.mockReturnValue(false);

            const result = await (forge as any).runTestsWithOutput(createTaskInfo());
            expect(result).toEqual({ ok: true, errorOutput: '' });
        });

        it('returns ok=true when no test script', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: {} }));

            const result = await (forge as any).runTestsWithOutput(createTaskInfo());
            expect(result).toEqual({ ok: true, errorOutput: '' });
        });

        it('captures error output on test failure', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'vitest' } }));
            vi.spyOn(forge as any, 'executeCommand').mockRejectedValue(new Error('FAIL src/index.test.ts > should add'));
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);

            const result = await (forge as any).runTestsWithOutput(createTaskInfo());
            expect(result.ok).toBe(false);
            expect(result.errorOutput).toContain('TEST ERRORS');
            expect(result.errorOutput).toContain('FAIL src/index.test.ts');
        });
    });

    describe('smokeTest', () => {
        it('returns true when no package.json', async () => {
            mockExistsSync.mockReturnValue(false);

            const result = await (forge as any).smokeTest(createTaskInfo());
            expect(result).toBe(true);
        });

        it('returns true when no start script', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: {} }));

            const result = await (forge as any).smokeTest(createTaskInfo());
            expect(result).toBe(true);
        });

        it('returns true when app exits cleanly', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { start: 'node dist/index.js' } }));
            vi.spyOn(forge as any, 'spawnWithTimeout').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);

            const result = await (forge as any).smokeTest(createTaskInfo());
            expect(result).toBe(true);
        });

        it('returns true when app stays alive (timeout = server)', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { start: 'node server.js' } }));
            vi.spyOn(forge as any, 'spawnWithTimeout').mockRejectedValue(new Error("Command 'npm' timed out after 10s"));
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);

            const result = await (forge as any).smokeTest(createTaskInfo());
            expect(result).toBe(true);
        });

        it('returns false when app crashes on startup', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { start: 'node dist/index.js' } }));
            vi.spyOn(forge as any, 'spawnWithTimeout').mockResolvedValue({
                stdout: '',
                stderr: 'Error: Cannot find module',
                exitCode: 1,
            });
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);

            const result = await (forge as any).smokeTest(createTaskInfo());
            expect(result).toBe(false);
        });
    });

    describe('writeOutputFiles F-390 guard (P1-09 hotfix)', () => {
        // Regression for the Solarsizer-P1-09 smoke (2026-05-24) where a
        // revision LLM emitted a literal "[Full file written above]"
        // placeholder for index.html and Forge wrote it verbatim, leaving a
        // 25-byte broken page. Forge's writeOutputFiles override had silently
        // dropped the F-390 per-block shape guard the base class enforces.

        function callWriteOutputFiles(aiOutput: string): Promise<readonly string[]> {
            const writeFileSpy = vi.spyOn(forge as any, 'writeFile').mockResolvedValue(undefined);
            void writeFileSpy;
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'addMissingDependencies').mockReturnValue(undefined);
            vi.spyOn(forge as any, 'collectEvidence').mockReturnValue(undefined);
            return (forge as any).writeOutputFiles(createTaskInfo({ taskType: 'revision' }), aiOutput);
        }

        it('rejects a placeholder block ("[Full file written above]") for index.html and throws when it is the only block', async () => {
            const aiOutput =
                '--- FILE: index.html ---\n' +
                '[Full file written above]\n' +
                '--- END FILE ---';

            await expect(callWriteOutputFiles(aiOutput)).rejects.toThrow(/F-390/);
        });

        it('rejects a placeholder block but still writes a sibling real block', async () => {
            const realJs = 'function render(){const el=document.getElementById("x");return el;}';
            const aiOutput =
                '--- FILE: index.html ---\n' +
                '[Full file written above]\n' +
                '--- FILE: script.js ---\n' +
                realJs + '\n' +
                '--- END FILE ---';

            const writeFile = vi.spyOn(forge as any, 'writeFile').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'addMissingDependencies').mockReturnValue(undefined);
            vi.spyOn(forge as any, 'collectEvidence').mockReturnValue(undefined);

            const written = await (forge as any).writeOutputFiles(
                createTaskInfo({ taskType: 'revision' }),
                aiOutput,
            );

            expect(written).toEqual(['script.js']);
            expect(writeFile).toHaveBeenCalledTimes(1);
            expect(writeFile).toHaveBeenCalledWith('/tmp/fake-repo', 'script.js', realJs);
        });

        it('writes a real HTML block normally (regression: guard is not over-restrictive)', async () => {
            const realHtml = '<!doctype html><html><head><title>x</title></head><body><div id="root">ok</div></body></html>';
            const aiOutput = '--- FILE: index.html ---\n' + realHtml + '\n--- END FILE ---';

            const writeFile = vi.spyOn(forge as any, 'writeFile').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'addMissingDependencies').mockReturnValue(undefined);
            vi.spyOn(forge as any, 'collectEvidence').mockReturnValue(undefined);

            const written = await (forge as any).writeOutputFiles(
                createTaskInfo({ taskType: 'revision' }),
                aiOutput,
            );

            expect(written).toEqual(['index.html']);
            expect(writeFile).toHaveBeenCalledWith('/tmp/fake-repo', 'index.html', realHtml);
        });
    });

    describe('fixFailures error propagation', () => {
        it('passes actual error text to AI on retry', async () => {
            const askAISpy = vi.spyOn(forge as any, 'askAI').mockResolvedValue({
                text: '--- FILE: src/fix.ts ---\nfixed\n--- END FILE ---',
                model: 'test', tokensIn: 10, tokensOut: 20, costUsd: 0, durationMs: 100,
            });
            vi.spyOn(forge as any, 'writeOutputFiles').mockResolvedValue(['src/fix.ts']);
            vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);
            vi.spyOn(forge as any, 'ensureDependencies').mockResolvedValue(undefined);

            // First retry fails, second succeeds
            vi.spyOn(forge as any, 'runBuildWithOutput')
                .mockResolvedValueOnce({ ok: false, errorOutput: 'BUILD ERRORS:\nerror TS2345: Argument mismatch' })
                .mockResolvedValueOnce({ ok: true, errorOutput: '' });
            vi.spyOn(forge as any, 'runTestsWithOutput')
                .mockResolvedValueOnce({ ok: true, errorOutput: '' })
                .mockResolvedValueOnce({ ok: true, errorOutput: '' });

            await (forge as any).fixFailures(createTaskInfo(), 'Initial error output', 'context');

            // maxRetries=1: a single fix attempt gets the initial error output.
            expect(askAISpy).toHaveBeenCalledTimes(1);
            const firstCallPrompt = askAISpy.mock.calls[0][0] as string;
            expect(firstCallPrompt).toContain('Initial error output');
        });
    });
});

// ── PR-4: design-pack injection into the bundle path ────
describe('Forge bundle-path design injection (PR-4)', () => {
    let forge: Forge;

    // Minimal LoadedBundle stand-in — copyBundleScaffold + renderBundlePrompt
    // are mocked, so only manifest.name is read.
    const FAKE_BUNDLE = { manifest: { name: 'nextjs-saas' } } as any;

    beforeEach(() => {
        forge = new Forge(MODEL_CONFIG);
        vi.clearAllMocks();
        // Neutralise the I/O around the AI call so we can isolate the prompt.
        vi.spyOn(forge as any, 'gatherContext').mockResolvedValue('DOC CONTEXT');
        vi.spyOn(forge as any, 'getExistingFilesContext').mockReturnValue('FILES CONTEXT');
        vi.spyOn(forge as any, 'writeOutputFiles').mockResolvedValue(['app/page.tsx']);
        vi.spyOn(forge as any, 'gitCommit').mockResolvedValue(undefined);
        vi.spyOn(forge as any, 'reportProgress').mockResolvedValue(undefined);
    });

    it('setupBundleProject injects the Tailwind/shadcn design discipline into the prompt', async () => {
        const askAISpy = vi.spyOn(forge as any, 'askAI').mockResolvedValue({
            text: '--- FILE: app/page.tsx ---\nexport default () => null;\n--- END FILE ---',
            model: 'test-model', tokensIn: 1, tokensOut: 1, costUsd: 0, durationMs: 1,
        });

        await (forge as any).setupBundleProject(createTaskInfo({ taskType: 'create-ui' }), FAKE_BUNDLE);

        expect(askAISpy).toHaveBeenCalledTimes(1);
        const prompt = askAISpy.mock.calls[0][0] as string;
        expect(prompt).toContain('DESIGN SYSTEM (Tailwind + shadcn');
        expect(prompt).toContain('globals.css');
    });

    it('implementBundleFeature injects the same design discipline', async () => {
        const askAISpy = vi.spyOn(forge as any, 'askAI').mockResolvedValue({
            text: '--- FILE: app/feature.tsx ---\nexport default () => null;\n--- END FILE ---',
            model: 'test-model', tokensIn: 1, tokensOut: 1, costUsd: 0, durationMs: 1,
        });

        await (forge as any).implementBundleFeature(createTaskInfo({ taskType: 'implement' }), FAKE_BUNDLE);

        expect(askAISpy).toHaveBeenCalledTimes(1);
        const prompt = askAISpy.mock.calls[0][0] as string;
        expect(prompt).toContain('DESIGN SYSTEM (Tailwind + shadcn');
    });
});
