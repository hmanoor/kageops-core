import { describe, it, expect } from 'vitest';
import {
  validateImageInput,
  estimateImageTokens,
  createAnalysisRequest,
  SENSITIVITY_ROUTING_RULES,
  routeModel,
  isProviderLocal,
  SUPPORTED_VOICE_PROVIDERS,
  createVoiceConfig,
  estimateTranscriptionCost,
  validateTranscription,
  createMobileNotification,
  formatMobileDashboard,
  shouldSendPushNotification,
  formatNotificationPayload,
  type ImageInput,
  type TranscriptionResult,
  type MobileNotification,
  type MobileDevice,
  type SensitivityLevel,
  type MobileDashboardData,
} from '../../src/ai/ai-enhancements';

// ── Helpers ────────────────────────────────────────────────────────

const validImage: ImageInput = {
  id: 'img-1',
  mimeType: 'image/png',
  width: 800,
  height: 600,
  sizeBytes: 500_000,
  description: null,
};

const validTranscription: TranscriptionResult = {
  text: 'Hello world',
  confidence: 0.95,
  language: 'en',
  durationMs: 5000,
  wordCount: 2,
};

const connectedDevice: MobileDevice = {
  deviceId: 'dev-1',
  name: 'iPhone',
  platform: 'ios',
  pushToken: 'token-abc',
  lastSeen: '2026-04-11T00:00:00Z',
  connected: true,
};

// ── B-195: Image Input ─────────────────────────────────────────────

describe('validateImageInput', () => {
  it('returns no errors for valid input', () => {
    expect(validateImageInput(validImage)).toEqual([]);
  });

  it.each([
    [11 * 1024 * 1024, 'exceeds 10MB'],
    [10 * 1024 * 1024 + 1, 'exceeds 10MB'],
  ])('rejects size %i bytes', (sizeBytes) => {
    const img = { ...validImage, sizeBytes };
    expect(validateImageInput(img).length).toBeGreaterThan(0);
  });

  it.each([
    [5000, 600, 'width over 4096'],
    [800, 5000, 'height over 4096'],
    [0, 600, 'zero width'],
    [800, -1, 'negative height'],
  ])('rejects invalid dimensions (%s)', (width, height) => {
    const img = { ...validImage, width, height };
    expect(validateImageInput(img).length).toBeGreaterThan(0);
  });

  it('accepts all valid mime types', () => {
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
    for (const mimeType of types) {
      expect(validateImageInput({ ...validImage, mimeType })).toEqual([]);
    }
  });
});

describe('estimateImageTokens', () => {
  it.each([
    [800, 600, Math.ceil((800 * 600) / 750 + 85)],
    [1, 1, Math.ceil(1 / 750 + 85)],
    [4096, 4096, Math.ceil((4096 * 4096) / 750 + 85)],
  ])('estimates tokens for %ix%i', (width, height, expected) => {
    expect(estimateImageTokens({ ...validImage, width, height })).toBe(expected);
  });
});

describe('createAnalysisRequest', () => {
  it('creates request with default maxTokens', () => {
    const req = createAnalysisRequest('img-1', 'Scout', 'Describe this');
    expect(req).toEqual({
      imageId: 'img-1',
      agentRole: 'Scout',
      prompt: 'Describe this',
      maxTokens: 1024,
    });
  });
});

// ── B-196: Sensitivity Routing ─────────────────────────────────────

describe('isProviderLocal', () => {
  it.each([
    ['ollama', true],
    ['openai', false],
    ['anthropic', false],
    ['google', false],
  ])('provider %s isLocal=%s', (provider, expected) => {
    expect(isProviderLocal(provider)).toBe(expected);
  });
});

describe('SENSITIVITY_ROUTING_RULES', () => {
  it('has a rule for each sensitivity level', () => {
    const levels: readonly SensitivityLevel[] = ['public', 'internal', 'confidential', 'restricted'];
    for (const level of levels) {
      expect(SENSITIVITY_ROUTING_RULES.find((r) => r.sensitivityLevel === level)).toBeDefined();
    }
  });
});

describe('routeModel', () => {
  it.each<[SensitivityLevel, readonly string[], boolean]>([
    ['public', ['openai', 'ollama'], false],
    ['internal', ['openai', 'ollama'], true],
    ['confidential', ['ollama'], true],
    ['restricted', ['ollama'], true],
  ])('routes %s with providers %j → isLocal=%s', (level, providers, expectedLocal) => {
    const decision = routeModel(level, providers, SENSITIVITY_ROUTING_RULES);
    expect(decision.isLocal).toBe(expectedLocal);
    expect(decision.sensitivityLevel).toBe(level);
  });

  it('falls back to ollama when no eligible provider', () => {
    const decision = routeModel('confidential', ['openai'], SENSITIVITY_ROUTING_RULES);
    expect(decision.provider).toBe('ollama');
    expect(decision.isLocal).toBe(true);
  });

  it('falls back to ollama when no rule found', () => {
    const decision = routeModel('public', ['openai'], []);
    expect(decision.provider).toBe('ollama');
  });
});

