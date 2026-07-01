/**
 * B-195: Multi-Modal Support (Image Input)
 * B-196: Local Model Preference for Sensitive Projects
 * B-197: Voice Input / Dictation
 * B-198: iOS Monitoring App
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ImageInput {
  readonly id: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly description: string | null;
}

export interface ImageAnalysisRequest {
  readonly imageId: string;
  readonly agentRole: string;
  readonly prompt: string;
  readonly maxTokens: number;
}

export interface ImageAnalysisResult {
  readonly imageId: string;
  readonly description: string;
  readonly elements: readonly string[];
  readonly suggestions: readonly string[];
  readonly confidence: number;
  readonly tokenCount: number;
  readonly cost: number;
}

export type SensitivityLevel = 'public' | 'internal' | 'confidential' | 'restricted';

export interface ModelRoutingRule {
  readonly sensitivityLevel: SensitivityLevel;
  readonly preferLocal: boolean;
  readonly allowedProviders: readonly string[];
  readonly blockedProviders: readonly string[];
  readonly reason: string;
}

export interface ModelRoutingDecision {
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
  readonly isLocal: boolean;
  readonly sensitivityLevel: SensitivityLevel;
}

export type VoiceProvider = 'whisper' | 'azure-speech' | 'google-speech' | 'deepgram';

export interface VoiceConfig {
  readonly provider: VoiceProvider;
  readonly language: string;
  readonly sampleRate: number;
  readonly enabled: boolean;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly confidence: number;
  readonly language: string;
  readonly durationMs: number;
  readonly wordCount: number;
}

export interface MobileDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: 'ios' | 'android';
  readonly pushToken: string | null;
  readonly lastSeen: string;
  readonly connected: boolean;
}

export interface MobileNotification {
  readonly deviceId: string;
  readonly title: string;
  readonly body: string;
  readonly category: 'task-complete' | 'approval-needed' | 'error' | 'milestone';
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  readonly data: Readonly<Record<string, string>>;
}

export interface MobileDashboardData {
  readonly activeProjects: number;
  readonly runningAgents: number;
  readonly pendingApprovals: number;
  readonly recentAlerts: number;
  readonly totalCost: number;
  readonly lastUpdated: string;
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGE_DIMENSION = 4096;
const VALID_MIME_TYPES: readonly string[] = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
];
const DEFAULT_MAX_TOKENS = 1024;
const LOCAL_PROVIDERS: readonly string[] = ['ollama'];

export const SENSITIVITY_ROUTING_RULES: readonly ModelRoutingRule[] = [
  {
    sensitivityLevel: 'public',
    preferLocal: false,
    allowedProviders: ['ollama', 'openai', 'anthropic', 'google', 'openrouter'],
    blockedProviders: [],
    reason: 'Public data — any provider allowed',
  },
  {
    sensitivityLevel: 'internal',
    preferLocal: true,
    allowedProviders: ['ollama', 'openai', 'anthropic', 'google', 'openrouter'],
    blockedProviders: [],
    reason: 'Internal data — prefer local but cloud acceptable',
  },
  {
    sensitivityLevel: 'confidential',
    preferLocal: true,
    allowedProviders: ['ollama'],
    blockedProviders: ['openai', 'anthropic', 'google', 'openrouter'],
    reason: 'Confidential data — local models only',
  },
  {
    sensitivityLevel: 'restricted',
    preferLocal: true,
    allowedProviders: ['ollama'],
    blockedProviders: ['openai', 'anthropic', 'google', 'openrouter'],
    reason: 'Restricted data — local models only, no cloud',
  },
];

export const SUPPORTED_VOICE_PROVIDERS: readonly VoiceProvider[] = [
  'whisper', 'azure-speech', 'google-speech', 'deepgram',
];

const VOICE_DEFAULTS: Readonly<Record<VoiceProvider, VoiceConfig>> = {
  whisper: { provider: 'whisper', language: 'en', sampleRate: 16000, enabled: true },
  'azure-speech': { provider: 'azure-speech', language: 'en-US', sampleRate: 16000, enabled: true },
  'google-speech': { provider: 'google-speech', language: 'en-US', sampleRate: 16000, enabled: true },
  deepgram: { provider: 'deepgram', language: 'en', sampleRate: 16000, enabled: true },
};

// cost per minute in USD (approximate)
const TRANSCRIPTION_COST_PER_MIN: Readonly<Record<VoiceProvider, number>> = {
  whisper: 0.006,
  'azure-speech': 0.016,
  'google-speech': 0.016,
  deepgram: 0.0125,
};

// ── B-195: Image Functions ─────────────────────────────────────────

export function validateImageInput(input: ImageInput): readonly string[] {
  const errors: string[] = [];
  if (!VALID_MIME_TYPES.includes(input.mimeType)) {
    errors.push(`Unsupported mime type: ${input.mimeType}`);
  }
  if (input.sizeBytes > MAX_IMAGE_SIZE_BYTES) {
    errors.push(`Image exceeds 10MB limit: ${input.sizeBytes} bytes`);
  }
  if (input.width > MAX_IMAGE_DIMENSION || input.height > MAX_IMAGE_DIMENSION) {
    errors.push(`Dimensions exceed ${MAX_IMAGE_DIMENSION}px limit: ${input.width}x${input.height}`);
  }
  if (input.width <= 0 || input.height <= 0) {
    errors.push('Dimensions must be positive');
  }
  return errors;
}

export function estimateImageTokens(input: ImageInput): number {
  return Math.ceil((input.width * input.height) / 750 + 85);
}

export function createAnalysisRequest(
  imageId: string,
  agentRole: string,
  prompt: string,
): ImageAnalysisRequest {
  return { imageId, agentRole, prompt, maxTokens: DEFAULT_MAX_TOKENS };
}

// ── B-196: Sensitivity Routing ─────────────────────────────────────

export function isProviderLocal(provider: string): boolean {
  return LOCAL_PROVIDERS.includes(provider);
}

export function routeModel(
  sensitivityLevel: SensitivityLevel,
  availableProviders: readonly string[],
  rules: readonly ModelRoutingRule[],
): ModelRoutingDecision {
  const rule = rules.find((r) => r.sensitivityLevel === sensitivityLevel);
  if (!rule) {
    return {
      provider: 'ollama',
      model: 'llama3',
      reason: 'No rule found — defaulting to local',
      isLocal: true,
      sensitivityLevel,
    };
  }

  const eligible = availableProviders.filter(
    (p) => rule.allowedProviders.includes(p) && !rule.blockedProviders.includes(p),
  );

  if (eligible.length === 0) {
    return {
      provider: 'ollama',
      model: 'llama3',
      reason: 'No eligible provider — falling back to local',
      isLocal: true,
      sensitivityLevel,
    };
  }

  if (rule.preferLocal) {
    const local = eligible.find((p) => isProviderLocal(p));
    if (local) {
      return {
        provider: local,
        model: 'llama3',
        reason: rule.reason,
        isLocal: true,
        sensitivityLevel,
      };
    }
  }

  const chosen = eligible[0];
  return {
    provider: chosen,
    model: isProviderLocal(chosen) ? 'llama3' : 'default',
    reason: rule.reason,
    isLocal: isProviderLocal(chosen),
    sensitivityLevel,
  };
}

// ── B-197: Voice Functions ─────────────────────────────────────────

export function createVoiceConfig(
  provider: VoiceProvider,
  overrides?: Partial<VoiceConfig>,
): VoiceConfig {
  const defaults = VOICE_DEFAULTS[provider];
  return { ...defaults, ...overrides, provider };
}

export function estimateTranscriptionCost(durationMs: number, provider: VoiceProvider): number {
  const minutes = durationMs / 60_000;
  return Math.round(minutes * TRANSCRIPTION_COST_PER_MIN[provider] * 1_000_000) / 1_000_000;
}

export function validateTranscription(result: TranscriptionResult): readonly string[] {
  const errors: string[] = [];
  if (result.confidence < 0 || result.confidence > 1) {
    errors.push('Confidence must be between 0 and 1');
  }
  if (result.wordCount <= 0) {
    errors.push('Word count must be positive');
  }
  if (result.text.trim().length === 0) {
    errors.push('Transcription text is empty');
  }
  if (result.durationMs <= 0) {
    errors.push('Duration must be positive');
  }
  return errors;
}

// ── B-198: Mobile Functions ────────────────────────────────────────

export function createMobileNotification(
  deviceId: string,
  title: string,
  body: string,
  category: MobileNotification['category'],
  priority: MobileNotification['priority'],
): MobileNotification {
  return { deviceId, title, body, category, priority, data: {} };
}

export function formatMobileDashboard(data: MobileDashboardData): string {
  return [
    `## KageOps Dashboard`,
    `- **Active Projects:** ${data.activeProjects}`,
    `- **Running Agents:** ${data.runningAgents}`,
    `- **Pending Approvals:** ${data.pendingApprovals}`,
    `- **Recent Alerts:** ${data.recentAlerts}`,
    `- **Total Cost:** $${data.totalCost.toFixed(2)}`,
    `- _Updated: ${data.lastUpdated}_`,
  ].join('\n');
}

export function shouldSendPushNotification(
  notification: MobileNotification,
  device: MobileDevice,
): boolean {
  if (!device.pushToken) return false;
  if (!device.connected) return false;
  if (notification.priority === 'low') return false;
  return true;
}

export function formatNotificationPayload(notification: MobileNotification): string {
  return JSON.stringify({
    to: notification.deviceId,
    title: notification.title,
    body: notification.body,
    category: notification.category,
    priority: notification.priority,
    data: notification.data,
  });
}
