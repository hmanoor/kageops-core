/**
 * Phase 2b — resolveAppEnvValues key-register fallback ordering.
 *
 * Verifies the resolution order without touching a real keychain or the
 * encrypted store: readers are injected directly.
 *   1. KAGEOPS_APP_ENV_FILE  (not exercised here)
 *   2. encrypted deployment_config  (commercial)
 *   3. OS-keychain key register  (open — phase 2b)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
    resolveAppEnvValues,
    setDeploymentConfigReader,
    setAppEnvKeychainReader,
} from '../../src/orchestrator/materialize-deployment-env';

beforeEach(() => {
    delete process.env['KAGEOPS_APP_ENV_FILE'];
    setDeploymentConfigReader(null);
    setAppEnvKeychainReader(null);
});

afterEach(() => {
    setDeploymentConfigReader(null);
    setAppEnvKeychainReader(null);
    delete process.env['KAGEOPS_APP_ENV_FILE'];
});

describe('resolveAppEnvValues — key-register fallback', () => {
    it('returns keychain values when neither file nor encrypted store apply', async () => {
        setAppEnvKeychainReader(async (id) => (id === 'p1' ? { A: '1' } : null));
        expect(await resolveAppEnvValues('p1')).toEqual({ A: '1' });
    });

    it('encrypted store wins over the keychain when both are present', async () => {
        setDeploymentConfigReader(async () => ({ FROM: 'encrypted' }));
        setAppEnvKeychainReader(async () => ({ FROM: 'keychain' }));
        expect(await resolveAppEnvValues('p1')).toEqual({ FROM: 'encrypted' });
    });

    it('falls through to the keychain when the encrypted store yields null', async () => {
        setDeploymentConfigReader(async () => null);
        setAppEnvKeychainReader(async () => ({ FROM: 'keychain' }));
        expect(await resolveAppEnvValues('p1')).toEqual({ FROM: 'keychain' });
    });

    it('returns null when nothing is configured', async () => {
        expect(await resolveAppEnvValues('p1')).toBeNull();
    });
});
