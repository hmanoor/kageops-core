import { BrowserWindow, app, ipcMain, shell } from 'electron';
import * as path from 'path';
import { IPC } from '../shared/ipc-channels';
import { getSettings, updateSettings } from './settings-store';
import { createLogger } from '../shared/logger';

const log = createLogger('WelcomeWindow');

let welcomeWindow: BrowserWindow | null = null;

export function registerWelcomeIpcHandlers(): void {
    ipcMain.handle(IPC.WELCOME_GET_VERSION, () => app.getVersion());

    ipcMain.handle(IPC.WELCOME_DISMISS, () => {
        updateSettings({ hasSeenWelcome: true });
        closeWelcomeWindow();
    });

    ipcMain.handle(IPC.WELCOME_OPEN_DOCS, async () => {
        await shell.openExternal('https://kageops.ai/docs/');
    });

    ipcMain.handle(IPC.WELCOME_QUICK_ACTION, async (_event, kind: 'new-project' | 'open-settings') => {
        const wins = BrowserWindow.getAllWindows();
        const cc = wins.find((w) => !w.isDestroyed() && w.getTitle().includes('Command Center'));
        if (cc !== undefined) {
            if (cc.isMinimized()) cc.restore();
            cc.focus();
            cc.webContents.send('welcome:trigger-quick-action', kind);
        } else {
            log.warn({ kind }, '[WelcomeWindow] quick action fired but Command Center not open');
        }
        closeWelcomeWindow();
    });
}

export function showWelcomeWindow(): BrowserWindow {
    if (welcomeWindow !== null && !welcomeWindow.isDestroyed()) {
        welcomeWindow.focus();
        return welcomeWindow;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    welcomeWindow = new BrowserWindow({
        width: 900,
        height: 700,
        resizable: true,
        minWidth: 720,
        minHeight: 560,
        frame: false,
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        titleBarOverlay: isWin ? {
            color: '#0a0a0a',
            symbolColor: '#9d9d9d',
            height: 32,
        } : undefined,
        title: 'Welcome to KageOps',
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
        backgroundColor: '#0a0a0a',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'welcome-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    const htmlPath = path.join(__dirname, '..', 'renderer', 'welcome', 'index.html');
    void welcomeWindow.loadFile(htmlPath);

    welcomeWindow.on('closed', () => { welcomeWindow = null; });

    return welcomeWindow;
}

export function closeWelcomeWindow(): void {
    if (welcomeWindow !== null && !welcomeWindow.isDestroyed()) {
        welcomeWindow.close();
    }
}

export function shouldShowWelcome(): boolean {
    return !getSettings().hasSeenWelcome;
}
