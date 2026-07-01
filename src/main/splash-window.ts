import { BrowserWindow } from 'electron';

let splashWindow: BrowserWindow | null = null;

/**
 * Default splash duration. Override with KAGEOPS_SPLASH_MS
 * (set to `0` to skip entirely, useful for headless / tests).
 */
const DEFAULT_SPLASH_MS = 5_000;
const FADE_OUT_MS = 450; // matches splash-out animation in splash.css

function readSplashMs(): number {
    const raw = process.env['KAGEOPS_SPLASH_MS'];
    if (raw === undefined) return DEFAULT_SPLASH_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SPLASH_MS;
    return parsed;
}

/**
 * Show the KageOps branded splash (Mark C kanji-fold drawing itself + wordmark).
 * Returns a Promise that resolves once the splash has fully closed,
 * including its fade-out animation. The caller can `await` this before
 * opening the auth window / Command Center.
 */
export function showSplash(): Promise<void> {
    const durationMs = readSplashMs();
    if (durationMs === 0) return Promise.resolve();

    splashWindow = new BrowserWindow({
        width: 360,
        height: 360,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        center: true,
        show: false,
        hasShadow: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    void splashWindow.loadURL('kageops://splash/index.html');

    splashWindow.once('ready-to-show', () => {
        if (splashWindow !== null && !splashWindow.isDestroyed()) {
            splashWindow.show();
        }
    });

    return new Promise<void>((resolve) => {
        const visibleMs = Math.max(0, durationMs - FADE_OUT_MS);

        setTimeout(() => {
            if (splashWindow === null || splashWindow.isDestroyed()) {
                resolve();
                return;
            }

            // Trigger the fade-out animation in the renderer
            void splashWindow.webContents.executeJavaScript(
                "document.body.classList.add('fade-out');",
                true,
            ).catch(() => undefined);

            setTimeout(() => {
                if (splashWindow !== null && !splashWindow.isDestroyed()) {
                    splashWindow.close();
                }
                splashWindow = null;
                resolve();
            }, FADE_OUT_MS);
        }, visibleMs);
    });
}

export function closeSplash(): void {
    if (splashWindow !== null && !splashWindow.isDestroyed()) {
        splashWindow.close();
    }
    splashWindow = null;
}
