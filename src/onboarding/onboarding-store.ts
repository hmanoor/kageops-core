/**
 * KageOps Onboarding Store
 *
 * JSON-file-backed persistence for the first-run onboarding state machine.
 * Writes to `<dataDir>/onboarding.json` where `dataDir` resolves as:
 *   1. `dataDirOverride` constructor arg (tests)
 *   2. `process.env.KAGEOPS_DATA_DIR`
 *   3. Electron's `app.getPath('userData')` (lazy-required so tests can
 *      construct the store without Electron being initialized)
 *
 * The read boundary validates external JSON with Zod, logs a warning on
 * failure, and falls back to a fresh state — never throws.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { createLogger } from '../shared/logger';
import {
    createInitialState,
    OnboardingState,
    OnboardingStep,
    TrustLevel,
    ProviderConfig,
    ProviderName,
} from './onboarding-state';

const log = createLogger('Onboarding');

// ── Zod Schemas ──────────────────────────────────────

const StepSchema: z.ZodType<OnboardingStep> = z.enum([
    'welcome',
    'preset',
    'trust-level',
    'providers',
    'budget-cap',
    'ready',
]);

const TrustLevelSchema: z.ZodType<TrustLevel> = z.enum(['low', 'medium', 'high']);

const ProviderNameSchema: z.ZodType<ProviderName> = z.enum([
    'claude',
    'openrouter',
    'ollama',
    'openai',
    'gemini',
]);

const ProviderConfigSchema: z.ZodType<ProviderConfig> = z.object({
    name: ProviderNameSchema,
    apiKeyConfigured: z.boolean(),
});

const OnboardingStateSchema: z.ZodType<OnboardingState> = z.object({
    step: StepSchema,
    preset: z
        .string()
        .max(64)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .nullable(),
    trustLevel: TrustLevelSchema.nullable(),
    providers: z.array(ProviderConfigSchema).readonly(),
    budgetCapUsd: z.number().finite().nullable(),
    completedAt: z.string().nullable(),
});

// ── Store ────────────────────────────────────────────

const FILE_NAME = 'onboarding.json';

export interface OnboardingStoreOptions {
    readonly dataDir?: string;
}

export class OnboardingStore {
    private readonly dataDirOverride: string | undefined;

    constructor(options: OnboardingStoreOptions = {}) {
        this.dataDirOverride = options.dataDir;
    }

    /**
     * Resolve the data directory. Electron's `app` is required lazily so the
     * store can be constructed in headless / test contexts.
     */
    public getDataDir(): string {
        if (this.dataDirOverride !== undefined) {
            return this.dataDirOverride;
        }
        const envDir = process.env['KAGEOPS_DATA_DIR'];
        if (envDir !== undefined && envDir !== '') {
            return envDir;
        }
        // Lazy Electron require — throws in non-Electron contexts, which is
        // fine: callers in those contexts must pass `dataDir` or set the env.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require('electron') as { app?: { getPath: (name: string) => string } };
        if (electron.app === undefined) {
            throw new Error(
                'OnboardingStore: no dataDir, no KAGEOPS_DATA_DIR, and Electron app not available.'
            );
        }
        return electron.app.getPath('userData');
    }

    public getFilePath(): string {
        return path.join(this.getDataDir(), FILE_NAME);
    }

    /**
     * Read the persisted state. Returns a fresh initial state if the file is
     * missing or corrupted. Never throws.
     */
    public async read(): Promise<OnboardingState> {
        const filePath = this.getFilePath();
        let raw: string;
        try {
            raw = await fsp.readFile(filePath, 'utf-8');
        } catch (err: unknown) {
            if (isNodeErrorWithCode(err, 'ENOENT')) {
                return createInitialState();
            }
            log.warn({ err, filePath }, 'Failed to read onboarding file — returning fresh state');
            return createInitialState();
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err: unknown) {
            log.warn({ err, filePath }, 'Corrupted onboarding JSON — returning fresh state');
            return createInitialState();
        }

        const validated = OnboardingStateSchema.safeParse(parsed);
        if (!validated.success) {
            log.warn(
                { errors: validated.error.flatten(), filePath },
                'Onboarding JSON failed schema validation — returning fresh state'
            );
            return createInitialState();
        }

        return validated.data;
    }

    /**
     * Persist the given state to disk. Creates the directory if needed.
     * Errors are logged and re-thrown so callers can react.
     */
    public async write(state: OnboardingState): Promise<void> {
        const dir = this.getDataDir();
        const filePath = this.getFilePath();
        try {
            await fsp.mkdir(dir, { recursive: true });
            const serialized = JSON.stringify(state, null, 2);
            await fsp.writeFile(filePath, serialized, 'utf-8');
        } catch (err: unknown) {
            log.error({ err, filePath }, 'Failed to write onboarding file');
            throw err;
        }
    }
}

// ── Helpers ──────────────────────────────────────────

function isNodeErrorWithCode(err: unknown, code: string): boolean {
    if (err === null || typeof err !== 'object') {
        return false;
    }
    const candidate = err as { code?: unknown };
    return candidate.code === code;
}
