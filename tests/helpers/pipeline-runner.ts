/**
 * Pipeline test runner helper.
 *
 * Wraps Sensei with utilities for asserting phase transitions
 * and event emissions in pipeline tests.
 */

import { vi } from 'vitest';
import type { MockEventBus } from './mock-event-bus';

export type Phase = 'discovery' | 'poc' | 'business-viability' | 'design-planning' | 'development' | 'launch-growth';

export interface ProjectStatus {
    readonly id: string;
    readonly name: string;
    readonly phase: Phase;
    readonly status: string;
}

export interface MockSensei {
    startProject: ReturnType<typeof vi.fn>;
    getAllProjectsStatus: ReturnType<typeof vi.fn>;
    getApprovalQueue: ReturnType<typeof vi.fn>;
    approveGate: ReturnType<typeof vi.fn>;
    denyGate: ReturnType<typeof vi.fn>;
    handleUserMessage: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock Sensei that tracks project state internally.
 * Simulates phase transitions and approval gates.
 */
export function createMockSensei(eventBus: MockEventBus): MockSensei {
    const projects = new Map<string, { id: string; name: string; phase: Phase; status: string }>();
    let idCounter = 0;

    const PHASE_ORDER: Phase[] = [
        'discovery', 'poc', 'business-viability',
        'design-planning', 'development', 'launch-growth',
    ];

    const startProject = vi.fn(async (name: string, _description: string, _trustLevel = 'low') => {
        const id = `proj-${++idCounter}`;
        projects.set(id, { id, name, phase: 'discovery', status: 'active' });
        await eventBus.triggerEvent('project.created', { projectId: id });
        return id;
    });

    const getAllProjectsStatus = vi.fn(async () => {
        return [...projects.values()];
    });

    const getApprovalQueue = vi.fn(async () => {
        return [...projects.values()].filter((p) => p.status === 'awaiting-approval');
    });

    const approveGate = vi.fn(async (projectId: string) => {
        const project = projects.get(projectId);
        if (project === undefined) return;

        const currentIdx = PHASE_ORDER.indexOf(project.phase);
        const nextPhase = PHASE_ORDER[currentIdx + 1];

        if (nextPhase !== undefined) {
            project.phase = nextPhase;
            project.status = 'active';
            await eventBus.triggerEvent('phase.advanced', { projectId, phase: nextPhase });
        } else {
            project.status = 'completed';
            await eventBus.triggerEvent('project.completed', { projectId });
        }
    });

    const denyGate = vi.fn(async (projectId: string, _reason?: string) => {
        const project = projects.get(projectId);
        if (project !== undefined) {
            project.status = 'denied';
            await eventBus.triggerEvent('phase.denied', { projectId });
        }
    });

    const handleUserMessage = vi.fn(async (_message: string) => {
        return 'Acknowledged.';
    });

    return {
        startProject,
        getAllProjectsStatus,
        getApprovalQueue,
        approveGate,
        denyGate,
        handleUserMessage,
    };
}

/**
 * Wait for an event to be published on the mock event bus.
 * Resolves when the event is found; rejects after timeoutMs.
 */
export function waitForEvent(
    eventBus: MockEventBus,
    channel: string,
    timeoutMs = 2000
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout waiting for event "${channel}" after ${timeoutMs}ms`));
        }, timeoutMs);

        const handler = async (event: unknown) => {
            const payload = event as Record<string, unknown>;
            if (payload['channel'] === channel) {
                clearTimeout(timer);
                await eventBus.unsubscribe(channel as never, handler as never);
                resolve(payload);
            }
        };

        void eventBus.subscribe(channel, handler as (e: unknown) => void);
    });
}

/**
 * Simulate a full project run through N phases using the mock sensei.
 * Returns the list of phase transitions that occurred.
 */
export async function runProjectThroughPhases(
    sensei: MockSensei,
    eventBus: MockEventBus,
    projectId: string,
    phases: number
): Promise<Phase[]> {
    const transitions: Phase[] = [];

    for (let i = 0; i < phases; i++) {
        await sensei.approveGate(projectId);
        const statuses = await sensei.getAllProjectsStatus();
        const project = (statuses as ProjectStatus[]).find((p) => p.id === projectId);
        if (project !== undefined) {
            transitions.push(project.phase);
        }
    }

    return transitions;
}
