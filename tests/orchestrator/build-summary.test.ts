/**
 * Build Summary unit tests
 *
 * Covers:
 *  - HTML rendering with real-shaped data (sections present, escaping safe)
 *  - generateAndSaveBuildReport writes to both target paths and tolerates
 *    missing workspace dir
 *  - subscribeBuildSummaryGenerator wires the event handler and ignores
 *    events without a projectId
 *
 * The DB layer is mocked because the report's data shape is the contract
 * we care about — we don't need an embedded Postgres for these tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockDb = vi.hoisted(() => {
    const getOneFn  = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(async () => null);
    const getManyFn = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(async () => []);
    return { getOne: getOneFn, getMany: getManyFn };
});

vi.mock('../../src/db/client', () => ({
    getOne: mockDb.getOne,
    getMany: mockDb.getMany,
}));

import {
    renderBuildReportHtml,
    generateAndSaveBuildReport,
    subscribeBuildSummaryGenerator,
    extractBrief,
    type BuildReport,
} from '../../src/orchestrator/build-summary';

// ── Test fixtures ────────────────────────────────────

function makeReport(overrides: Partial<BuildReport> = {}): BuildReport {
    return {
        project: {
            id:           'proj-uuid-1',
            name:         'Sample Project',
            description:  'A test project for unit tests',
            summary:      'A test project for unit tests',
            requirements: [],
            repoPath:     '/tmp/sample-project',
            finalPhase:   'launch-growth',
            finalStatus:  'completed',
            trustLevel:   'medium',
            preset:       'openrouter_budget',
            startedAt:    '2026-05-10T10:00:00Z',
            completedAt:  '2026-05-10T10:42:00Z',
            durationMs:   42 * 60 * 1000,
            ...(overrides.project ?? {}),
        },
        techStack: {
            runtime:        null,
            packageManager: null,
            buildTool:      null,
            frameworks:     [],
            languages:      [],
            ...(overrides.techStack ?? {}),
        },
        cost: {
            totalUsd:       0.4567,
            budgetUsd:      0.50,
            totalTokensIn:  12_450,
            totalTokensOut: 8_200,
            callCount:      14,
            byAgent: [
                { agent: 'forge',  usd: 0.30, tokensIn: 8000, tokensOut: 5500, calls: 8 },
                { agent: 'scout',  usd: 0.10, tokensIn: 3000, tokensOut: 2000, calls: 4 },
                { agent: 'vigil',  usd: 0.06, tokensIn: 1450, tokensOut: 700,  calls: 2 },
            ],
            byPhase: [
                { phase: 'development', usd: 0.30, calls: 8 },
                { phase: 'discovery',   usd: 0.10, calls: 4 },
            ],
            ...(overrides.cost ?? {}),
        },
        tasks: {
            total: 10, completed: 9, failed: 1,
            byAgent: [
                { agent: 'forge', total: 6, completed: 5, failed: 1 },
                { agent: 'scout', total: 4, completed: 4, failed: 0 },
            ],
            ...(overrides.tasks ?? {}),
        },
        workspace: {
            fileCount: 7,
            totalBytes: 12345,
            totalLines: 420,
            byExtension: [
                { ext: '.html', count: 1, bytes: 5000, lines: 200 },
                { ext: '.css',  count: 1, bytes: 4000, lines: 150 },
                { ext: '.js',   count: 1, bytes: 3000, lines: 70 },
            ],
            ...(overrides.workspace ?? {}),
        },
    };
}

// ── Tests ────────────────────────────────────────────

describe('renderBuildReportHtml', () => {
    it('renders a valid HTML document with the project name as the title', () => {
        const html = renderBuildReportHtml(makeReport());
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('<title>Sample Project — KageOps Build Report</title>');
        expect(html).toContain('<h1>Sample Project</h1>');
    });

    it('escapes user-controlled fields to prevent XSS', () => {
        const html = renderBuildReportHtml(
            makeReport({
                project: {
                    id:           'proj-uuid-1',
                    name:         '<script>alert("pwn")</script>',
                    description:  'desc & "quoted" \'fields\'',
                    summary:      'desc & "quoted" \'fields\'',
                    requirements: ['<img src=x onerror=1>'],
                    repoPath:     '',
                    finalPhase:   'launch-growth',
                    finalStatus:  'completed',
                    trustLevel:   'low',
                    preset:       null,
                    startedAt:    '2026-05-10T10:00:00Z',
                    completedAt:  '2026-05-10T10:42:00Z',
                    durationMs:   1000,
                },
            }),
        );
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;alert(&quot;pwn&quot;)&lt;/script&gt;');
        expect(html).toContain('desc &amp; &quot;quoted&quot;');
        // Requirement bullets must also escape user-supplied HTML
        expect(html).not.toContain('<img src=x onerror=1>');
        expect(html).toContain('&lt;img src=x onerror=1&gt;');
    });

    it('renders the cost & tokens section with formatted USD + token counts', () => {
        const html = renderBuildReportHtml(makeReport());
        expect(html).toContain('$0.46');                       // total spend
        expect(html).toContain('cap $0.50');                   // budget cap
        // 12,450 → '12k' (≥10k drops the decimal); 8,200 → '8.2k' (<10k keeps 1dp)
        expect(html).toContain('12k');
        expect(html).toContain('8.2k');
        expect(html).toContain('14 AI calls');
    });

    it('renders by-agent rows with title-cased agent names', () => {
        const html = renderBuildReportHtml(makeReport());
        expect(html).toContain('<strong>Forge</strong>');
        expect(html).toContain('<strong>Scout</strong>');
        expect(html).toContain('<strong>Vigil</strong>');
    });

    it('renders by-phase rows with title-cased phase names', () => {
        const html = renderBuildReportHtml(makeReport());
        expect(html).toContain('<strong>Development</strong>');
        expect(html).toContain('<strong>Discovery</strong>');
    });

    it('shows red status dot when total spend exceeds budget cap', () => {
        const html = renderBuildReportHtml(
            makeReport({ cost: { ...makeReport().cost, totalUsd: 0.80, budgetUsd: 0.50 } }),
        );
        expect(html).toMatch(/status-dot red[^"]*"><\/span><span class="status-label">Spend/);
    });

    it('shows red status dot when project status is not completed', () => {
        const html = renderBuildReportHtml(
            makeReport({ project: { ...makeReport().project, finalStatus: 'cancelled' } }),
        );
        expect(html).toMatch(/status-dot red[^"]*"><\/span><span class="status-label">Status/);
    });

    it('omits the subtitle (summary) block when summary is null', () => {
        const html = renderBuildReportHtml(
            makeReport({ project: { ...makeReport().project, description: null, summary: null } }),
        );
        expect(html).not.toContain('class="subtitle"');
    });

    it('omits the workspace section when fileCount is zero', () => {
        const html = renderBuildReportHtml(
            makeReport({ workspace: { fileCount: 0, totalBytes: 0, totalLines: 0, byExtension: [] } }),
        );
        expect(html).not.toContain('Workspace artifacts');
    });

    it('always includes the KageOps brand mark + footer link', () => {
        const html = renderBuildReportHtml(makeReport());
        expect(html).toContain('class="brand-mark"');
        expect(html).toContain('kageops.ai');
    });
});

describe('generateAndSaveBuildReport', () => {
    let tmpRoot: string;
    let tmpDataDir: string;
    let originalDataDir: string | undefined;

    beforeEach(() => {
        tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bsm-'));
        tmpDataDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bsm-data-'));
        originalDataDir = process.env['KAGEOPS_DATA_DIR'];
        process.env['KAGEOPS_DATA_DIR'] = tmpDataDir;
        mockDb.getOne.mockReset();
        mockDb.getMany.mockReset();
    });

    afterEach(() => {
        if (originalDataDir === undefined) delete process.env['KAGEOPS_DATA_DIR'];
        else process.env['KAGEOPS_DATA_DIR'] = originalDataDir;
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* */ }
    });

    it('writes the report to both workspace and central paths', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-1', name: 'Test', description: null, repo_path: tmpRoot,
            phase: 'launch-growth', status: 'completed', trust_level: 'high',
            agent_config_preset: 'ollama', budget_usd: '0.50',
            created_at: '2026-05-10T10:00:00Z', updated_at: '2026-05-10T10:30:00Z',
        });
        mockDb.getMany.mockResolvedValueOnce([]); // by-agent
        mockDb.getMany.mockResolvedValueOnce([]); // by-phase
        mockDb.getMany.mockResolvedValueOnce([]); // tasks

        const result = await generateAndSaveBuildReport('proj-1');

        expect(result.workspacePath).toBe(path.join(tmpRoot, 'build-report.html'));
        expect(fs.existsSync(result.workspacePath!)).toBe(true);
        expect(fs.existsSync(result.centralPath)).toBe(true);
        expect(result.centralPath).toContain(tmpDataDir);
        expect(result.centralPath).toContain('proj-1.html');
        // Slug fallback uses 'project' when name has no alphanumerics
        expect(result.centralPath).toContain('test-proj-1.html');
    });

    it('still writes the central report when the workspace path is missing', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            id: 'proj-2', name: 'NoRepo', description: null,
            repo_path: '/nonexistent/path/that/cannot/be/created',
            phase: 'discovery', status: 'completed', trust_level: 'low',
            agent_config_preset: null, budget_usd: null,
            created_at: '2026-05-10T10:00:00Z', updated_at: '2026-05-10T10:01:00Z',
        });
        mockDb.getMany.mockResolvedValue([]);

        const result = await generateAndSaveBuildReport('proj-2');
        expect(fs.existsSync(result.centralPath)).toBe(true);
    });

    it('throws when project is not found in DB', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        mockDb.getMany.mockResolvedValue([]);
        await expect(generateAndSaveBuildReport('proj-missing'))
            .rejects.toThrow(/not found in database/);
    });

    it('aggregates cost data from byAgent rows into total fields', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            id: 'p', name: 'Aggregate', description: null, repo_path: tmpRoot,
            phase: 'development', status: 'completed', trust_level: 'medium',
            agent_config_preset: 'openrouter_budget', budget_usd: '1.00',
            created_at: '2026-05-10T10:00:00Z', updated_at: '2026-05-10T10:30:00Z',
        });
        mockDb.getMany.mockResolvedValueOnce([
            { agent: 'forge', model_used: 'sonnet', cost_usd: '0.30', tokens_in: '5000', tokens_out: '3000', calls: '5' },
            { agent: 'scout', model_used: 'haiku',  cost_usd: '0.10', tokens_in: '2000', tokens_out: '1000', calls: '3' },
        ]);
        mockDb.getMany.mockResolvedValueOnce([]); // by-phase
        mockDb.getMany.mockResolvedValueOnce([]); // tasks

        const { report } = await generateAndSaveBuildReport('p');
        expect(report.cost.totalUsd).toBeCloseTo(0.40, 5);
        expect(report.cost.totalTokensIn).toBe(7000);
        expect(report.cost.totalTokensOut).toBe(4000);
        expect(report.cost.callCount).toBe(8);
        expect(report.cost.byAgent).toHaveLength(2);
    });
});

