import { Tray, Menu, nativeImage, app } from 'electron';
import { createCommandCenterWindow } from './command-center-window';
import { showWelcomeWindow } from './welcome-window';
import { createLogger } from '../shared/logger';

const trayLog = createLogger('TrayMenu');

let tray: Tray | null = null;

/**
 * Optional callback invoked when the operator clicks "Stop all bursts…"
 * in the tray menu. Wired by main.ts to delegate to
 * cloud-burst-handlers.handleStopAllBursts so the kill switch works
 * even when the Command Center window is closed (D-C requirement).
 *
 * Kept as a setter rather than an import so this module stays
 * dependency-free for tests.
 */
let stopAllBurstsHandler: (() => Promise<void>) | null = null;

export function setStopAllBurstsHandler(fn: (() => Promise<void>) | null): void {
    stopAllBurstsHandler = fn;
}

/**
 * Sign-out is commercial (Clerk auth). main.ts wires this from the commercial
 * extensions registry; null in the open build (no auth), where the menu item
 * no-ops. Kept as a setter so this module stays import-free of auth-window.
 */
let signOutHandler: (() => void) | null = null;

export function setSignOutHandler(fn: (() => void) | null): void {
    signOutHandler = fn;
}

export function createTray(): Tray {
  // KageOps favicon — dark tile + moss-green triangle. Rendered procedurally
  // so the tray never falls back to a generic placeholder.
  const icon = renderFaviconMark(32);

  tray = new Tray(icon);
  tray.setToolTip('KageOps');

  // Left-click: open Command Center
  tray.on('click', () => {
    createCommandCenterWindow();
  });

  rebuildMenu();
  return tray;
}

export function rebuildMenu(): void {
  if (!tray) return;

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'KageOps', enabled: false },
    { type: 'separator' },
    {
      label: 'Open Command Center',
      click: () => createCommandCenterWindow(),
    },
    {
      label: 'Show Welcome',
      click: () => showWelcomeWindow(),
    },
    { type: 'separator' },
    {
      // Pillar 2.4 / D-C kill switch reachable even when the Command
      // Center is closed. Always shown; when no bursts are active the
      // handler is a fast no-op (stop-all returns stopped=0).
      label: 'Stop all cloud bursts',
      enabled: stopAllBurstsHandler !== null,
      click: () => {
        if (stopAllBurstsHandler === null) return;
        stopAllBurstsHandler().catch((err: unknown) => {
          trayLog.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'tray "Stop all cloud bursts" handler threw'
          );
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Sign Out',
      click: () => { if (signOutHandler !== null) signOutHandler(); },
    },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

/**
 * Render the KageOps favicon mark at the requested square size.
 * Design: dark rounded-rect tile (#0f0f0f) + centred moss-green triangle.
 * Matches assets/branding/kageops-favicon.svg (viewBox 0 0 16 16).
 *
 *   <rect width="16" height="16" rx="3" fill="#0f0f0f"/>
 *   <path d="M4 5 L12 5 L8 12 Z" fill="#5BB377"/>
 */
function renderFaviconMark(size: number): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 16;                              // scale factor (16-unit SVG grid)
  const radius = 3 * s;                             // rounded-rect corner radius
  const bg: readonly [number, number, number] = [15, 15, 15];      // #0f0f0f
  const fg: readonly [number, number, number] = [91, 179, 119];    // #5BB377

  // Triangle vertices scaled from the 16×16 grid
  const triA: readonly [number, number] = [4 * s, 5 * s];
  const triB: readonly [number, number] = [12 * s, 5 * s];
  const triC: readonly [number, number] = [8 * s, 12 * s];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const bgA  = roundedRectAlpha(px, py, 0, 0, size, size, radius);
      const triAlpha = filledTriAlpha(px, py, triA, triB, triC);
      const alpha = Math.max(bgA, triAlpha);
      if (alpha < 0.01) continue;

      const idx = (y * size + x) * 4;
      const t = triAlpha;
      buf[idx]     = Math.round(fg[0] * t + bg[0] * (1 - t));
      buf[idx + 1] = Math.round(fg[1] * t + bg[1] * (1 - t));
      buf[idx + 2] = Math.round(fg[2] * t + bg[2] * (1 - t));
      buf[idx + 3] = Math.round(alpha * 255);
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function roundedRectAlpha(
  px: number, py: number,
  x: number, y: number, w: number, h: number,
  r: number,
): number {
  // Signed distance to a rounded rectangle, anti-aliased at the edge
  const cx = clamp(px, x + r, x + w - r) - px;
  const cy = clamp(py, y + r, y + h - r) - py;
  const d = Math.hypot(cx, cy) - r;
  return clamp01(0.5 - d);
}

function filledTriAlpha(
  px: number, py: number,
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): number {
  const cross = (
    p1: readonly [number, number],
    p2: readonly [number, number],
    p3: readonly [number, number],
  ): number => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);

  const p: readonly [number, number] = [px, py];
  const d1 = cross(p, a, b);
  const d2 = cross(p, b, c);
  const d3 = cross(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  if (hasNeg && hasPos) {
    const dEdge = Math.min(
      segDist(px, py, a, b),
      segDist(px, py, b, c),
      segDist(px, py, c, a),
    );
    return clamp01(0.5 - dEdge);
  }
  return 1;
}

function segDist(
  px: number, py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
