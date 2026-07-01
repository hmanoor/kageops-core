/**
 * Zod Schema Tests
 *
 * Comprehensive tests for all schemas in src/shared/schemas.ts
 * and src/shared/ipc-schemas.ts.
 *
 * Verifies:
 *   - Valid data passes (parse succeeds)
 *   - Invalid / malformed data fails with descriptive errors
 *   - Edge cases for each field constraint
 */

import { describe, it, expect } from 'vitest';
import {
    EventChannelSchema,
    EventPayloadSchema,
    TaskInfoSchema,
    AgentConfigEntrySchema,
    AgentConfigEntryPartialSchema,
    AgentConfigFileSchema,
    BudgetStatusSchema,
    SubprocessOutputEventSchema,
    SubprocessSourceSchema,
    SubprocessStreamSchema,
} from '../../src/shared/schemas';
import {
    ApproveGateArgsSchema,
    DenyGateArgsSchema,
    StartProjectArgsSchema,
    SenseiMessageArgsSchema,
    SetApiKeyArgsSchema,
    DeleteApiKeyArgsSchema,
} from '../../src/shared/ipc-schemas';

// ── EventChannelSchema ───────────────────────────────────────────────────────

describe('EventChannelSchema', () => {
    it('accepts all valid event channels', () => {
        const validChannels = [
            'task.created', 'task.assigned', 'task.progress', 'task.completed',
            'task.blocked', 'task.failed', 'review.requested', 'review.passed',
            'review.rejected', 'approval.required', 'approval.granted', 'approval.denied',
            'build.started', 'build.passed', 'build.failed',
            'cost.warning', 'cost.exceeded', 'agent.benchmark',
        ];

        for (const channel of validChannels) {
            const result = EventChannelSchema.safeParse(channel);
            expect(result.success, `Expected '${channel}' to be valid`).toBe(true);
        }
    });

    it('rejects unknown channel names', () => {
        const result = EventChannelSchema.safeParse('unknown.event');
        expect(result.success).toBe(false);
    });

    it('rejects empty string', () => {
        const result = EventChannelSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('rejects non-string values', () => {
        expect(EventChannelSchema.safeParse(42).success).toBe(false);
        expect(EventChannelSchema.safeParse(null).success).toBe(false);
        expect(EventChannelSchema.safeParse(undefined).success).toBe(false);
    });
});

// ── EventPayloadSchema ───────────────────────────────────────────────────────

describe('EventPayloadSchema', () => {
    const validPayload = {
        channel: 'task.completed',
        projectId: 'proj-123',
        taskId: 'task-456',
        agent: 'forge',
        data: { title: 'Build feature', durationMs: 5000 },
        timestamp: '2026-04-07T10:00:00.000Z',
    };

    it('accepts a fully populated valid payload', () => {
        const result = EventPayloadSchema.safeParse(validPayload);
        expect(result.success).toBe(true);
    });

    it('accepts payload with only required fields (channel, data, timestamp)', () => {
        const minimal = {
            channel: 'task.created',
            data: {},
            timestamp: '2026-04-07T10:00:00.000Z',
        };
        const result = EventPayloadSchema.safeParse(minimal);
        expect(result.success).toBe(true);
    });

    it('treats projectId as optional', () => {
        const { projectId: _, ...withoutProject } = validPayload;
        const result = EventPayloadSchema.safeParse(withoutProject);
        expect(result.success).toBe(true);
    });

    it('treats taskId as optional', () => {
        const { taskId: _, ...withoutTask } = validPayload;
        const result = EventPayloadSchema.safeParse(withoutTask);
        expect(result.success).toBe(true);
    });

    it('treats agent as optional', () => {
        const { agent: _, ...withoutAgent } = validPayload;
        const result = EventPayloadSchema.safeParse(withoutAgent);
        expect(result.success).toBe(true);
    });

    it('rejects payload with invalid channel', () => {
        const result = EventPayloadSchema.safeParse({ ...validPayload, channel: 'not.a.channel' });
        expect(result.success).toBe(false);
    });

    it('rejects payload missing data field', () => {
        const { data: _, ...withoutData } = validPayload;
        const result = EventPayloadSchema.safeParse(withoutData);
        expect(result.success).toBe(false);
    });

    it('rejects payload missing timestamp', () => {
        const { timestamp: _, ...withoutTimestamp } = validPayload;
        const result = EventPayloadSchema.safeParse(withoutTimestamp);
        expect(result.success).toBe(false);
    });

    it('rejects payload where data is not a record', () => {
        const result = EventPayloadSchema.safeParse({ ...validPayload, data: 'not-an-object' });
        expect(result.success).toBe(false);
    });

    it('rejects null payload', () => {
        expect(EventPayloadSchema.safeParse(null).success).toBe(false);
    });

    it('rejects completely malformed input', () => {
        expect(EventPayloadSchema.safeParse('{"channel":"bad"}').success).toBe(false);
        expect(EventPayloadSchema.safeParse(42).success).toBe(false);
    });

    it('data record accepts nested unknown values', () => {
        const result = EventPayloadSchema.safeParse({
            ...validPayload,
            data: { nested: { deeply: [1, 2, 3] }, nullVal: null },
        });
        expect(result.success).toBe(true);
    });
});

// ── TaskInfoSchema ───────────────────────────────────────────────────────────

describe('TaskInfoSchema', () => {
    const validTask = {
        id: 'task-001',
        projectId: 'proj-001',
        title: 'Implement login page',
        description: 'Build the authentication UI',
        taskType: 'feature',
        phase: 'development',
        outputPath: 'src/auth/login.ts',
        repoPath: '/projects/my-app',
    };

    it('accepts a fully valid task', () => {
        expect(TaskInfoSchema.safeParse(validTask).success).toBe(true);
    });

    it('accepts outputPath as null', () => {
        const result = TaskInfoSchema.safeParse({ ...validTask, outputPath: null });
        expect(result.success).toBe(true);
    });

    it('accepts empty repoPath', () => {
        const result = TaskInfoSchema.safeParse({ ...validTask, repoPath: '' });
        expect(result.success).toBe(true);
    });

    it('rejects empty id', () => {
        const result = TaskInfoSchema.safeParse({ ...validTask, id: '' });
        expect(result.success).toBe(false);
    });

    it('rejects empty projectId', () => {
        const result = TaskInfoSchema.safeParse({ ...validTask, projectId: '' });
        expect(result.success).toBe(false);
    });

    it('rejects empty title', () => {
        const result = TaskInfoSchema.safeParse({ ...validTask, title: '' });
        expect(result.success).toBe(false);
    });

    it('rejects missing required fields', () => {
        const { id: _, ...withoutId } = validTask;
        expect(TaskInfoSchema.safeParse(withoutId).success).toBe(false);
    });

    it('rejects outputPath as a number', () => {
        const result = TaskInfoSchema.safeParse({ ...validTask, outputPath: 42 });
        expect(result.success).toBe(false);
    });
});

// ── AgentConfigEntrySchema ───────────────────────────────────────────────────

describe('AgentConfigEntrySchema', () => {
    const validEntry = {
        model: 'claude/claude-sonnet-4-20250514',
        temperature: 0.7,
        maxTokens: 4096,
    };

    it('accepts a minimal valid entry', () => {
        expect(AgentConfigEntrySchema.safeParse(validEntry).success).toBe(true);
    });

    it('accepts entry with all optional fields', () => {
        const full = {
            ...validEntry,
            systemPromptOverride: 'You are a specialist.',
            fallbackModels: ['openrouter/gpt-4', 'ollama/llama3'],
        };
        expect(AgentConfigEntrySchema.safeParse(full).success).toBe(true);
    });

    it('rejects empty model string', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, model: '' }).success).toBe(false);
    });

    it('rejects temperature below 0', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, temperature: -0.1 }).success).toBe(false);
    });

    it('rejects temperature above 2', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, temperature: 2.1 }).success).toBe(false);
    });

    it('accepts temperature boundary values (0 and 2)', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, temperature: 0 }).success).toBe(true);
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, temperature: 2 }).success).toBe(true);
    });

    it('rejects maxTokens below 1', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, maxTokens: 0 }).success).toBe(false);
    });

    it('rejects maxTokens above 200000', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, maxTokens: 200001 }).success).toBe(false);
    });

    it('accepts maxTokens boundary values (1 and 200000)', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, maxTokens: 1 }).success).toBe(true);
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, maxTokens: 200000 }).success).toBe(true);
    });

    it('rejects non-integer maxTokens', () => {
        expect(AgentConfigEntrySchema.safeParse({ ...validEntry, maxTokens: 4096.5 }).success).toBe(false);
    });
});

