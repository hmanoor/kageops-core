/**
 * AppConfigStore tests
 *
 * Verifies load/save/get/set behaviour using a mocked fs module so
 * no real files are touched during the test run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs mock ──────────────────────────────────────────────────────────────────

const mockFs = vi.hoisted(() => ({
    existsSync: vi.fn(() => false as boolean),
    readFileSync: vi.fn(() => '' as string),
    writeFileSync: vi.fn(() => undefined),
    mkdirSync: vi.fn(() => undefined),
}));

vi.mock('fs', () => mockFs);

// os.homedir is used to build the path — keep it stable across tests
vi.mock('os', () => ({
    homedir: () => '/home/testuser',
}));

// ── helpers ──────────────────────────────────────────────────────────────────

// path.join uses the platform separator, so normalise when asserting
import * as path from 'path';
const EXPECTED_CONFIG_PATH = path.join('/home/testuser', '.kageops', 'agent-config.json');

const ALL_AGENTS = [
    'sensei', 'scout', 'blueprint', 'forge', 'vigil',
    'aegis', 'pixel', 'cipher', 'herald',
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('app-config-store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('loadAppAgentConfig returns defaults when file is missing', async () => {
        mockFs.existsSync.mockReturnValue(false);

        const { loadAppAgentConfig } = await import('../../src/main/app-config-store');
        const config = loadAppAgentConfig();

        expect(config.agents).toBeDefined();
        expect(Object.keys(config.agents)).toHaveLength(9);
        for (const name of ALL_AGENTS) {
            expect(config.agents[name]).toBeDefined();
            expect(config.agents[name]?.model).toBe('claude-sonnet-4-6');
            expect(config.agents[name]?.provider).toBe('claude');
        }
    });

    it('loadAppAgentConfig reads and parses an existing file', async () => {
        const stored = {
            agents: {
                forge: { model: 'gpt-4o', provider: 'openai', fallbackModels: ['ollama/llama3.2'] },
            },
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(stored));

        const { loadAppAgentConfig } = await import('../../src/main/app-config-store');
        const config = loadAppAgentConfig();

        expect(config.agents['forge']?.model).toBe('gpt-4o');
        expect(config.agents['forge']?.provider).toBe('openai');
        expect(config.agents['forge']?.fallbackModels).toEqual(['ollama/llama3.2']);
        // Agents not in the file still use defaults
        expect(config.agents['scout']?.model).toBe('claude-sonnet-4-6');
    });

    it('saveAppAgentConfig writes correct JSON to the config path', async () => {
        mockFs.existsSync.mockReturnValue(true);

        const { saveAppAgentConfig } = await import('../../src/main/app-config-store');
        saveAppAgentConfig({
            agents: {
                sensei: { model: 'gpt-4o', provider: 'openai', fallbackModels: [] },
            },
        });

        expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
        const [writtenPath, writtenContent] = mockFs.writeFileSync.mock.calls[0] as [string, string, string];
        expect(writtenPath).toBe(EXPECTED_CONFIG_PATH);

        const parsed = JSON.parse(writtenContent) as { agents: Record<string, unknown> };
        expect(parsed.agents['sensei']).toEqual({
            model: 'gpt-4o',
            provider: 'openai',
            fallbackModels: [],
        });
    });

    it('getAgentModelConfig returns the correct per-agent config', async () => {
        const stored = {
            agents: {
                vigil: { model: 'mistral-large', provider: 'openrouter', fallbackModels: [] },
            },
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(stored));

        const { getAgentModelConfig } = await import('../../src/main/app-config-store');
        const entry = getAgentModelConfig('vigil');

        expect(entry.model).toBe('mistral-large');
        expect(entry.provider).toBe('openrouter');
    });

    it('setAgentModelConfig persists the change by calling writeFileSync', async () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify({ agents: {} }));

        const { setAgentModelConfig } = await import('../../src/main/app-config-store');
        setAgentModelConfig('scout', 'llama3.2', 'ollama', ['claude-sonnet-4-6']);

        expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
        const [, writtenContent] = mockFs.writeFileSync.mock.calls[0] as [string, string, string];
        const parsed = JSON.parse(writtenContent) as { agents: Record<string, { model: string; provider: string; fallbackModels: string[] }> };
        expect(parsed.agents['scout']?.model).toBe('llama3.2');
        expect(parsed.agents['scout']?.provider).toBe('ollama');
        expect(parsed.agents['scout']?.fallbackModels).toEqual(['claude-sonnet-4-6']);
    });

    it('default config covers all 9 agents', async () => {
        mockFs.existsSync.mockReturnValue(false);

        const { loadAppAgentConfig } = await import('../../src/main/app-config-store');
        const config = loadAppAgentConfig();

        for (const name of ALL_AGENTS) {
            expect(config.agents[name], `missing default for ${name}`).toBeDefined();
        }
    });

    it('getAgentModelConfig returns default model for an unknown agent name', async () => {
        mockFs.existsSync.mockReturnValue(false);

        const { getAgentModelConfig } = await import('../../src/main/app-config-store');
        const entry = getAgentModelConfig('unknown-agent-xyz');

        expect(entry.model).toBe('claude-sonnet-4-6');
        expect(entry.provider).toBe('claude');
    });

    it('roundtrip save+load preserves all agent data', async () => {
        const original = {
            agents: {
                forge: { model: 'claude-opus-4-5', provider: 'claude', fallbackModels: ['openai/gpt-4o'] },
                herald: { model: 'gpt-4o-mini', provider: 'openai', fallbackModels: [] },
            },
        };

        let savedContent = '';
        mockFs.existsSync.mockReturnValue(true);
        mockFs.writeFileSync.mockImplementation((_p: unknown, content: unknown) => {
            savedContent = content as string;
        });
        mockFs.readFileSync.mockImplementation(() => savedContent || JSON.stringify(original));

        const { saveAppAgentConfig, loadAppAgentConfig } = await import('../../src/main/app-config-store');

        saveAppAgentConfig(original);
        // Now readFileSync returns what was written
        mockFs.readFileSync.mockReturnValue(savedContent);

        const loaded = loadAppAgentConfig();
        expect(loaded.agents['forge']?.model).toBe('claude-opus-4-5');
        expect(loaded.agents['forge']?.fallbackModels).toEqual(['openai/gpt-4o']);
        expect(loaded.agents['herald']?.model).toBe('gpt-4o-mini');
        expect(loaded.agents['herald']?.fallbackModels).toEqual([]);
    });

    // ── Deprecated preset migration ──────────────────────────────────────────
    // Anchors v0.1.9's "codex-cli preset is paused" behaviour: an installed
    // user with codex-cli persisted in active-preset.txt must NOT be left
    // on a broken provider after upgrade — getActivePreset auto-migrates
    // them to the configured replacement (claude-cli).

    describe('getActivePreset deprecated-preset migration', () => {
        it('migrates codex-cli to claude-cli and rewrites the file', async () => {
            const activePresetPath = path.join('/home/testuser', '.kageops', 'active-preset.txt');
            mockFs.existsSync.mockImplementation((p) => p === activePresetPath);
            mockFs.readFileSync.mockReturnValue('codex-cli');

            const { getActivePreset } = await import('../../src/main/app-config-store');
            const resolved = getActivePreset();

            expect(resolved).toBe('claude-cli');
            // Migration writes the replacement back so subsequent reads
            // see the new value directly.
            const writeCalls = mockFs.writeFileSync.mock.calls as Array<[string, string, string]>;
            const migrationWrite = writeCalls.find((call) => call[0] === activePresetPath);
            expect(migrationWrite).toBeDefined();
            expect(migrationWrite?.[1]).toBe('claude-cli');
        });

        it('leaves non-deprecated presets untouched', async () => {
            const activePresetPath = path.join('/home/testuser', '.kageops', 'active-preset.txt');
            mockFs.existsSync.mockImplementation((p) => p === activePresetPath);
            mockFs.readFileSync.mockReturnValue('claude-cli-premium');

            const { getActivePreset } = await import('../../src/main/app-config-store');
            const resolved = getActivePreset();

            expect(resolved).toBe('claude-cli-premium');
            const writeCalls = mockFs.writeFileSync.mock.calls as Array<[string, string, string]>;
            const migrationWrite = writeCalls.find((call) => call[0] === activePresetPath);
            expect(migrationWrite).toBeUndefined();
        });

        it('honours KAGEOPS_PRESET=codex-cli env override (power-user escape hatch)', async () => {
            const activePresetPath = path.join('/home/testuser', '.kageops', 'active-preset.txt');
            const codexConfigPath = path.join('/home/testuser', '.kageops', 'agent-config.codex-cli.json');
            mockFs.existsSync.mockImplementation((p) => p === codexConfigPath || p === activePresetPath);
            const prev = process.env['KAGEOPS_PRESET'];
            process.env['KAGEOPS_PRESET'] = 'codex-cli';
            try {
                const { getActivePreset } = await import('../../src/main/app-config-store');
                const resolved = getActivePreset();
                expect(resolved).toBe('codex-cli');
            } finally {
                if (prev === undefined) {
                    delete process.env['KAGEOPS_PRESET'];
                } else {
                    process.env['KAGEOPS_PRESET'] = prev;
                }
            }
        });

        it('DEPRECATED_PRESET_REPLACEMENTS exposes the codex-cli → claude-cli mapping', async () => {
            const { DEPRECATED_PRESET_REPLACEMENTS } = await import('../../src/main/app-config-store');
            expect(DEPRECATED_PRESET_REPLACEMENTS['codex-cli']).toBe('claude-cli');
        });
    });
});
