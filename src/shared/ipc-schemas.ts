/**
 * KageOps IPC Argument Schemas
 *
 * Zod schemas for validating arguments passed to ipcMain.handle() handlers.
 * Each schema corresponds to one IPC channel that accepts arguments.
 *
 * Usage in main.ts:
 *   const parsed = ApproveGateArgsSchema.safeParse(projectId);
 *   if (!parsed.success) { log.warn(...); return; }
 *   // use parsed.data safely
 */

import { z } from 'zod';

// ── Helpers ──────────────────────────────────────────

/** Non-empty string — used for IDs and names */
const NonEmptyString = z.string().min(1, 'Must be a non-empty string');

/** UUID-shaped string — loose check (not strict UUID format, to allow test ids) */
const IdString = NonEmptyString;

// ── command-center:approve-gate ──────────────────────
// ipcMain.handle('command-center:approve-gate', async (_event, projectId: string) => ...)

export const ApproveGateArgsSchema = z.object({
    projectId: IdString,
});

export type ApproveGateArgs = z.infer<typeof ApproveGateArgsSchema>;

// ── command-center:deny-gate ─────────────────────────
// ipcMain.handle('command-center:deny-gate', async (_event, projectId: string, reason?: string) => ...)

export const DenyGateArgsSchema = z.object({
    projectId: IdString,
    reason: z.string().optional(),
});

export type DenyGateArgs = z.infer<typeof DenyGateArgsSchema>;

// ── command-center:start-project ─────────────────────
// ipcMain.handle('command-center:start-project', async (_event, name: string, description: string) => ...)

export const StartProjectArgsSchema = z.object({
    name: NonEmptyString,
    description: z.string(),
});

export type StartProjectArgs = z.infer<typeof StartProjectArgsSchema>;

// ── command-center:sensei-message ────────────────────
// ipcMain.handle('command-center:sensei-message', async (_event, args: SenseiMessageArgs) => ...)

export const SenseiMessageArgsSchema = z.object({
    message: NonEmptyString,
    /**
     * Optional project UUID. When supplied, Sensei resolves the channel ID
     * to `project:<uuid>` so chat history is shared across team members and
     * persists across restarts (PR B of F-302). Backwards-compat: omitting
     * this falls through to the legacy `'command-center'` in-memory channel.
     */
    projectId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional(),
    /** Optional Clerk user ID of the author. Stored on the persisted row. */
    authorUserId: z.string().optional(),
    /** Optional display name. Defaults to 'Operator' if absent. */
    authorName: z.string().optional(),
    /**
     * Optional project role at the moment the message was sent. Captured
     * contemporaneously so the renderer can show "Alice (reviewer): ..."
     * even after the user's role changes later.
     */
    authorRole: z.enum(['owner', 'reviewer', 'observer']).optional(),
});

export type SenseiMessageArgs = z.infer<typeof SenseiMessageArgsSchema>;

// ── command-center:set-api-key ───────────────────────
// ipcMain.handle('command-center:set-api-key', async (_event, provider: string, key: string) => ...)

const AiProviderSchema = z.enum(['claude', 'openrouter', 'openai', 'gemini', 'ollama']);

export const SetApiKeyArgsSchema = z.object({
    provider: AiProviderSchema,
    key: NonEmptyString,
});

export type SetApiKeyArgs = z.infer<typeof SetApiKeyArgsSchema>;

// ── command-center:delete-api-key ───────────────────
// ipcMain.handle('command-center:delete-api-key', async (_event, provider: string) => ...)

export const DeleteApiKeyArgsSchema = z.object({
    provider: AiProviderSchema,
});

export type DeleteApiKeyArgs = z.infer<typeof DeleteApiKeyArgsSchema>;

// ── command-center:get-operational-costs (v0.7) ──────
// ipcMain.handle('command-center:get-operational-costs', async (_event, windowDays?: number) => ...)

export const GetOperationalCostsArgsSchema = z.object({
    windowDays: z.number().int().min(1).max(365).default(30),
});

export type GetOperationalCostsArgs = z.infer<typeof GetOperationalCostsArgsSchema>;

// ── command-center:get-graph-status (v0.8) ───────────
// ipcMain.handle('command-center:get-graph-status', async (_event, repoPath: string) => ...)

export const GetGraphStatusArgsSchema = z.object({
    repoPath: NonEmptyString,
});

export type GetGraphStatusArgs = z.infer<typeof GetGraphStatusArgsSchema>;

// ── command-center:set-agent-model (v1.0) ────────────
// ipcMain.handle('command-center:set-agent-model', async (_event, args: unknown) => ...)

export const SetAgentModelArgsSchema = z.object({
    agentName: z.string().min(1),
    model: z.string().min(1),
    provider: z.string().min(1),
    fallbackModels: z.array(z.string()).optional().default([]),
});

export type SetAgentModelArgs = z.infer<typeof SetAgentModelArgsSchema>;

// ── command-center:test-agent-model (v1.0) ───────────
// ipcMain.handle('command-center:test-agent-model', async (_event, args: unknown) => ...)

export const TestAgentModelArgsSchema = z.object({
    agentName: z.string().min(1),
    model: z.string().min(1),
    provider: z.string().min(1),
});

export type TestAgentModelArgs = z.infer<typeof TestAgentModelArgsSchema>;

// ── deployments:save (v1.1) ──────────────────────────
// ipcMain.handle('deployments:save', async (_event, target: unknown) => ...)

const DeploymentPurposeSchema = z.enum(['platform', 'shared', 'poc', 'project']);

export const SaveDeploymentArgsSchema = z.object({
    id: NonEmptyString,
    name: NonEmptyString,
    subscriptionId: NonEmptyString,
    resourceGroup: NonEmptyString,
    region: NonEmptyString,
    purpose: DeploymentPurposeSchema,
    projectId: z.string().optional(),
    tags: z.record(z.string(), z.string()),
    createdAt: z.string(),
});

export type SaveDeploymentArgs = z.infer<typeof SaveDeploymentArgsSchema>;

// ── deployments:delete (v1.1) ────────────────────────
// ipcMain.handle('deployments:delete', async (_event, id: unknown) => ...)

export const DeleteDeploymentArgsSchema = z.object({
    id: NonEmptyString,
});

export type DeleteDeploymentArgs = z.infer<typeof DeleteDeploymentArgsSchema>;

// ── log:error (GreenThumb v0.11 Phase 3) ─────────────
// ipcRenderer.send('log:error', args)
// Error logging from renderer to main

export const LogErrorArgsSchema = z.object({
    context: z.string().min(1, 'Context must be provided'),
    message: z.string().min(1, 'Error message must be provided'),
    error: z.unknown().optional(),
});

export type LogErrorArgs = z.infer<typeof LogErrorArgsSchema>;