// ── AgentConfigEntryPartialSchema ────────────────────────────────────────────

describe('AgentConfigEntryPartialSchema', () => {
    it('accepts empty object (all fields optional)', () => {
        expect(AgentConfigEntryPartialSchema.safeParse({}).success).toBe(true);
    });

    it('accepts only model override', () => {
        expect(AgentConfigEntryPartialSchema.safeParse({ model: 'ollama/llama3' }).success).toBe(true);
    });

    it('rejects invalid temperature even when partial', () => {
        expect(AgentConfigEntryPartialSchema.safeParse({ temperature: 5 }).success).toBe(false);
    });
});

// ── AgentConfigFileSchema ────────────────────────────────────────────────────

describe('AgentConfigFileSchema', () => {
    const validConfig = {
        defaults: {
            model: 'claude/claude-sonnet-4-20250514',
            temperature: 0.7,
            maxTokens: 4096,
        },
        agents: {
            forge: { model: 'claude/claude-sonnet-4-20250514', maxTokens: 8192 },
            scout: { temperature: 0.5 },
        },
    };

    it('accepts a valid config file structure', () => {
        expect(AgentConfigFileSchema.safeParse(validConfig).success).toBe(true);
    });

    it('accepts empty agents record', () => {
        const result = AgentConfigFileSchema.safeParse({ ...validConfig, agents: {} });
        expect(result.success).toBe(true);
    });

    it('rejects config missing defaults', () => {
        const { defaults: _, ...withoutDefaults } = validConfig;
        expect(AgentConfigFileSchema.safeParse(withoutDefaults).success).toBe(false);
    });

    it('rejects config missing agents', () => {
        const { agents: _, ...withoutAgents } = validConfig;
        expect(AgentConfigFileSchema.safeParse(withoutAgents).success).toBe(false);
    });

    it('rejects config with invalid defaults temperature', () => {
        const result = AgentConfigFileSchema.safeParse({
            ...validConfig,
            defaults: { ...validConfig.defaults, temperature: 99 },
        });
        expect(result.success).toBe(false);
    });
});

