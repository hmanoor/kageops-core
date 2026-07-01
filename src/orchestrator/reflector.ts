/**
 * Post-task Reflector
 *
 * When a task fails, run a small (~200 token) Haiku call that extracts a
 * { signature, rootCause, suggestedFix } tuple from the error message and
 * upserts an `incidents` row. Used by Sensei to build a self-healing memory.
 */

import { query, getOne } from '../db/client';
import { sendPrompt } from '../agents/ai-adapter';
import { createLogger } from '../shared/logger';

const log = createLogger('Reflector');

const REFLECTOR_MODEL = process.env['KAGEOPS_REFLECTOR_MODEL']
    ?? 'openrouter/anthropic/claude-haiku-4.5';

const SYSTEM_PROMPT =
    'You are a failure-analysis reflector. Given a task title, task type, agent, and error message, ' +
    'output STRICT JSON with keys: signature (short stable slug, lowercase, no UUIDs/paths/timestamps, ' +
    'max 60 chars), rootCause (1 sentence), suggestedFix (1 sentence). No prose, no markdown fences.';

export interface ReflectionInput {
    readonly projectId: string | null;
    readonly taskId: string;
    readonly agent: string;
    readonly taskType: string | null;
    readonly taskTitle: string;
    readonly errorMessage: string;
}

interface Reflection {
    readonly signature: string;
    readonly rootCause: string;
    readonly suggestedFix: string;
}

function normalizeError(raw: string): string {
    return raw
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/[A-Z]:\\[^\s"'`]+/g, '<path>')
        .replace(/\/[a-z0-9_\-./]+/gi, '<path>')
        .replace(/\d{13,}/g, '<ts>')
        .slice(0, 800);
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

function parseReflection(text: string): Reflection | null {
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        const parsed = JSON.parse(trimmed) as Partial<Reflection>;
        if (
            typeof parsed.signature === 'string' &&
            typeof parsed.rootCause === 'string' &&
            typeof parsed.suggestedFix === 'string'
        ) {
            return {
                signature: slugify(parsed.signature) || 'unknown',
                rootCause: parsed.rootCause.slice(0, 500),
                suggestedFix: parsed.suggestedFix.slice(0, 500),
            };
        }
    } catch {
        // fall through
    }
    return null;
}

export async function reflectOnFailure(input: ReflectionInput): Promise<void> {
    const normalizedErr = normalizeError(input.errorMessage);
    const userPrompt =
        `Agent: ${input.agent}\n` +
        `Task type: ${input.taskType ?? 'unknown'}\n` +
        `Task title: ${input.taskTitle}\n` +
        `Error (normalized):\n${normalizedErr}`;

    let reflection: Reflection | null = null;
    try {
        const response = await sendPrompt(
            REFLECTOR_MODEL,
            SYSTEM_PROMPT,
            userPrompt,
            { maxTokens: 256, temperature: 0 }
        );
        reflection = parseReflection(response.text);
    } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Reflector AI call failed');
    }

    // Fallback signature derived from agent + task_type + first 40 chars of error
    if (reflection === null) {
        reflection = {
            signature: slugify(`${input.agent}-${input.taskType ?? 'x'}-${normalizedErr.slice(0, 40)}`),
            rootCause: normalizedErr.slice(0, 200),
            suggestedFix: 'No reflection available; inspect error manually.',
        };
    }

    try {
        const existing = await getOne<{ id: string; times_seen: number }>(
            'SELECT id, times_seen FROM incidents WHERE signature = $1',
            [reflection.signature]
        );
        if (existing !== null) {
            await query(
                `UPDATE incidents
                   SET times_seen = times_seen + 1,
                       last_seen = NOW(),
                       last_project_id = $1,
                       last_task_id = $2,
                       symptom = $3
                 WHERE id = $4`,
                [input.projectId, input.taskId, normalizedErr.slice(0, 500), existing.id]
            );
        } else {
            await query(
                `INSERT INTO incidents
                    (signature, agent, task_type, symptom, root_cause, suggested_fix,
                     last_project_id, last_task_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    reflection.signature,
                    input.agent,
                    input.taskType,
                    normalizedErr.slice(0, 500),
                    reflection.rootCause,
                    reflection.suggestedFix,
                    input.projectId,
                    input.taskId,
                ]
            );
        }
        log.info({ signature: reflection.signature, agent: input.agent }, 'Incident recorded');
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to persist incident'
        );
    }
}