// ── B-197: Voice ───────────────────────────────────────────────────

describe('SUPPORTED_VOICE_PROVIDERS', () => {
  it('contains all 4 providers', () => {
    expect(SUPPORTED_VOICE_PROVIDERS).toHaveLength(4);
    expect(SUPPORTED_VOICE_PROVIDERS).toContain('whisper');
    expect(SUPPORTED_VOICE_PROVIDERS).toContain('deepgram');
  });
});

describe('createVoiceConfig', () => {
  it('creates default config for whisper', () => {
    const config = createVoiceConfig('whisper');
    expect(config.provider).toBe('whisper');
    expect(config.enabled).toBe(true);
    expect(config.sampleRate).toBe(16000);
  });

  it('applies overrides without mutating defaults', () => {
    const config = createVoiceConfig('whisper', { language: 'fr', enabled: false });
    expect(config.language).toBe('fr');
    expect(config.enabled).toBe(false);
    expect(config.provider).toBe('whisper');
  });
});

describe('estimateTranscriptionCost', () => {
  it.each([
    ['whisper', 60_000, 0.006],
    ['deepgram', 60_000, 0.0125],
    ['whisper', 0, 0],
  ] as const)('provider %s for %ims costs %f', (provider, durationMs, expected) => {
    expect(estimateTranscriptionCost(durationMs, provider)).toBeCloseTo(expected, 6);
  });
});

describe('validateTranscription', () => {
  it('returns no errors for valid transcription', () => {
    expect(validateTranscription(validTranscription)).toEqual([]);
  });

  it('rejects confidence out of range', () => {
    const bad = { ...validTranscription, confidence: 1.5 };
    expect(validateTranscription(bad).length).toBeGreaterThan(0);
  });

  it('rejects empty text', () => {
    const bad = { ...validTranscription, text: '   ', wordCount: 1 };
    expect(validateTranscription(bad).length).toBeGreaterThan(0);
  });

  it('rejects zero word count', () => {
    const bad = { ...validTranscription, wordCount: 0 };
    expect(validateTranscription(bad).length).toBeGreaterThan(0);
  });
});

// ── B-198: Mobile ──────────────────────────────────────────────────

describe('createMobileNotification', () => {
  it('creates notification with empty data', () => {
    const n = createMobileNotification('dev-1', 'Done', 'Task finished', 'task-complete', 'high');
    expect(n.deviceId).toBe('dev-1');
    expect(n.data).toEqual({});
    expect(n.priority).toBe('high');
  });
});

describe('formatMobileDashboard', () => {
  it('returns markdown with all fields', () => {
    const data: MobileDashboardData = {
      activeProjects: 3,
      runningAgents: 5,
      pendingApprovals: 1,
      recentAlerts: 2,
      totalCost: 42.5,
      lastUpdated: '2026-04-11T00:00:00Z',
    };
    const md = formatMobileDashboard(data);
    expect(md).toContain('Active Projects:** 3');
    expect(md).toContain('$42.50');
    expect(md).toContain('2026-04-11');
  });
});

describe('shouldSendPushNotification', () => {
  it.each<[MobileNotification['priority'], boolean, string | null, boolean]>([
    ['critical', true, 'tok', true],
    ['high', true, 'tok', true],
    ['normal', true, 'tok', true],
    ['low', true, 'tok', false],
    ['high', false, 'tok', false],
    ['high', true, null, false],
  ])('priority=%s connected=%s token=%s → %s', (priority, connected, pushToken, expected) => {
    const notif = createMobileNotification('dev-1', 'T', 'B', 'task-complete', priority);
    const device: MobileDevice = { ...connectedDevice, connected, pushToken };
    expect(shouldSendPushNotification(notif, device)).toBe(expected);
  });
});

describe('formatNotificationPayload', () => {
  it('returns valid JSON string', () => {
    const n = createMobileNotification('dev-1', 'Title', 'Body', 'error', 'critical');
    const payload = formatNotificationPayload(n);
    const parsed = JSON.parse(payload);
    expect(parsed.to).toBe('dev-1');
    expect(parsed.title).toBe('Title');
    expect(parsed.category).toBe('error');
  });
});
