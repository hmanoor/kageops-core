/**
 * Tests for the env-to-ProviderRegistry binding helper.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveDesignProviderId,
    buildProviderRegistryFromEnv,
} from '../../src/agents/design/registry-from-env';
import { DEFAULT_DESIGN_PROVIDER } from '../../src/agents/design/design-provider';

describe('resolveDesignProviderId', () => {
    it('defaults when env var is absent', () => {
        expect(resolveDesignProviderId({})).toBe(DEFAULT_DESIGN_PROVIDER);
    });

    it('defaults when env var is empty', () => {
        expect(resolveDesignProviderId({ KAGEOPS_DESIGN_PROVIDER: '' })).toBe(
            DEFAULT_DESIGN_PROVIDER
        );
    });

    it('accepts valid provider ids', () => {
        expect(
            resolveDesignProviderId({ KAGEOPS_DESIGN_PROVIDER: 'claude-ui' })
        ).toBe('claude-ui');
        expect(resolveDesignProviderId({ KAGEOPS_DESIGN_PROVIDER: 'v0' })).toBe('v0');
    });

    it('falls back to default on unknown values', () => {
        expect(
            resolveDesignProviderId({ KAGEOPS_DESIGN_PROVIDER: 'stitch' })
        ).toBe(DEFAULT_DESIGN_PROVIDER);
    });
});

describe('buildProviderRegistryFromEnv', () => {
    it('registers in-house and claude-ui by default', () => {
        const r = buildProviderRegistryFromEnv({
            inHouseModel: 'deepseek/deepseek-chat',
            env: {},
        });
        expect(r.list()).toContain('in-house');
        expect(r.list()).toContain('claude-ui');
    });

    it('omits claude-ui when opted out and no env present', () => {
        const r = buildProviderRegistryFromEnv({
            inHouseModel: 'deepseek/deepseek-chat',
            alwaysRegisterClaudeUi: false,
            env: {},
        });
        expect(r.list()).not.toContain('claude-ui');
    });

    it('registers claude-ui when env var is present even with opt-out flag', () => {
        const r = buildProviderRegistryFromEnv({
            inHouseModel: 'deepseek/deepseek-chat',
            alwaysRegisterClaudeUi: false,
            env: { KAGEOPS_CLAUDE_UI_MODEL: 'claude/claude-sonnet-4-6' },
        });
        expect(r.list()).toContain('claude-ui');
    });

    it('registers v0 only when V0_API_KEY is set', () => {
        const without = buildProviderRegistryFromEnv({
            inHouseModel: 'deepseek/deepseek-chat',
            env: {},
        });
        expect(without.list()).not.toContain('v0');

        const withKey = buildProviderRegistryFromEnv({
            inHouseModel: 'deepseek/deepseek-chat',
            env: { V0_API_KEY: 'sk-test' },
        });
        expect(withKey.list()).toContain('v0');
    });

    it('resolves KAGEOPS_DESIGN_PROVIDER through the returned registry', () => {
        const r = buildProviderRegistryFromEnv({
            inHouseModel: 'deepseek/deepseek-chat',
            env: { KAGEOPS_DESIGN_PROVIDER: 'claude-ui' },
        });
        const id = resolveDesignProviderId({
            KAGEOPS_DESIGN_PROVIDER: 'claude-ui',
        });
        expect(r.resolve(id).name).toBe('claude-ui');
    });
});
