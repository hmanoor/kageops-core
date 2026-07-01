/**
 * Tests for src/learning/apply-winner.ts (B-476)
 *
 * Covers:
 *   1. Rejects non-APO-eligible agents
 *   2. Rejects empty winner prompt
 *   3. Throws when preset file is missing / not JSON / has no `agents` object
 *   4. Writes `systemPromptOverride` under the target agent
 *   5. Creates the agent entry if the preset file omits it
 *   6. Preserves every other agent, the defaults block, and unknown fields
 *   7. Is idempotent — second call with identical winner is a no-op
 *   8. Writes an `.apo-backup-<ts>.json` copy of the previous file state
 *   9. Uses atomic write — tmp file appears, then rename produces final path
 *
 * Uses an in-memory fs stub — no access to the real `~/.kageops/`.
 */

import { describe, it, expect } from 'vitest';
import { applyWinner, type FsLike } from '../../src/learning/apply-winner';

// ── In-memory fs stub ────────────────────────────────

interface MemFs extends FsLike {
    readonly files: Map<string, string>;
    readonly writes: string[];
    readonly renames: Array<{ from: string; to: string }>;
}

function makeFs(initial: Record<string, string> = {}): MemFs {
    const files = new Map<string, string>(Object.entries(initial));
    const writes: string[] = [];
    const renames: Array<{ from: string; to: string }> = [];

    const fsImpl = {
        existsSync(p: unknown): boolean {
            return files.has(String(p));
        },
        readFileSync(p: unknown, _enc?: unknown): string {
            const key = String(p);
            const value = files.get(key);
            if (value === undefined) {
                throw new Error(`ENOENT: ${key}`);
            }
            return value;
        },
        writeFileSync(p: unknown, data: unknown, _enc?: unknown): void {
            const key = String(p);
            files.set(key, String(data));
            writes.push(key);
        },
        renameSync(from: unknown, to: unknown): void {
            const fromKey = String(from);
            const toKey = String(to);
            const value = files.get(fromKey);
            if (value === undefined) {
                throw new Error(`ENOENT: ${fromKey}`);
            }
            files.set(toKey, value);
            files.delete(fromKey);
            renames.push({ from: fromKey, to: toKey });
        },
    } as FsLike;

    return Object.assign(fsImpl as MemFs, { files, writes, renames });
}

const PRESET = '/tmp/kageops-test/agent-config.test.json';
const FIXED_TS = 1_700_000_000_000;
const clock = (): number => FIXED_TS;

function baseConfig(): object {
    return {
        defaults: { model: 'openrouter/google/gemini-2.5-flash', maxTokens: 4096 },
        agents: {
            scout: { model: 'openrouter/google/gemini-2.5-flash' },
            herald: { model: 'openrouter/google/gemini-2.5-flash' },
            pixel: { model: 'openrouter/google/gemini-2.5-flash' },
            sensei: { model: 'openrouter/anthropic/claude-sonnet-4' },
        },
    };
}

// ── Tests ────────────────────────────────────────────

