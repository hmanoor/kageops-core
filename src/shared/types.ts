export type ProviderType = 'claude' | 'codex' | 'copilot' | 'gemini' | 'opencode' | 'ollama';

export type ThemeId = 'midnight' | 'peach' | 'cloud' | 'moss';

export type DeploymentPurpose = 'platform' | 'shared' | 'poc' | 'project';

export interface DeploymentTarget {
  readonly id: string;
  readonly name: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly purpose: DeploymentPurpose;
  readonly projectId?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface Settings {
  readonly theme: ThemeId;
  readonly deployments: readonly DeploymentTarget[];
  readonly hasSeenWelcome: boolean;
  readonly planSelected: boolean;
  /**
   * When true (default), the packaged app polls for updates on launch +
   * every 4h, downloads them in the background, and prompts to install
   * when ready. When false, the auto-updater is fully disabled — user
   * gets updates only by manually clicking "Check for updates" or
   * downloading a new installer from kageops.ai/downloads.
   *
   * Default: true (industry standard — VS Code, Slack, 1Password all
   * default-on with an opt-out, see decision #76).
   */
  readonly autoUpdateEnabled: boolean;
  /** Last successful update check (ISO timestamp); null = never. */
  readonly lastUpdateCheckAt: string | null;
  /**
   * F-395: persisted operator override for the auto-updater feed channel.
   *
   * Precedence (highest first) when resolving the active channel:
   *   1. `KAGEOPS_RELEASE_CHANNEL` env var — CI / power-user escape hatch
   *   2. This settings value — UI-selectable, persisted across restarts
   *   3. Embedded `app-update.yml` channel — what electron-builder baked
   *      into this installer via `-c.publish.channel=<value>` at build time
   *   4. Hard default `'latest'`
   *
   * `null` means "no override — fall through to embedded or default".
   *
   * History: pre-F-395 the runtime only read the env var (defaulting to
   * `'latest'`), which silently stranded every beta installation. v0.2.0-beta.0..2
   * users couldn't auto-upgrade to v0.2.0-beta.3 even after the tag shipped.
   */
  readonly releaseChannel: 'latest' | 'beta' | null;
}

export interface AgentMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: number;
  readonly toolName?: string;
}

export interface ParsedEvent {
  readonly type: 'text' | 'tool-use' | 'tool-result' | 'thinking' | 'complete' | 'error' | 'ready';
  readonly content?: string;
  readonly toolName?: string;
}

export interface ScreenGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly taskbarHeight: number;
  readonly taskbarPosition: 'bottom' | 'top' | 'left' | 'right';
}

export interface ThemeColors {
  readonly background: string;
  readonly text: string;
  readonly accent: string;
  readonly inputBg: string;
  readonly inputBorder: string;
  readonly userBubble: string;
  readonly assistantBubble: string;
  readonly systemText: string;
  readonly codeBg: string;
  readonly scrollbar: string;
}

export interface Theme {
  readonly id: ThemeId;
  readonly name: string;
  readonly colors: ThemeColors;
}
