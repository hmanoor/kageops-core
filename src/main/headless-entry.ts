/**
 * KageOps Headless Entry Point
 *
 * Standalone Node.js entry point for the HTTP control plane.
 * Does NOT import Electron — runs in plain Node (ACI, Docker, etc.)
 *
 * Usage:
 *   node dist/main/headless-entry.js
 *
 * Required env:
 *   DATABASE_URL            PostgreSQL connection string
 *   KAGEOPS_PORT            HTTP port (default 8080)
 *   AZURE_KEYVAULT_URI      Optional — enables Key Vault secret fetch
 *   AZURE_CLIENT_ID         Optional — managed identity client ID
 */

import { createHeadlessServer } from './headless-server';
import { createLogger } from '../shared/logger';

const log = createLogger('HeadlessEntry');

async function main(): Promise<void> {
    log.info({ node: process.version, pid: process.pid }, 'KageOps headless starting');

    // Orchestrator is currently disabled in headless mode because it depends
    // on Electron APIs (BrowserWindow, ipcMain) through the activity bridge.
    // The HTTP control plane starts without it — /health returns status ok,
    // orchestrator field shows "unavailable".
    // TODO: extract orchestrator-bootstrap into a pure Node module to re-enable.
    const orchestrator = null;

    const server = createHeadlessServer(orchestrator);

    // Graceful shutdown
    const shutdown = (signal: string): void => {
        log.info({ signal }, 'Shutdown signal received');
        server.close();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[HeadlessEntry] Fatal error: ${msg}\n`);
    process.exit(1);
});