describe('extractBrief', () => {
    it('returns null summary and empty requirements for empty / null descriptions', () => {
        expect(extractBrief(null)).toEqual({ summary: null, requirements: [] });
        expect(extractBrief('')).toEqual({ summary: null, requirements: [] });
        expect(extractBrief('   \n  ')).toEqual({ summary: null, requirements: [] });
    });

    it('keeps the summary short (does not dump the full prompt)', () => {
        const longPrompt = ('This is a meal-planning app for busy parents. ').repeat(40);
        const { summary } = extractBrief(longPrompt);
        expect(summary).not.toBeNull();
        expect(summary!.length).toBeLessThanOrEqual(221);
        expect(summary!).not.toBe(longPrompt);
    });

    it('extracts bullet-list requirements (-, *, 1.)', () => {
        const desc = `Build a recipe app.

- Must support vegetarian filters
* Should export shopping lists as PDF
1. The user can save favourites`;
        const { requirements } = extractBrief(desc);
        expect(requirements).toHaveLength(3);
        expect(requirements[0]).toContain('vegetarian');
        expect(requirements[1]).toContain('PDF');
        expect(requirements[2]).toContain('favourites');
    });

    it('extracts "must / should / need to" sentences as requirements', () => {
        const desc = `A note-taking tool.
Must support markdown.
The app should sync across devices.
Need to work offline.`;
        const { requirements } = extractBrief(desc);
        expect(requirements.length).toBeGreaterThanOrEqual(3);
    });

    it('caps requirements at 8 items so very long briefs do not blow out the report', () => {
        const items = Array.from({ length: 20 }, (_, i) => `- requirement number ${i}`);
        const { requirements } = extractBrief(['Header.', ...items].join('\n'));
        expect(requirements).toHaveLength(8);
    });

    it('skips code fences and markdown headings', () => {
        const desc = `# Title to skip\n\nReal summary sentence.\n\n\`\`\`\nconst x = 1;\n\`\`\``;
        const { summary, requirements } = extractBrief(desc);
        expect(summary).toContain('Real summary sentence');
        expect(summary).not.toContain('const x');
        expect(requirements).toHaveLength(0);
    });
});

