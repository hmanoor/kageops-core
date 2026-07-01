/**
 * KageOps Zod Schemas
 *
 * Central schema definitions for domain types.
 * These schemas validate data at system boundaries (IPC, event bus, config files).
 * Use `z.infer<typeof schema>` to derive TypeScript types from schemas.
 */

import { z } from 'zod';

// ── EventChannel ─────────────────────────────────────

export const EventChannelSchema = z.enum([
    'task.created',
    'task.assigned',
    'task.progress',
    'task.completed',
    'task.blocked',
    'task.failed',
    'review.requested',
    'review.passed',
    'review.rejected',
    'approval.required',
    'approval.granted',
    'approval.denied',
    'build.started',
    'build.passed',
    'build.failed',
    'build.verification.passed',
    'build.verification.failed',
    // Non-blocking build-gate advisory (2026-06: App Router route collisions)
    'build.verification.warning',
    'acceptance.passed',
    'acceptance.failed',
    'cost.warning',
    'cost.exceeded',
    'agent.benchmark',
    'project.created',
    'pr.created',
    'intercept.pause',
    'intercept.resume',
    'intercept.guidance',
    'intercept.takeover',
    'intercept.handback',
    'intercept.acknowledged',
    'agent.stream',
    // Resilience signals (v0.12 Track A)
    'network.transient',
    'eventbus.reconnected',
    // Subprocess output (B-497 — Agent Terminal panel)
    'subprocess.output',
    // Project lifecycle channels (already in EventChannel TS union but
    // were missing from the runtime Zod enum — schema rejected them and
    // listeners silently dropped the events, breaking the project.completed
    // OS notification path).
    'project.paused',
    'project.resumed',
    'project.cancelled',
    'project.archived',
    'project.restored',
    'project.deleted',
    'project.completed',
    // Team collaboration channels (Phase 3 Sprint 3/4)
    'task.claimed',
    'task.unclaimed',
    'phase.changed',
    // Cloud Burst (Pillar 2.4 / PR-E)
    'burst.queued',
    'burst.provisioning',
    'burst.running',
    'burst.heartbeat',
    'burst.completed',
    'burst.failed',
    'burst.stopped',
    'burst.timeout',
    // App-credential setup copilot (MCC-8 / slice 3)
    'setup.required',
    // BPF-6 — development-gate defer reason for the Command Center
    'gate.deferred',
]);

// ── SubprocessOutputEvent (B-497) ────────────────────
// Streamed stdout/stderr chunks emitted by orchestrator/main spawn sites
// (build-verification, template-cloner, github-push, claude-cli) so the
// Agent Terminal panel can tail them in real time. Bus payload is the
// full event; renderer-side filtering happens by `projectId`.

export const SubprocessSourceSchema = z.enum([
    'build-verification',
    'template-cloner',
    'github-push',
    'claude-cli',
]);

export type SubprocessSource = z.infer<typeof SubprocessSourceSchema>;

export const SubprocessStreamSchema = z.enum(['stdout', 'stderr']);

export type SubprocessStream = z.infer<typeof SubprocessStreamSchema>;

export const SubprocessOutputEventSchema = z.object({
    projectId: z.string().min(1),
    taskId: z.string().optional(),
    agent: z.string().optional(),
    source: SubprocessSourceSchema,
    stream: SubprocessStreamSchema,
    chunk: z.string(),
    ts: z.number(),
});

export type SubprocessOutputEvent = z.infer<typeof SubprocessOutputEventSchema>;

// ── EventPayload ─────────────────────────────────────

export const EventPayloadSchema = z.object({
    channel: EventChannelSchema,
    projectId: z.string().optional(),
    taskId: z.string().optional(),
    agent: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
    timestamp: z.string(),
});

export type EventPayloadValidated = z.infer<typeof EventPayloadSchema>;

// ── TaskInfo ─────────────────────────────────────────

export const TaskInfoSchema = z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    taskType: z.string().min(1),
    phase: z.string().min(1),
    outputPath: z.string().nullable(),
    repoPath: z.string(),
});

export type TaskInfoValidated = z.infer<typeof TaskInfoSchema>;

// ── AgentConfigEntry ─────────────────────────────────

export const AgentConfigEntrySchema = z.object({
    model: z.string().min(1),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(200000),
    systemPromptOverride: z.string().optional(),
    fallbackModels: z.array(z.string()).readonly().optional(),
});

export type AgentConfigEntryValidated = z.infer<typeof AgentConfigEntrySchema>;

// Partial version for agent overrides in config file
export const AgentConfigEntryPartialSchema = AgentConfigEntrySchema.partial();

export type AgentConfigEntryPartialValidated = z.infer<typeof AgentConfigEntryPartialSchema>;

// ── AgentConfigFile ──────────────────────────────────

export const AgentConfigFileSchema = z.object({
    defaults: AgentConfigEntrySchema,
    agents: z.record(z.string(), AgentConfigEntryPartialSchema),
});

export type AgentConfigFileValidated = z.infer<typeof AgentConfigFileSchema>;

// ── BudgetStatus ─────────────────────────────────────

export const BudgetStatusSchema = z.object({
    budgetUsd: z.number().nullable(),
    spentUsd: z.number().min(0),
    remainingUsd: z.number().nullable(),
    exceeded: z.boolean(),
    warningThreshold: z.boolean(),
});

export type BudgetStatusValidated = z.infer<typeof BudgetStatusSchema>;