// ── BudgetStatusSchema ───────────────────────────────────────────────────────

describe('BudgetStatusSchema', () => {
    it('accepts valid budget status with budget set', () => {
        const status = {
            budgetUsd: 10.0,
            spentUsd: 3.5,
            remainingUsd: 6.5,
            exceeded: false,
            warningThreshold: false,
        };
        expect(BudgetStatusSchema.safeParse(status).success).toBe(true);
    });

    it('accepts unlimited budget (null fields)', () => {
        const status = {
            budgetUsd: null,
            spentUsd: 0,
            remainingUsd: null,
            exceeded: false,
            warningThreshold: false,
        };
        expect(BudgetStatusSchema.safeParse(status).success).toBe(true);
    });

    it('accepts exceeded status', () => {
        const status = {
            budgetUsd: 5.0,
            spentUsd: 6.0,
            remainingUsd: -1.0,
            exceeded: true,
            warningThreshold: true,
        };
        expect(BudgetStatusSchema.safeParse(status).success).toBe(true);
    });

    it('rejects negative spentUsd', () => {
        const status = {
            budgetUsd: 10.0,
            spentUsd: -1.0,
            remainingUsd: 11.0,
            exceeded: false,
            warningThreshold: false,
        };
        expect(BudgetStatusSchema.safeParse(status).success).toBe(false);
    });

    it('rejects missing exceeded field', () => {
        const result = BudgetStatusSchema.safeParse({
            budgetUsd: 10.0,
            spentUsd: 3.5,
            remainingUsd: 6.5,
            warningThreshold: false,
        });
        expect(result.success).toBe(false);
    });

    it('rejects non-boolean exceeded', () => {
        const result = BudgetStatusSchema.safeParse({
            budgetUsd: 10.0,
            spentUsd: 3.5,
            remainingUsd: 6.5,
            exceeded: 'yes',
            warningThreshold: false,
        });
        expect(result.success).toBe(false);
    });
});

