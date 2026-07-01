import { describe, it, expect, vi } from 'vitest';
import {
  TRACE_CHANNELS,
  ALERT_CHANNELS,
  RECIPE_CHANNELS,
  PROMPT_CHANNELS,
  SECURITY_CHANNELS,
  ALL_EXTENSION_CHANNELS,
  registerTraceHandlers,
  registerAlertHandlers,
  registerRecipeHandlers,
  registerPromptHandlers,
  registerSecurityHandlers,
  registerAllExtensionHandlers,
  formatRegistrationReport,
  type IpcChannelDef,
  type IpcRegistration,
} from '../../src/main/ipc-extensions';

function mockIpcMain() {
  return { handle: vi.fn() };
}

// ── Channel constant tests ───────────────────────────────────────

describe('TRACE_CHANNELS', () => {
  it('has 5 channels with trace: prefix', () => {
    const values = Object.values(TRACE_CHANNELS);
    expect(values).toHaveLength(5);
    values.forEach(ch => expect(ch).toMatch(/^trace:/));
  });

  it.each([
    ['GET_SESSION', 'trace:get-session'],
    ['LIST_SESSIONS', 'trace:list-sessions'],
    ['GET_TREE', 'trace:get-tree'],
    ['EXPORT', 'trace:export'],
    ['GET_DETAIL', 'trace:get-detail'],
  ] as const)('maps %s to %s', (key, expected) => {
    expect(TRACE_CHANNELS[key]).toBe(expected);
  });
});

describe('ALERT_CHANNELS', () => {
  it('has 6 channels with alert: prefix', () => {
    const values = Object.values(ALERT_CHANNELS);
    expect(values).toHaveLength(6);
    values.forEach(ch => expect(ch).toMatch(/^alert:/));
  });
});

describe('RECIPE_CHANNELS', () => {
  it('has 5 channels with recipe: prefix', () => {
    const values = Object.values(RECIPE_CHANNELS);
    expect(values).toHaveLength(5);
    values.forEach(ch => expect(ch).toMatch(/^recipe:/));
  });
});

describe('PROMPT_CHANNELS', () => {
  it('has 5 channels with prompt: prefix', () => {
    const values = Object.values(PROMPT_CHANNELS);
    expect(values).toHaveLength(5);
    values.forEach(ch => expect(ch).toMatch(/^prompt:/));
  });
});

describe('SECURITY_CHANNELS', () => {
  it('has 3 channels with security: prefix', () => {
    const values = Object.values(SECURITY_CHANNELS);
    expect(values).toHaveLength(3);
    values.forEach(ch => expect(ch).toMatch(/^security:/));
  });
});

describe('ALL_EXTENSION_CHANNELS', () => {
  it('combines all 24 channel definitions', () => {
    expect(ALL_EXTENSION_CHANNELS).toHaveLength(24);
  });

  it('every entry has required IpcChannelDef fields', () => {
    ALL_EXTENSION_CHANNELS.forEach((def: IpcChannelDef) => {
      expect(def.channel).toBeTruthy();
      expect(['main-to-renderer', 'renderer-to-main', 'bidirectional']).toContain(def.direction);
      expect(def.description).toBeTruthy();
      expect(def.payloadType).toBeTruthy();
    });
  });

  it('has no duplicate channel names', () => {
    const names = ALL_EXTENSION_CHANNELS.map(d => d.channel);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ALL_EXTENSION_CHANNELS)).toBe(true);
  });
});

// ── Registration tests ───────────────────────────────────────────

describe('registerTraceHandlers', () => {
  it('registers 5 handlers', () => {
    const ipc = mockIpcMain();
    const result = registerTraceHandlers(ipc);
    expect(result).toHaveLength(5);
    expect(ipc.handle).toHaveBeenCalledTimes(5);
  });

  it('returns all registered: true', () => {
    const result = registerTraceHandlers(mockIpcMain());
    result.forEach(r => expect(r.registered).toBe(true));
  });

  it('handler names include trace domain', () => {
    const result = registerTraceHandlers(mockIpcMain());
    result.forEach(r => expect(r.handler).toMatch(/^trace:/));
  });
});

describe('registerAlertHandlers', () => {
  it('registers 6 handlers', () => {
    const ipc = mockIpcMain();
    const result = registerAlertHandlers(ipc);
    expect(result).toHaveLength(6);
    expect(ipc.handle).toHaveBeenCalledTimes(6);
  });
});

describe('registerRecipeHandlers', () => {
  it('registers 5 handlers', () => {
    const ipc = mockIpcMain();
    const result = registerRecipeHandlers(ipc);
    expect(result).toHaveLength(5);
  });
});

describe('registerPromptHandlers', () => {
  it('registers 5 handlers', () => {
    const ipc = mockIpcMain();
    const result = registerPromptHandlers(ipc);
    expect(result).toHaveLength(5);
  });
});

describe('registerSecurityHandlers', () => {
  it('registers 3 handlers', () => {
    const ipc = mockIpcMain();
    const result = registerSecurityHandlers(ipc);
    expect(result).toHaveLength(3);
  });
});

describe('registerAllExtensionHandlers', () => {
  it('registers all 24 handlers', () => {
    const ipc = mockIpcMain();
    const result = registerAllExtensionHandlers(ipc);
    expect(result).toHaveLength(24);
    expect(ipc.handle).toHaveBeenCalledTimes(24);
  });

  it('returns frozen array', () => {
    const result = registerAllExtensionHandlers(mockIpcMain());
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('handles registration failure gracefully', () => {
    const ipc = {
      handle: vi.fn().mockImplementation((channel: string) => {
        if (channel.startsWith('trace:')) throw new Error('fail');
      }),
    };
    const result = registerAllExtensionHandlers(ipc);
    const traceRegs = result.filter(r => r.channel.startsWith('trace:'));
    const alertRegs = result.filter(r => r.channel.startsWith('alert:'));
    traceRegs.forEach(r => expect(r.registered).toBe(false));
    alertRegs.forEach(r => expect(r.registered).toBe(true));
  });
});

// ── Report tests ─────────────────────────────────────────────────

describe('formatRegistrationReport', () => {
  it('produces markdown with header', () => {
    const report = formatRegistrationReport([]);
    expect(report).toContain('# IPC Extension Registration Report');
  });

  it('includes counts', () => {
    const regs: readonly IpcRegistration[] = [
      { channel: 'a', registered: true, handler: 'h1' },
      { channel: 'b', registered: false, handler: 'h2' },
    ];
    const report = formatRegistrationReport(regs);
    expect(report).toContain('**Total:** 2');
    expect(report).toContain('**Registered:** 1');
    expect(report).toContain('**Failed:** 1');
  });

  it('shows OK and FAILED status', () => {
    const regs: readonly IpcRegistration[] = [
      { channel: 'ok-ch', registered: true, handler: 'h' },
      { channel: 'fail-ch', registered: false, handler: 'h' },
    ];
    const report = formatRegistrationReport(regs);
    expect(report).toContain('| ok-ch | OK |');
    expect(report).toContain('| fail-ch | FAILED |');
  });
});