describe('applyWinner', () => {
    describe('input validation', () => {
        it('rejects agents outside APO_ELIGIBLE_AGENTS', () => {
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(baseConfig()) });
            expect(() =>
                applyWinner({
                    agentName: 'sensei',
                    winner: 'new prompt',
                    presetPath: PRESET,
                    fs: fsImpl,
                    now: clock,
                })
            ).toThrow(/not APO-eligible/);
            expect(fsImpl.writes).toHaveLength(0);
        });

        it('rejects empty winner prompt', () => {
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(baseConfig()) });
            expect(() =>
                applyWinner({
                    agentName: 'scout',
                    winner: '   ',
                    presetPath: PRESET,
                    fs: fsImpl,
                    now: clock,
                })
            ).toThrow(/winner prompt is empty/);
        });
    });

    describe('preset file errors', () => {
        it('throws when the preset file is missing', () => {
            const fsImpl = makeFs({});
            expect(() =>
                applyWinner({
                    agentName: 'scout',
                    winner: 'x',
                    presetPath: PRESET,
                    fs: fsImpl,
                    now: clock,
                })
            ).toThrow(/preset file does not exist/);
        });

        it('throws when the preset file is not valid JSON', () => {
            const fsImpl = makeFs({ [PRESET]: '{not json' });
            expect(() =>
                applyWinner({
                    agentName: 'scout',
                    winner: 'x',
                    presetPath: PRESET,
                    fs: fsImpl,
                    now: clock,
                })
            ).toThrow(/not valid JSON/);
        });

        it('throws when the preset has no "agents" object', () => {
            const fsImpl = makeFs({
                [PRESET]: JSON.stringify({ defaults: { model: 'x' } }),
            });
            expect(() =>
                applyWinner({
                    agentName: 'scout',
                    winner: 'x',
                    presetPath: PRESET,
                    fs: fsImpl,
                    now: clock,
                })
            ).toThrow(/no "agents" object/);
        });
    });

    describe('happy path', () => {
        it('writes systemPromptOverride under the target agent', () => {
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(baseConfig()) });
            const result = applyWinner({
                agentName: 'scout',
                winner: 'You are an optimized Scout.',
                presetPath: PRESET,
                fs: fsImpl,
                now: clock,
            });

            expect(result.changed).toBe(true);
            expect(result.previousPrompt).toBeNull();
            expect(result.newPrompt).toBe('You are an optimized Scout.');

            const updated = JSON.parse(fsImpl.files.get(PRESET) ?? '') as {
                agents: Record<string, Record<string, unknown>>;
            };
            expect(updated.agents['scout']?.['systemPromptOverride']).toBe(
                'You are an optimized Scout.'
            );
            // Preserves the existing model field
            expect(updated.agents['scout']?.['model']).toBe(
                'openrouter/google/gemini-2.5-flash'
            );
        });

        it('creates the agent entry when the preset omits it', () => {
            const config = {
                defaults: { model: 'x' },
                agents: { sensei: { model: 'y' } },
            };
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(config) });
            const result = applyWinner({
                agentName: 'herald',
                winner: 'optimized herald',
                presetPath: PRESET,
                fs: fsImpl,
                now: clock,
            });

            expect(result.changed).toBe(true);
            const updated = JSON.parse(fsImpl.files.get(PRESET) ?? '') as {
                agents: Record<string, Record<string, unknown>>;
            };
            expect(updated.agents['herald']).toEqual({
                systemPromptOverride: 'optimized herald',
            });
            // Sensei entry is untouched
            expect(updated.agents['sensei']).toEqual({ model: 'y' });
        });

        it('preserves other agents, defaults, and unknown top-level keys', () => {
            const config: Record<string, unknown> = {
                ...baseConfig(),
                _comment: 'hand-authored, do not lose',
            };
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(config) });
            applyWinner({
                agentName: 'pixel',
                winner: 'new pixel prompt',
                presetPath: PRESET,
                fs: fsImpl,
                now: clock,
            });

            const updated = JSON.parse(fsImpl.files.get(PRESET) ?? '') as Record<
                string,
                unknown
            >;
            expect(updated['_comment']).toBe('hand-authored, do not lose');
            expect(
                (updated['defaults'] as Record<string, unknown>)['maxTokens']
            ).toBe(4096);
            expect(
                (updated['agents'] as Record<string, Record<string, unknown>>)['scout']?.[
                    'model'
                ]
            ).toBe('openrouter/google/gemini-2.5-flash');
            expect(
                (updated['agents'] as Record<string, Record<string, unknown>>)[
                    'pixel'
                ]?.['systemPromptOverride']
            ).toBe('new pixel prompt');
        });
    });

    describe('idempotence', () => {
        it('is a no-op when the winner matches the existing override', () => {
            const config = baseConfig() as {
                agents: Record<string, Record<string, unknown>>;
            };
            config.agents['scout'] = {
                ...config.agents['scout'],
                systemPromptOverride: 'already optimized',
            };
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(config) });

            const result = applyWinner({
                agentName: 'scout',
                winner: 'already optimized',
                presetPath: PRESET,
                fs: fsImpl,
                now: clock,
            });

            expect(result.changed).toBe(false);
            expect(result.previousPrompt).toBe('already optimized');
            expect(result.backupPath).toBeNull();
            expect(fsImpl.writes).toHaveLength(0);
            expect(fsImpl.renames).toHaveLength(0);
        });
    });

    describe('atomic write + backup', () => {
        it('writes a backup of the old state and renames tmp → preset', () => {
            const originalJson = JSON.stringify(baseConfig());
            const fsImpl = makeFs({ [PRESET]: originalJson });

            const result = applyWinner({
                agentName: 'herald',
                winner: 'v2 herald',
                presetPath: PRESET,
                fs: fsImpl,
                now: clock,
            });

            // Backup path includes the timestamp
            expect(result.backupPath).toBe(
                `${PRESET}.apo-backup-${FIXED_TS}.json`
            );
            expect(fsImpl.files.get(result.backupPath ?? '')).toBe(originalJson);

            // Exactly one rename from tmp → preset
            expect(fsImpl.renames).toHaveLength(1);
            expect(fsImpl.renames[0]?.to).toBe(PRESET);
            expect(fsImpl.renames[0]?.from).toMatch(/\.tmp-\d+-\d+$/);
        });

        it('returns previousPrompt when one already exists', () => {
            const config = baseConfig() as {
                agents: Record<string, Record<string, unknown>>;
            };
            config.agents['scout'] = {
                ...config.agents['scout'],
                systemPromptOverride: 'old prompt',
            };
            const fsImpl = makeFs({ [PRESET]: JSON.stringify(config) });

            const result = applyWinner({
                agentName: 'scout',
                winner: 'new prompt',
                presetPath: PRESET,
                fs: fsImpl,
                now: clock,
            });

            expect(result.previousPrompt).toBe('old prompt');
            expect(result.newPrompt).toBe('new prompt');
            expect(result.changed).toBe(true);
        });
    });
});