// ── IPC Schemas ──────────────────────────────────────────────────────────────

describe('ApproveGateArgsSchema', () => {
    it('accepts valid projectId', () => {
        expect(ApproveGateArgsSchema.safeParse({ projectId: 'proj-123' }).success).toBe(true);
    });

    it('rejects empty projectId', () => {
        expect(ApproveGateArgsSchema.safeParse({ projectId: '' }).success).toBe(false);
    });

    it('rejects missing projectId', () => {
        expect(ApproveGateArgsSchema.safeParse({}).success).toBe(false);
    });

    it('rejects numeric projectId', () => {
        expect(ApproveGateArgsSchema.safeParse({ projectId: 42 }).success).toBe(false);
    });
});

describe('DenyGateArgsSchema', () => {
    it('accepts projectId with optional reason', () => {
        expect(DenyGateArgsSchema.safeParse({ projectId: 'proj-123', reason: 'Not ready' }).success).toBe(true);
    });

    it('accepts projectId without reason', () => {
        expect(DenyGateArgsSchema.safeParse({ projectId: 'proj-123' }).success).toBe(true);
    });

    it('rejects empty projectId', () => {
        expect(DenyGateArgsSchema.safeParse({ projectId: '' }).success).toBe(false);
    });

    it('rejects non-string reason', () => {
        // reason must be string if provided — the schema allows undefined but not number
        expect(DenyGateArgsSchema.safeParse({ projectId: 'proj-123', reason: 42 }).success).toBe(false);
    });
});

describe('StartProjectArgsSchema', () => {
    it('accepts valid name and description', () => {
        expect(StartProjectArgsSchema.safeParse({ name: 'My App', description: 'A great app' }).success).toBe(true);
    });

    it('accepts empty description', () => {
        expect(StartProjectArgsSchema.safeParse({ name: 'My App', description: '' }).success).toBe(true);
    });

    it('rejects empty name', () => {
        expect(StartProjectArgsSchema.safeParse({ name: '', description: 'desc' }).success).toBe(false);
    });

    it('rejects missing name', () => {
        expect(StartProjectArgsSchema.safeParse({ description: 'desc' }).success).toBe(false);
    });

    it('rejects missing description', () => {
        expect(StartProjectArgsSchema.safeParse({ name: 'My App' }).success).toBe(false);
    });
});

describe('SenseiMessageArgsSchema', () => {
    it('accepts valid non-empty message', () => {
        expect(SenseiMessageArgsSchema.safeParse({ message: 'Hello Sensei' }).success).toBe(true);
    });

    it('rejects empty message', () => {
        expect(SenseiMessageArgsSchema.safeParse({ message: '' }).success).toBe(false);
    });

    it('rejects missing message', () => {
        expect(SenseiMessageArgsSchema.safeParse({}).success).toBe(false);
    });

    it('rejects numeric message', () => {
        expect(SenseiMessageArgsSchema.safeParse({ message: 42 }).success).toBe(false);
    });
});

