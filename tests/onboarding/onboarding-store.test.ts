/**
 * OnboardingStore unit tests
 *
 * Covers disk round-trip, missing file, corrupted JSON, schema violations,
 * and env / override precedence for the data directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OnboardingStore } from '../../src/onboarding/onboarding-store';
import {
    createInitialState,
    OnboardingState,
} from '../../src/onboarding/onboarding-state';

// ── Temp dir helpers ─────────────────────────────────

async function makeTempDir(): Promise<string> {
    const prefix = path.join(os.tmpdir(), 'kageops-onboarding-test-');
    return fsp.mkdtemp(prefix);
}

async function removeDir(dir: string): Promise<void> {
    try {
        await fsp.rm(dir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }
}

// ── Tests ────────────────────────────────────────────

describe('OnboardingStore', () => {
    let tempDir: string;
    let store: OnboardingStore;

    beforeEach(async () => {
        tempDir = await makeTempDir();
        store = new OnboardingStore({ dataDir: tempDir });
    });

    afterEach(async () => {
        await removeDir(tempDir);
    });

    // ── Missing file ────────────────────────────────

    describe('read() — missing file', () => {
        it('returns a fresh initial state when the file does not exist', async () => {
            const state = await store.read();
            expect(state).toEqual(createInitialState());
        });

        it('does not create the file on read', async () => {
            await store.read();
            await expect(fsp.stat(store.getFilePath())).rejects.toThrow();
        });
    });

    // ── Round trip ──────────────────────────────────

    describe('round trip', () => {
        it('writes and reads back an initial state', async () => {
            const original = createInitialState();
            await store.write(original);
            const restored = await store.read();
            expect(restored).toEqual(original);
        });

        it('writes and reads back a completed state', async () => {
            const completed: OnboardingState = {
                step: 'ready',
                preset: 'claude-cli-premium',
                trustLevel: 'medium',
                providers: [
                    { name: 'claude', apiKeyConfigured: true },
                    { name: 'ollama', apiKeyConfigured: false },
                ],
                budgetCapUsd: 25,
                completedAt: new Date('2026-04-16T00:00:00Z').toISOString(),
            };
            await store.write(completed);
            const restored = await store.read();
            expect(restored).toEqual(completed);
        });

        it('round-trips a state with a null preset (mid-walkthrough)', async () => {
            const inFlight: OnboardingState = {
                step: 'preset',
                preset: null,
                trustLevel: null,
                providers: [],
                budgetCapUsd: null,
                completedAt: null,
            };
            await store.write(inFlight);
            const restored = await store.read();
            expect(restored).toEqual(inFlight);
        });

        it('overwrites previous file contents on subsequent writes', async () => {
            await store.write({
                ...createInitialState(),
                step: 'trust-level',
            });
            await store.write({
                ...createInitialState(),
                step: 'providers',
                trustLevel: 'high',
            });
            const restored = await store.read();
            expect(restored.step).toBe('providers');
            expect(restored.trustLevel).toBe('high');
        });

        it('creates the data directory if it does not exist', async () => {
            const nested = path.join(tempDir, 'nested', 'a', 'b');
            const deepStore = new OnboardingStore({ dataDir: nested });
            await deepStore.write(createInitialState());
            const stat = await fsp.stat(nested);
            expect(stat.isDirectory()).toBe(true);
        });
    });

    // ── Corrupted JSON ──────────────────────────────

    describe('read() — corrupted JSON', () => {
        it('returns fresh state when JSON is malformed', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(store.getFilePath(), '{ this is not valid json', 'utf-8');
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });

        it('returns fresh state when JSON is empty', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(store.getFilePath(), '', 'utf-8');
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });
    });

    // ── Schema violations ───────────────────────────

    describe('read() — schema violations', () => {
        it('returns fresh state when step is unknown', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(
                store.getFilePath(),
                JSON.stringify({
                    step: 'not-a-real-step',
                    preset: null,
                    trustLevel: null,
                    providers: [],
                    budgetCapUsd: null,
                    completedAt: null,
                }),
                'utf-8'
            );
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });

        it('returns fresh state when provider name is invalid', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(
                store.getFilePath(),
                JSON.stringify({
                    step: 'providers',
                    preset: 'claude-cli-premium',
                    trustLevel: 'low',
                    providers: [{ name: 'mistral', apiKeyConfigured: true }],
                    budgetCapUsd: null,
                    completedAt: null,
                }),
                'utf-8'
            );
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });

        it('returns fresh state when preset has invalid characters', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(
                store.getFilePath(),
                JSON.stringify({
                    step: 'trust-level',
                    preset: '../../etc/passwd',
                    trustLevel: null,
                    providers: [],
                    budgetCapUsd: null,
                    completedAt: null,
                }),
                'utf-8'
            );
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });

        it('returns fresh state when required fields are missing', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(
                store.getFilePath(),
                JSON.stringify({ step: 'welcome' }),
                'utf-8'
            );
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });

        it('returns fresh state when budgetCapUsd is not a number', async () => {
            await fsp.mkdir(tempDir, { recursive: true });
            await fsp.writeFile(
                store.getFilePath(),
                JSON.stringify({
                    step: 'ready',
                    preset: 'claude-cli-premium',
                    trustLevel: 'low',
                    providers: [{ name: 'claude', apiKeyConfigured: true }],
                    budgetCapUsd: 'twenty dollars',
                    completedAt: new Date().toISOString(),
                }),
                'utf-8'
            );
            const restored = await store.read();
            expect(restored).toEqual(createInitialState());
        });
    });

    // ── Data dir resolution ─────────────────────────

    describe('getDataDir()', () => {
        it('uses the constructor override when provided', () => {
            expect(store.getDataDir()).toBe(tempDir);
        });

        it('falls back to KAGEOPS_DATA_DIR when no override is given', () => {
            const prior = process.env['KAGEOPS_DATA_DIR'];
            process.env['KAGEOPS_DATA_DIR'] = tempDir;
            try {
                const envStore = new OnboardingStore();
                expect(envStore.getDataDir()).toBe(tempDir);
            } finally {
                if (prior === undefined) {
                    delete process.env['KAGEOPS_DATA_DIR'];
                } else {
                    process.env['KAGEOPS_DATA_DIR'] = prior;
                }
            }
        });

        it('getFilePath() puts onboarding.json inside the data dir', () => {
            expect(store.getFilePath()).toBe(path.join(tempDir, 'onboarding.json'));
        });
    });
});
