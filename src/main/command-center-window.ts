/**
 * KageOps Command Center Window
 *
 * Main dashboard window for KageOps.
 */

import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

// KageOps dark theme injected into graphify iframes via frame-created + executeJavaScript.
// Can't use contentDocument (cross-origin file:// dirs); main-process executeJavaScript bypasses that.
const GRAPH_THEME_JS = `(function(){
  var s = document.createElement('style');
  s.textContent = [
    'body { background: #141414 !important; color: #d4d4d4 !important; }',
    '#sidebar { background: #1e1e1e !important; border-left: 1px solid rgba(255,255,255,0.08) !important; }',
    '#search-wrap, #search-results, #info-panel { border-bottom: 1px solid rgba(255,255,255,0.08) !important; }',
    '#search { background: #141414 !important; border: 1px solid rgba(255,255,255,0.12) !important; color: #d4d4d4 !important; border-radius: 4px !important; }',
    '#search:focus { border-color: #4d9e6f !important; box-shadow: 0 0 0 2px rgba(77,158,111,0.25) !important; outline: none !important; }',
    '#search::placeholder { color: #6e6e6e !important; }',
    '.search-item { color: #d4d4d4 !important; }',
    '.search-item:hover { background: rgba(255,255,255,0.06) !important; }',
    '#info-panel h3, #communities h3 { color: #6e6e6e !important; }',
    '#info-content { color: #9d9d9d !important; }',
    '#info-content .field b { color: #d4d4d4 !important; }',
    '#info-content .empty { color: #4e4e4e !important; }',
    '.neighbor-link { border-left: 2px solid rgba(255,255,255,0.15) !important; color: #9d9d9d !important; }',
    '.neighbor-link:hover { background: rgba(255,255,255,0.06) !important; color: #d4d4d4 !important; }',
    '#communities { scrollbar-color: rgba(255,255,255,0.15) transparent; }',
    '.community-item { border-left: 2px solid rgba(255,255,255,0.10) !important; }',
    '#stats { color: #6e6e6e !important; border-top: 1px solid rgba(255,255,255,0.08) !important; background: #1e1e1e !important; }',
  ].join('');
  document.head.appendChild(s);
  // Respond to resize pings from the parent renderer (postMessage is cross-origin safe).
  window.addEventListener('message', function(e) {
    if (e.data === 'kageops:resize') window.dispatchEvent(new Event('resize'));
  });
})();`;

let commandCenterWindow: BrowserWindow | null = null;

/**
 * Create or focus the Command Center window.
 * Returns the window instance.
 */
export function createCommandCenterWindow(): BrowserWindow {
    // If window already exists, focus it
    if (commandCenterWindow !== null && !commandCenterWindow.isDestroyed()) {
        commandCenterWindow.focus();
        return commandCenterWindow;
    }

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    // Frameless window with a VSCode-style custom top bar. We hide the
    // OS title bar but keep the system min/max/close controls:
    //   - macOS shows traffic lights (handled natively by titleBarStyle)
    //   - Windows renders the controls inside titleBarOverlay so they sit
    //     in the top-right at the same height as our top-bar; we paint
    //     the rest of the bar ourselves.
    //   - Linux falls back to a fully frameless window (we expose a
    //     custom close button on that platform if needed; for now the
    //     window just relies on the OS keybinds).
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    commandCenterWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        x: Math.round((screenWidth - 1200) / 2),
        y: Math.round((screenHeight - 800) / 2),
        frame: false,
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        titleBarOverlay: isWin ? {
            color: '#1e1e1e',       // EXACTLY matches --surface from tokens.css
                                     // (was #1c1c1e — close but caused a visible seam
                                     //  between the OS titlebar strip and the page top bar)
            symbolColor: '#B8B8B8', // matches --text-muted
            height: 40,             // matches .top-bar height (shell-polish.css override)
        } : undefined,
        resizable: true,
        alwaysOnTop: false,
        title: 'KageOps — Command Center',
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'command-center-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    // Inject KageOps theme into any graphify graph iframe as soon as its DOM is ready.
    // executeJavaScript on WebFrameMain bypasses the cross-origin file:// restriction
    // that blocks contentDocument access from the renderer.
    commandCenterWindow.webContents.on('frame-created', (_ev, details) => {
        const frame = details.frame;
        if (frame === null) return;
        frame.on('dom-ready', () => {
            if (!(frame.url ?? '').includes('graph.html')) return;
            void frame.executeJavaScript(GRAPH_THEME_JS).catch(() => null);
        });
    });

    // Tag <body> with the platform so CSS can reserve space for the
    // native window controls overlay (top-right on Windows, top-left
    // on macOS where the traffic lights live).
    commandCenterWindow.webContents.on('dom-ready', () => {
        const platformClass = isWin ? 'platform-win'
            : isMac ? 'platform-mac' : 'platform-linux';
        commandCenterWindow?.webContents.executeJavaScript(
            `document.body.classList.add('${platformClass}', 'frameless-window');`
        ).catch(() => null);
    });

    // Load from dist/ so HTML works in both dev and packaged (asar) mode.
    // __dirname is dist/main/ → ../renderer/command-center/ resolves correctly.
    const htmlPath = path.join(__dirname, '..', 'renderer', 'command-center', 'index.html');
    commandCenterWindow.loadFile(htmlPath);

    commandCenterWindow.on('closed', () => {
        commandCenterWindow = null;
    });

    return commandCenterWindow;
}

/**
 * Get the current Command Center window (if open).
 */
export function getCommandCenterWindow(): BrowserWindow | null {
    if (commandCenterWindow !== null && !commandCenterWindow.isDestroyed()) {
        return commandCenterWindow;
    }
    return null;
}

/**
 * Close the Command Center window.
 */
export function closeCommandCenterWindow(): void {
    if (commandCenterWindow !== null && !commandCenterWindow.isDestroyed()) {
        commandCenterWindow.close();
        commandCenterWindow = null;
    }
}
