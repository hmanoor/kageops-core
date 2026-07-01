import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { createLogger } from '../shared/logger';

const log = createLogger('SettingsStore');

// Store settings in the user data dir (~/.kageops), not AppData, so they're portable and visible
const SETTINGS_DIR = process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const DEBOUNCE_MS = 500;

let currentSettings: Settings = { ...DEFAULT_SETTINGS };
let writeTimer: ReturnType<typeof setTimeout> | null = null;

// One-time scrubber: an earlier build shipped a default deployment target
// (an Azure subscription id) that then got persisted into every user's
// settings.json on first run. Strip it on load so existing installs don't
// keep showing a stale deployment after the constants-side default was
// removed. The specific id is supplied via env (never hardcoded in source);
// when unset — e.g. the open-source build, which never shipped the default —
// the scrub is a no-op.
const LEAKED_PLATFORM_SUBSCRIPTION = process.env['KAGEOPS_SCRUB_SUBSCRIPTION_ID'] ?? '';

function scrubLeakedDeployments(settings: Settings): Settings {
  if (LEAKED_PLATFORM_SUBSCRIPTION === '') return settings;
  const filtered = settings.deployments.filter(
    (d) => d.subscriptionId !== LEAKED_PLATFORM_SUBSCRIPTION
  );
  if (filtered.length === settings.deployments.length) return settings;
  log.info(
    { removed: settings.deployments.length - filtered.length },
    'Scrubbed leaked KageOps platform deployment entry from settings'
  );
  return { ...settings, deployments: filtered };
}

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      currentSettings = scrubLeakedDeployments(mergeWithDefaults(parsed));
      // Persist the scrubbed copy so the leaked entry doesn't reappear on next load.
      scheduleSave();
    }
  } catch {
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  return currentSettings;
}

export function getSettings(): Settings {
  return currentSettings;
}

export function updateSettings(partial: Partial<Settings>): Settings {
  currentSettings = {
    ...currentSettings,
    ...partial,
    deployments: partial.deployments ?? currentSettings.deployments,
  };
  scheduleSave();
  return currentSettings;
}

function scheduleSave(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    saveToDisk();
  }, DEBOUNCE_MS);
}

function saveToDisk(): void {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf-8');
  } catch (err) {
    log.error({ err }, 'Failed to save settings');
  }
}

function mergeWithDefaults(partial: Partial<Settings>): Settings {
  return {
    theme: partial.theme ?? DEFAULT_SETTINGS.theme,
    deployments: partial.deployments ?? DEFAULT_SETTINGS.deployments,
    hasSeenWelcome: partial.hasSeenWelcome ?? DEFAULT_SETTINGS.hasSeenWelcome,
    planSelected: partial.planSelected ?? DEFAULT_SETTINGS.planSelected,
    autoUpdateEnabled: partial.autoUpdateEnabled ?? DEFAULT_SETTINGS.autoUpdateEnabled,
    lastUpdateCheckAt: partial.lastUpdateCheckAt ?? DEFAULT_SETTINGS.lastUpdateCheckAt,
    // F-395: `null` is a meaningful "no override" value, so only fall
    // back to default when the field is absent (undefined) on disk,
    // not when it's been explicitly persisted as null.
    releaseChannel: partial.releaseChannel !== undefined
      ? partial.releaseChannel
      : DEFAULT_SETTINGS.releaseChannel,
  };
}
