import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getSettings, updateSettings } from './settings-store';

/**
 * KageOps auto-updater wiring.
 *
 * Two channels (built by CI with `-c.publish.channel=<value>`):
 *   - `latest` → production stable, served from `dl.kageops.ai/latest/`
 *   - `beta`   → opt-in pre-release stream at `dl.kageops.ai/beta/`
 *
 * Channel resolution (F-395, highest precedence first — see `resolveChannel`):
 *   1. `KAGEOPS_RELEASE_CHANNEL` env var — CI / power-user escape hatch.
 *   2. `Settings.releaseChannel` — operator-set UI override, persisted.
 *   3. `app-update.yml` embedded channel — what the CI build baked in.
 *      electron-updater reads this lazily; reading `autoUpdater.channel`
 *      before we override it returns the embedded value (or null in dev).
 *   4. Hard default `'latest'`.
 *
 * Before F-395 the runtime only looked at the env var → silently defaulted
 * every beta install to the `latest` channel feed → stranded all beta users
 * who hadn't manually set the env. v0.2.0-beta.0..2 → beta.3 didn't roll
 * out automatically until this resolver landed.
 *
 * Behaviour:
 *   - In packaged builds: checks for updates 5s after launch, then every 4h
 *     (only when Settings.autoUpdateEnabled === true — decision #76)
 *   - In dev (`npm run dev`): no-op (autoUpdater is a packaged-only feature)
 *   - When an update is downloaded: prompts the user before quitting+installing
 *
 * Errors are logged but never crash the app — auto-update is best-effort,
 * users can always re-download manually from kageops.ai/downloads.
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 5_000;

let installerChecked = false;
let initialised = false;
let periodicHandle: NodeJS.Timeout | null = null;

/**
 * F-395: pure channel-resolution helper. Exported for unit tests.
 *
 * Normalises and clamps each layer to `'latest' | 'beta'`. Unknown
 * strings (typo'd app-update.yml, future channel names) are treated
 * as "not set" so they fall through to the next layer rather than
 * pointing at a non-existent R2 path. Empty / whitespace strings at
 * any layer are also treated as "not set" so a stale env export of
 * `KAGEOPS_RELEASE_CHANNEL=""` doesn't override a real setting below.
 */
