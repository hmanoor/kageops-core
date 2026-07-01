/**
 * Tests for the pluggable DesignProvider surface.
 *
 * Covers: pure helpers (cost calc, file parsing), registry resolution
 * and fallback, unpriced-opt-in enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient } from 'v0-sdk';
import {
    DesignProviderError,
    isDesignProviderId,
    DEFAULT_DESIGN_PROVIDER,
} from '../../src/agents/design/design-provider';
import { parseDesignFiles } from '../../src/agents/design/in-house-provider';
import {
    computeV0Cost,
    extractV0Files,
    V0Provider,
} from '../../src/agents/design/v0-provider';
import { ProviderRegistry } from '../../src/agents/design/provider-registry';
import {
    ClaudeUiProvider,
    DEFAULT_CLAUDE_UI_MODEL,
} from '../../src/agents/design/claude-ui-provider';

vi.mock('v0-sdk', () => ({
    createClient: vi.fn(),
}));

const mockedCreateClient = vi.mocked(createClient);

// ── design-provider.ts ───────────────────────────────

describe('isDesignProviderId', () => {
    it('accepts known ids', () => {
        expect(isDesignProviderId('in-house')).toBe(true);
        expect(isDesignProviderId('claude-ui')).toBe(true);
        expect(isDesignProviderId('v0')).toBe(true);
        expect(isDesignProviderId('figma')).toBe(true);
        expect(isDesignProviderId('locofy')).toBe(true);
    });

    it('rejects unknown or malformed values', () => {
        expect(isDesignProviderId('stitch')).toBe(false);
        expect(isDesignProviderId(null)).toBe(false);
        expect(isDesignProviderId(42)).toBe(false);
        expect(isDesignProviderId(undefined)).toBe(false);
    });
});

describe('DEFAULT_DESIGN_PROVIDER', () => {
    it('defaults to in-house so no project is accidentally billed to an external service', () => {
        expect(DEFAULT_DESIGN_PROVIDER).toBe('in-house');
    });
});

// ── in-house-provider.ts ─────────────────────────────

describe('parseDesignFiles', () => {
    it('extracts a single file block', () => {
        const out = `prose\n--- FILE: index.html ---\n<div>hi</div>\n--- END FILE ---\ntrailing`;
        expect(parseDesignFiles(out)).toEqual([
            { path: 'index.html', content: '<div>hi</div>' },
        ]);
    });

    it('extracts multiple file blocks preserving order', () => {
        const out = [
            '--- FILE: index.html ---',
            '<html/>',
            '--- END FILE ---',
            '',
            '--- FILE: script.js ---',
            'console.log(1);',
            '--- END FILE ---',
        ].join('\n');
        expect(parseDesignFiles(out)).toEqual([
            { path: 'index.html', content: '<html/>' },
            { path: 'script.js', content: 'console.log(1);' },
        ]);
    });

    it('returns empty when no blocks present', () => {
        expect(parseDesignFiles('no blocks here')).toEqual([]);
    });
});

// ── v0-provider.ts ───────────────────────────────────

describe('computeV0Cost', () => {
    it('matches published mini tier: $1/M in, $5/M out', () => {
        // 1M in + 1M out on mini = $1 + $5 = $6
        expect(computeV0Cost('mini', 1_000_000, 1_000_000)).toBeCloseTo(6, 6);
    });

    it('matches published max-fast tier: $30/M in, $150/M out', () => {
        expect(computeV0Cost('max-fast', 100_000, 100_000)).toBeCloseTo(
            (30 + 150) * 0.1,
            6
        );
    });

    it('returns 0 for zero tokens', () => {
        expect(computeV0Cost('pro', 0, 0)).toBe(0);
    });
});

describe('V0Provider availability', () => {
    it('reports unavailable without an API key', async () => {
        const p = new V0Provider({ apiKey: '', tier: 'mini' });
        expect(await p.isAvailable()).toBe(false);
    });

    it('reports available when API key is set', async () => {
        const p = new V0Provider({ apiKey: 'sk-test', tier: 'mini' });
        expect(await p.isAvailable()).toBe(true);
    });

    it('estimate reports published confidence (budget-kill compatible)', async () => {
        const p = new V0Provider({ apiKey: 'sk-test', tier: 'mini' });
        const est = await p.estimateCost({
            projectId: 'p',
            title: 't',
            description: 'd',
            outputKind: 'react',
        });
        expect(est.confidence).toBe('published');
        expect(est.usd).toBeGreaterThan(0);
    });

    it('generateUI throws DesignProviderError when API key is missing', async () => {
        const p = new V0Provider({ apiKey: '', tier: 'mini' });
        await expect(
            p.generateUI({
                projectId: 'p',
                title: 't',
                description: 'd',
                outputKind: 'react',
            })
        ).rejects.toThrow(DesignProviderError);
    });
});

describe('extractV0Files', () => {
    it('prefers latestVersion.files when present', () => {
        const out = extractV0Files({
            latestVersion: {
                files: [
                    { name: 'index.html', content: '<h1>hi</h1>' },
                    { name: 'style.css', content: 'body{}' },
                ],
            },
            text: 'fallback should be ignored',
        });
        expect(out).toEqual([
            { path: 'index.html', content: '<h1>hi</h1>' },
            { path: 'style.css', content: 'body{}' },
        ]);
    });

    it('falls back to parseDesignFiles on text when latestVersion.files is empty', () => {
        const out = extractV0Files({
            latestVersion: { files: [] },
            text: '--- FILE: app.tsx ---\nexport const A = 1;\n--- END FILE ---',
        });
        expect(out).toEqual([
            { path: 'app.tsx', content: 'export const A = 1;' },
        ]);
    });

    it('falls back to a single markdown file when no FILE blocks parse', () => {
        const out = extractV0Files({ text: 'Just some prose.' });
        expect(out).toEqual([
            { path: 'designs/v0.md', content: 'Just some prose.' },
        ]);
    });

    it('returns empty array when response is empty', () => {
        expect(extractV0Files({})).toEqual([]);
    });
});

describe('V0Provider.generateUI (mocked v0-sdk)', () => {
    const spec = {
        projectId: 'p',
        title: 'Landing',
        description: 'Hero + CTA',
        outputKind: 'html' as const,
    };

    beforeEach(() => {
        mockedCreateClient.mockReset();
    });

    it('maps latestVersion.files onto DesignFile[] and reports published cost', async () => {
        const chatsCreate = vi.fn().mockResolvedValue({
            latestVersion: {
                id: 'v_1',
                object: 'version',
                status: 'completed',
                createdAt: '2026-04-25T00:00:00Z',
                files: [
                    { object: 'file', name: 'index.html', content: '<h1>Hi</h1>', locked: false },
                ],
                demoUrl: 'https://demo.v0.dev/abc',
            },
            text: '',
            webUrl: 'https://v0.dev/chat/abc',
        });
        mockedCreateClient.mockReturnValue({
            chats: { create: chatsCreate },
        } as unknown as ReturnType<typeof createClient>);

        const p = new V0Provider({
            apiKey: 'sk-test',
            tier: 'mini',
            estimatedTokensIn: 1_000_000,
            estimatedTokensOut: 1_000_000,
        });
        const artifact = await p.generateUI(spec);

        expect(mockedCreateClient).toHaveBeenCalledWith({ apiKey: 'sk-test' });
        expect(chatsCreate).toHaveBeenCalledTimes(1);
        const call = chatsCreate.mock.calls[0][0];
        expect(call.modelConfiguration.modelId).toBe('v0-mini');
        expect(call.responseMode).toBe('sync');
        expect(typeof call.message).toBe('string');
        expect(call.message).toContain('Landing');

        expect(artifact.provider).toBe('v0');
        expect(artifact.files).toEqual([
            { path: 'index.html', content: '<h1>Hi</h1>' },
        ]);
        expect(artifact.previewUrl).toBe('https://demo.v0.dev/abc');
        // Mini: $1/M in + $5/M out, 1M+1M = $6.
        expect(artifact.costUsd).toBeCloseTo(6, 6);
        expect(artifact.kind).toBe('html');
    });

    it('maps each tier to the corresponding v0-sdk modelId', async () => {
        const chatsCreate = vi.fn().mockResolvedValue({
            latestVersion: {
                files: [{ object: 'file', name: 'a.html', content: 'x', locked: false }],
            },
            text: '',
            webUrl: 'https://v0.dev/c/x',
        });
        mockedCreateClient.mockReturnValue({
            chats: { create: chatsCreate },
        } as unknown as ReturnType<typeof createClient>);

        const tiers: Array<['mini' | 'pro' | 'max' | 'max-fast', string]> = [
            ['mini', 'v0-mini'],
            ['pro', 'v0-pro'],
            ['max', 'v0-max'],
            ['max-fast', 'v0-max-fast'],
        ];
        for (const [tier, expectedModelId] of tiers) {
            const p = new V0Provider({ apiKey: 'sk', tier });
            await p.generateUI(spec);
            const last = chatsCreate.mock.calls.at(-1)![0];
            expect(last.modelConfiguration.modelId).toBe(expectedModelId);
        }
    });

    it('falls back to webUrl when latestVersion has no demoUrl', async () => {
        mockedCreateClient.mockReturnValue({
            chats: {
                create: vi.fn().mockResolvedValue({
                    latestVersion: {
                        files: [{ object: 'file', name: 'a.html', content: 'x', locked: false }],
                    },
                    text: '',
                    webUrl: 'https://v0.dev/chat/xyz',
                }),
            },
        } as unknown as ReturnType<typeof createClient>);

        const p = new V0Provider({ apiKey: 'sk', tier: 'mini' });
        const artifact = await p.generateUI(spec);
        expect(artifact.previewUrl).toBe('https://v0.dev/chat/xyz');
    });

    it('wraps SDK errors in DesignProviderError with cause preserved', async () => {
        const sdkErr = new Error('network down');
        mockedCreateClient.mockReturnValue({
            chats: { create: vi.fn().mockRejectedValue(sdkErr) },
        } as unknown as ReturnType<typeof createClient>);

        const p = new V0Provider({ apiKey: 'sk', tier: 'mini' });
        await expect(p.generateUI(spec)).rejects.toMatchObject({
            name: 'DesignProviderError',
            provider: 'v0',
            recoverable: true,
            cause: sdkErr,
        });
    });

    it('throws DesignProviderError when v0 returns empty response', async () => {
        mockedCreateClient.mockReturnValue({
            chats: { create: vi.fn().mockResolvedValue({ text: '', webUrl: 'u' }) },
        } as unknown as ReturnType<typeof createClient>);

        const p = new V0Provider({ apiKey: 'sk', tier: 'mini' });
        await expect(p.generateUI(spec)).rejects.toThrow(DesignProviderError);
    });

    it('throws non-recoverable DesignProviderError when SDK returns a streaming response', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
        mockedCreateClient.mockReturnValue({
            chats: { create: vi.fn().mockResolvedValue(stream) },
        } as unknown as ReturnType<typeof createClient>);

        const p = new V0Provider({ apiKey: 'sk', tier: 'mini' });
        await expect(p.generateUI(spec)).rejects.toMatchObject({
            name: 'DesignProviderError',
            provider: 'v0',
            recoverable: false,
        });
    });
});

// ── provider-registry.ts ─────────────────────────────

describe('ProviderRegistry', () => {
    const baseConfig = {
        inHouse: { model: 'deepseek/deepseek-chat' },
    };

    it('always includes in-house', () => {
        const r = new ProviderRegistry(baseConfig);
        expect(r.list()).toContain('in-house');
    });

    it('includes v0 only when configured', () => {
        expect(new ProviderRegistry(baseConfig).list()).not.toContain('v0');
        const withV0 = new ProviderRegistry({
            ...baseConfig,
            v0: { apiKey: 'sk', tier: 'mini' },
        });
        expect(withV0.list()).toContain('v0');
    });

    it('resolves requested provider when present', () => {
        const r = new ProviderRegistry({
            ...baseConfig,
            v0: { apiKey: 'sk', tier: 'mini' },
        });
        expect(r.resolve('v0').name).toBe('v0');
    });

    it('falls back to in-house when requested provider is not configured', () => {
        const r = new ProviderRegistry(baseConfig);
        // v0 not configured → falls back, does NOT throw
        expect(r.resolve('v0').name).toBe('in-house');
    });

    it('falls back to in-house when requested is null/unknown', () => {
        const r = new ProviderRegistry(baseConfig);
        expect(r.resolve(null).name).toBe('in-house');
        expect(r.resolve('stitch').name).toBe('in-house');
    });

    describe('assertCostOk', () => {
        const originalEnv = process.env['KAGEOPS_ALLOW_UNPRICED_DESIGN'];

        beforeEach(() => {
            delete process.env['KAGEOPS_ALLOW_UNPRICED_DESIGN'];
        });

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env['KAGEOPS_ALLOW_UNPRICED_DESIGN'];
            } else {
                process.env['KAGEOPS_ALLOW_UNPRICED_DESIGN'] = originalEnv;
            }
        });

        it('allows published estimates', async () => {
            const r = new ProviderRegistry(baseConfig);
            await expect(
                r.assertCostOk(r.resolve('in-house'), { confidence: 'published' })
            ).resolves.toBeUndefined();
        });

        it('allows heuristic estimates (in-house default)', async () => {
            const r = new ProviderRegistry(baseConfig);
            await expect(
                r.assertCostOk(r.resolve('in-house'), { confidence: 'heuristic' })
            ).resolves.toBeUndefined();
        });

        it('rejects unknown-confidence estimates by default', async () => {
            const r = new ProviderRegistry(baseConfig);
            await expect(
                r.assertCostOk(r.resolve('in-house'), { confidence: 'unknown' })
            ).rejects.toThrow(/no published per-call pricing/);
        });

        it('allows unknown when opt-in env is set', async () => {
            process.env['KAGEOPS_ALLOW_UNPRICED_DESIGN'] = '1';
            const r = new ProviderRegistry(baseConfig);
            await expect(
                r.assertCostOk(r.resolve('in-house'), { confidence: 'unknown' })
            ).resolves.toBeUndefined();
        });
    });
});

// ── DesignProviderError ──────────────────────────────

// ── claude-ui-provider.ts ────────────────────────

describe('ClaudeUiProvider', () => {
    it('defaults to claude-cli/claude-opus-4-7 via the claude-cli/ prefix', () => {
        expect(DEFAULT_CLAUDE_UI_MODEL).toBe('claude-cli/claude-opus-4-7');
    });

    it('reports name = claude-ui', () => {
        const p = new ClaudeUiProvider();
        expect(p.name).toBe('claude-ui');
    });

    it('isAvailable returns true for default config', async () => {
        const p = new ClaudeUiProvider();
        expect(await p.isAvailable()).toBe(true);
    });

    it('isAvailable returns false when model is explicitly empty', async () => {
        const p = new ClaudeUiProvider({ model: '' });
        expect(await p.isAvailable()).toBe(false);
    });

    it('estimateCost uses published confidence on a Sonnet model', async () => {
        const p = new ClaudeUiProvider({ model: 'claude/claude-sonnet-4-6' });
        const est = await p.estimateCost({
            projectId: 'p',
            title: 'Landing page',
            description: 'Hero + features + footer',
            outputKind: 'html',
        });
        expect(est.confidence).toBe('published');
        expect(est.usd).toBeGreaterThan(0);
        // 8k max tokens out × $15/M output alone = $0.12 — sanity cap.
        expect(est.usd).toBeLessThan(1);
    });

    it('falls back to heuristic when model is not a Sonnet variant', async () => {
        const p = new ClaudeUiProvider({ model: 'claude/claude-haiku-3-5' });
        const est = await p.estimateCost({
            projectId: 'p',
            title: 't',
            description: 'd',
            outputKind: 'html',
        });
        expect(est.confidence).toBe('heuristic');
    });
});

describe('ProviderRegistry + claude-ui', () => {
    const baseConfig = {
        inHouse: { model: 'deepseek/deepseek-chat' },
    };

    it('includes claude-ui only when configured', () => {
        expect(new ProviderRegistry(baseConfig).list()).not.toContain(
            'claude-ui'
        );
        const withClaude = new ProviderRegistry({
            ...baseConfig,
            claudeUi: {},
        });
        expect(withClaude.list()).toContain('claude-ui');
    });

    it('resolves claude-ui when requested and configured', () => {
        const r = new ProviderRegistry({
            ...baseConfig,
            claudeUi: {},
        });
        expect(r.resolve('claude-ui').name).toBe('claude-ui');
    });

    it('falls back to in-house when claude-ui is requested but not configured', () => {
        const r = new ProviderRegistry(baseConfig);
        expect(r.resolve('claude-ui').name).toBe('in-house');
    });

    it('allows claude-ui through assertCostOk (published pricing)', async () => {
        const r = new ProviderRegistry({
            ...baseConfig,
            claudeUi: {},
        });
        const provider = r.resolve('claude-ui');
        const est = await provider.estimateCost({
            projectId: 'p',
            title: 't',
            description: 'd',
            outputKind: 'html',
        });
        await expect(r.assertCostOk(provider, est)).resolves.toBeUndefined();
    });
});

describe('DesignProviderError', () => {
    it('prefixes message with provider name', () => {
        const err = new DesignProviderError('v0', 'rate limited', { recoverable: true });
        expect(err.message).toBe('[v0] rate limited');
        expect(err.provider).toBe('v0');
        expect(err.recoverable).toBe(true);
    });

    it('preserves cause for diagnostics', () => {
        const root = new Error('network down');
        const err = new DesignProviderError('v0', 'call failed', {
            recoverable: true,
            cause: root,
        });
        expect(err.cause).toBe(root);
    });
});