describe('SetApiKeyArgsSchema', () => {
    it('accepts valid provider and key', () => {
        expect(SetApiKeyArgsSchema.safeParse({ provider: 'claude', key: 'sk-ant-abc123' }).success).toBe(true);
    });

    it('accepts all valid provider values', () => {
        const providers = ['claude', 'openrouter', 'openai', 'gemini', 'ollama'];
        for (const provider of providers) {
            const result = SetApiKeyArgsSchema.safeParse({ provider, key: 'test-key' });
            expect(result.success, `Expected '${provider}' to be valid`).toBe(true);
        }
    });

    it('rejects unknown provider', () => {
        expect(SetApiKeyArgsSchema.safeParse({ provider: 'unknown-ai', key: 'abc' }).success).toBe(false);
    });

    it('rejects empty key', () => {
        expect(SetApiKeyArgsSchema.safeParse({ provider: 'claude', key: '' }).success).toBe(false);
    });

    it('rejects missing provider', () => {
        expect(SetApiKeyArgsSchema.safeParse({ key: 'sk-abc' }).success).toBe(false);
    });
});

describe('DeleteApiKeyArgsSchema', () => {
    it('accepts valid provider', () => {
        expect(DeleteApiKeyArgsSchema.safeParse({ provider: 'openai' }).success).toBe(true);
    });

    it('rejects unknown provider', () => {
        expect(DeleteApiKeyArgsSchema.safeParse({ provider: 'mystery-ai' }).success).toBe(false);
    });

    it('rejects missing provider', () => {
        expect(DeleteApiKeyArgsSchema.safeParse({}).success).toBe(false);
    });
});

// ── SubprocessOutputEventSchema (B-497) ─────────────────────────────────────

describe('SubprocessOutputEventSchema', () => {
    const valid = {
        projectId: 'proj-1',
        source: 'build-verification' as const,
        stream: 'stdout' as const,
        chunk: 'hello\n',
        ts: 1_700_000_000_000,
    };

    it('accepts a minimal valid event', () => {
        expect(SubprocessOutputEventSchema.safeParse(valid).success).toBe(true);
    });

    it('accepts optional taskId and agent', () => {
        const out = SubprocessOutputEventSchema.parse({
            ...valid,
            taskId: 't-7',
            agent: 'forge',
        });
        expect(out.taskId).toBe('t-7');
        expect(out.agent).toBe('forge');
    });

    it('rejects an empty projectId', () => {
        expect(SubprocessOutputEventSchema.safeParse({ ...valid, projectId: '' }).success).toBe(false);
    });

    it('rejects unknown source values', () => {
        expect(
            SubprocessOutputEventSchema.safeParse({ ...valid, source: 'mystery' }).success
        ).toBe(false);
    });

    it('rejects stream values that are not stdout/stderr', () => {
        expect(
            SubprocessOutputEventSchema.safeParse({ ...valid, stream: 'log' }).success
        ).toBe(false);
    });

    it('rejects non-numeric timestamps', () => {
        expect(
            SubprocessOutputEventSchema.safeParse({ ...valid, ts: 'now' }).success
        ).toBe(false);
    });

    it('rejects non-string chunks', () => {
        expect(
            SubprocessOutputEventSchema.safeParse({ ...valid, chunk: 123 }).success
        ).toBe(false);
    });

    it('SubprocessSourceSchema enumerates the four spawn sites', () => {
        expect(SubprocessSourceSchema.options).toEqual([
            'build-verification',
            'template-cloner',
            'github-push',
            'claude-cli',
        ]);
    });

    it('SubprocessStreamSchema covers stdout and stderr only', () => {
        expect(SubprocessStreamSchema.options).toEqual(['stdout', 'stderr']);
    });
});