describe('billing-friendly cost section', () => {
    it('uses "Cost base · billable to client" wording and the markup-aware note', () => {
        const html = renderBuildReportHtml(makeReport());
        expect(html).toContain('Cost base · billable to client');
        expect(html).toContain('Project Cost Base');
        expect(html).toContain('Apply your own markup');
    });
});

describe('subscribeBuildSummaryGenerator', () => {
    beforeEach(() => {
        // Reset the hoisted DB mocks — earlier describe blocks leave call history
        mockDb.getOne.mockReset();
        mockDb.getMany.mockReset();
    });

    it('registers a project.completed handler on the event bus', () => {
        const subscribe = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscribeBuildSummaryGenerator({ subscribe } as any);
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe).toHaveBeenCalledWith('project.completed', expect.any(Function));
    });

    it('handler skips events without a projectId (no DB queries)', async () => {
        let registeredHandler: ((event: { data?: unknown; projectId?: string }) => Promise<void>) | undefined;
        const subscribe = vi.fn((_channel, handler: (e: { data?: unknown; projectId?: string }) => Promise<void>) => {
            registeredHandler = handler;
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscribeBuildSummaryGenerator({ subscribe } as any);
        expect(registeredHandler).toBeDefined();

        await registeredHandler!({ data: {} });

        expect(mockDb.getOne).not.toHaveBeenCalled();
        expect(mockDb.getMany).not.toHaveBeenCalled();
    });
});
