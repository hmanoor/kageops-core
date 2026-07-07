/**
 * KO-SEC-002 — `shouldFireOnFirstLaunch()` used to call a generic
 * `window.kageOps.dbQuery(sql, params)` passthrough to detect an empty
 * `projects` table. That passthrough let the renderer send arbitrary SQL to
 * main and has been removed; the wizard must instead call a fixed,
 * parameterless `projectsIsEmpty()` bridge method.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { shouldFireOnFirstLaunch } from '../../src/renderer/command-center/setup-wizard';

interface OnboardingStateStub {
  readonly step: string;
  readonly completedAt: string | null;
}

function installBridge(state: OnboardingStateStub, empty: boolean): void {
  (window as unknown as { kageOps: unknown }).kageOps = {
    onboarding: {
      getState: async () => ({ ok: true, state }),
    },
    projectsIsEmpty: async () => ({ empty }),
  };
}

describe('shouldFireOnFirstLaunch (KO-SEC-002)', () => {
  afterEach(() => {
    delete (window as unknown as { kageOps?: unknown }).kageOps;
  });

  it('fires when wizard is untouched and the projects table is empty', async () => {
    installBridge({ step: 'welcome', completedAt: null }, true);
    expect(await shouldFireOnFirstLaunch()).toBe(true);
  });

  it('does not fire when the projects table already has rows', async () => {
    installBridge({ step: 'welcome', completedAt: null }, false);
    expect(await shouldFireOnFirstLaunch()).toBe(false);
  });

  it('does not fire once onboarding has been completed', async () => {
    installBridge({ step: 'welcome', completedAt: '2026-01-01T00:00:00Z' }, true);
    expect(await shouldFireOnFirstLaunch()).toBe(false);
  });
});