export function resolveChannel(inputs: {
    readonly env: string | undefined;
    readonly settings: 'latest' | 'beta' | null;
    readonly embedded: string | null;
}): 'latest' | 'beta' {
    const normalise = (raw: string | null | undefined): 'latest' | 'beta' | null => {
        if (raw === undefined || raw === null) return null;
        const lc = raw.trim().toLowerCase();
        if (lc === 'latest' || lc === 'beta') return lc;
        return null;
    };
    return (
        normalise(inputs.env)
        ?? normalise(inputs.settings)
        ?? normalise(inputs.embedded)
        ?? 'latest'
    );
}

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
    if (!app.isPackaged) {
        // No-op in dev mode — autoUpdater requires a packaged build with
        // an embedded app-update.yml (created by electron-builder).
        console.log('[AutoUpdater] Skipped (dev mode)');
        return;
    }

    if (initialised) {
        // Idempotent — calling twice (e.g. after a settings flip) shouldn't
        // double the timers or stack event listeners.
        return;
    }
    initialised = true;

    // F-395: resolve via env > settings > embedded > 'latest'. Read the
    // embedded channel BEFORE we set it — electron-updater's `channel`
    // getter returns the value from app-update.yml until we override.
    const embedded = autoUpdater.channel;
    let settingsChannel: 'latest' | 'beta' | null = null;
    try {
        const s = getSettings().releaseChannel;
        settingsChannel = s === 'latest' || s === 'beta' ? s : null;
    } catch { /* settings store not ready at very-early boot */ }

    const channel = resolveChannel({
        env: process.env['KAGEOPS_RELEASE_CHANNEL'],
        settings: settingsChannel,
        embedded,
    });
    autoUpdater.channel = channel;

    // F-330 Phase 2 — override the github publish provider baked in via
    // electron-builder.yml and read updates from the Cloudflare R2 mirror at
    // dl.kageops.ai. The github provider stays in electron-builder.yml so
    // `electron-builder --publish always` can still push artifacts to the
    // private GitHub Release (archival source-of-truth for the dev team);
    // this runtime override directs end-users at the public R2 feed, which
    // is the only one they can actually reach (the source repo is private,
    // so GitHub Releases asset URLs return 404 to unauthenticated browsers).
    //
    // Feed layout served from R2:
    //   https://dl.kageops.ai/<channel>/latest.yml          (Windows feed)
    //   https://dl.kageops.ai/<channel>/latest-mac.yml      (macOS feed)
    //   https://dl.kageops.ai/<channel>/latest-linux.yml    (Linux feed)
    // Each yml carries relative installer URLs that resolve under the same
    // <channel>/ directory.
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: `https://dl.kageops.ai/${channel}`,
        channel,
    });

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = channel !== 'latest';

    console.log(`[AutoUpdater] Channel: ${channel}, allowPrerelease: ${autoUpdater.allowPrerelease}`);

    autoUpdater.on('checking-for-update', () => {
        console.log('[AutoUpdater] Checking for update');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('[AutoUpdater] Update available:', info.version);
        const win = getMainWindow();
        if (win !== null && !win.isDestroyed()) {
            win.webContents.send('auto-updater:update-available', { version: info.version });
        }
    });

    autoUpdater.on('update-not-available', () => {
        console.log('[AutoUpdater] No update available');
    });

    autoUpdater.on('download-progress', (progress) => {
        const win = getMainWindow();
        if (win !== null && !win.isDestroyed()) {
            win.webContents.send('auto-updater:progress', {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total,
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('[AutoUpdater] Update downloaded:', info.version);
        installerChecked = true;
        const win = getMainWindow();
        if (win !== null && !win.isDestroyed()) {
            win.webContents.send('auto-updater:update-ready', { version: info.version });
        }
        // Prompt the user — they may have unsaved work
        void promptInstallNow(info.version);
    });

    autoUpdater.on('error', (err) => {
        console.warn('[AutoUpdater] Error (non-fatal):', err.message);
    });

    // First check after a brief delay so we don't compete with app startup
    setTimeout(() => {
        void maybeCheckForUpdates();
    }, INITIAL_DELAY_MS);

    // Periodic re-check
    periodicHandle = setInterval(() => {
        void maybeCheckForUpdates();
    }, CHECK_INTERVAL_MS);
}

/**
 * Gate `checkForUpdates` on the user's `autoUpdateEnabled` setting. Decision
 * #76: opt-out, default ON. When the user has flipped the toggle off, we
 * skip the periodic + initial checks entirely. The "Check for updates now"
 * button (`manualUpdateCheck()` below) is unaffected — manual checks always
 * work regardless of the toggle.
 */
async function maybeCheckForUpdates(): Promise<void> {
    let enabled = true;
    try {
        enabled = getSettings().autoUpdateEnabled !== false;
    } catch {
        // Settings unavailable (very early boot, file lock, etc.) — defer
        // to default ON behaviour.
        enabled = true;
    }
    if (!enabled) {
        return;
    }
    await checkForUpdates();
}

async function checkForUpdates(): Promise<void> {
    try {
        await autoUpdater.checkForUpdates();
        // Persist the timestamp so the Settings panel can show "Last checked: …"
        try {
            updateSettings({ lastUpdateCheckAt: new Date().toISOString() });
        } catch { /* settings may be unavailable; non-fatal */ }
    } catch (err) {
        console.warn('[AutoUpdater] checkForUpdates failed:', err instanceof Error ? err.message : String(err));
    }
}

async function promptInstallNow(version: string): Promise<void> {
    if (!installerChecked) return;
    const result = await dialog.showMessageBox({
        type: 'info',
        title: 'KageOps update ready',
        message: `Version ${version} is ready to install.`,
        detail: 'Restart now to apply, or it will install when you next quit KageOps.',
        buttons: ['Restart now', 'Install on next quit'],
        defaultId: 0,
        cancelId: 1,
    });
    if (result.response === 0) {
        autoUpdater.quitAndInstall();
    }
}

/**
 * Manually trigger an update check. Wired up via IPC for the "Check for
 * updates now" button in Settings → General → Updates and the tray menu.
 *
 * Always runs regardless of `autoUpdateEnabled` — it's the explicit-action
 * escape hatch for users who've opted out of auto-checks but still want
 * to grab the latest manually. The button itself should be visible
 * whether the toggle is on or off.
 */
/**
 * F-395: report the currently-active channel + the resolution layer
 * that produced it. Used by Settings → General → About so operators
 * can see *why* a particular channel is in effect (and which lever
 * to flip when it's wrong). Returns `'latest'` + `'dev-fallback'` in
 * dev mode since auto-updater isn't initialised there.
 */
export function getActiveChannel(): {
    readonly channel: 'latest' | 'beta';
    readonly source: 'env' | 'settings' | 'embedded' | 'default' | 'dev-fallback';
    readonly embedded: string | null;
} {
    if (!app.isPackaged) {
        return { channel: 'latest', source: 'dev-fallback', embedded: null };
    }
    const env = process.env['KAGEOPS_RELEASE_CHANNEL'];
    let settingsChannel: 'latest' | 'beta' | null = null;
    try {
        const s = getSettings().releaseChannel;
        settingsChannel = s === 'latest' || s === 'beta' ? s : null;
    } catch { /* settings store unavailable */ }
    const embedded = autoUpdater.channel;
    const resolved = resolveChannel({ env, settings: settingsChannel, embedded });

    const envNorm = (env ?? '').trim().toLowerCase();
    let source: 'env' | 'settings' | 'embedded' | 'default';
    if (envNorm === 'latest' || envNorm === 'beta') source = 'env';
    else if (settingsChannel !== null) source = 'settings';
    else if (embedded === 'latest' || embedded === 'beta') source = 'embedded';
    else source = 'default';

    return { channel: resolved, source, embedded };
}

/**
 * F-395: persist the operator's channel override + apply it to the
 * live `autoUpdater` instance without requiring a process restart.
 * Triggers an immediate update check on the new channel so the
 * operator sees feedback within seconds.
 *
 * Pass `null` to clear the override (fall back to embedded / default).
 */
export async function setReleaseChannel(channel: 'latest' | 'beta' | null): Promise<{
    readonly channel: 'latest' | 'beta';
    readonly checkedAt?: string;
    readonly available?: boolean;
    readonly version?: string;
    readonly error?: string;
}> {
    try {
        updateSettings({ releaseChannel: channel });
    } catch (err) {
        return {
            channel: 'latest',
            error: `failed to persist setting: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const active = getActiveChannel();
    if (!app.isPackaged) {
        return { channel: active.channel };
    }

    // Re-point the live autoUpdater at the new feed.
    autoUpdater.channel = active.channel;
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: `https://dl.kageops.ai/${active.channel}`,
        channel: active.channel,
    });
    autoUpdater.allowPrerelease = active.channel !== 'latest';

    const result = await manualUpdateCheck();
    return {
        channel: active.channel,
        ...(result.checkedAt !== undefined ? { checkedAt: result.checkedAt } : {}),
        ...(result.available !== undefined ? { available: result.available } : {}),
        ...(result.version !== undefined ? { version: result.version } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
    };
}

export async function manualUpdateCheck(): Promise<{ available: boolean; version?: string; error?: string; checkedAt?: string }> {
    if (!app.isPackaged) {
        return { available: false, error: 'Auto-update only available in packaged builds' };
    }
    try {
        const result = await autoUpdater.checkForUpdates();
        const checkedAt = new Date().toISOString();
        try { updateSettings({ lastUpdateCheckAt: checkedAt }); } catch { /* */ }
        if (result === null || result === undefined) {
            return { available: false, checkedAt };
        }
        return {
            available: true,
            version: result.updateInfo.version,
            checkedAt,
        };
    } catch (err) {
        return { available: false, error: err instanceof Error ? err.message : String(err) };
    }
}
