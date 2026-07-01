/**
 * Orchestrator module unit tests
 *
 * Tests module interfaces and types without requiring live Postgres.
 */

import { describe, it, expect } from 'vitest';

describe('orchestrator/event-bus module', () => {
    it('exports EventBus class', async () => {
        const mod = await import('../../src/orchestrator/event-bus');
        expect(typeof mod.EventBus).toBe('function');
    });

    it('EventBus can be instantiated', async () => {
        const { EventBus } = await import('../../src/orchestrator/event-bus');
        const bus = new EventBus('postgres://test:test@localhost:5432/test');
        expect(bus).toBeDefined();
    });
});

describe('orchestrator/task-decomposer module', () => {
    it('exports TaskDecomposer class', async () => {
        const mod = await import('../../src/orchestrator/task-decomposer');
        expect(typeof mod.TaskDecomposer).toBe('function');
    });
});

describe('orchestrator/task-router module', () => {
    it('exports TaskRouter class', async () => {
        const mod = await import('../../src/orchestrator/task-router');
        expect(typeof mod.TaskRouter).toBe('function');
    });
});

describe('orchestrator/phase-gates module', () => {
    it('exports PhaseGateManager class', async () => {
        const mod = await import('../../src/orchestrator/phase-gates');
        expect(typeof mod.PhaseGateManager).toBe('function');
    });
});

describe('orchestrator/speciality-matrix module', () => {
    it('exports SpecialityMatrix class', async () => {
        const mod = await import('../../src/orchestrator/speciality-matrix');
        expect(typeof mod.SpecialityMatrix).toBe('function');
    });

    it('SpecialityMatrix can be instantiated', async () => {
        const { SpecialityMatrix } = await import('../../src/orchestrator/speciality-matrix');
        const matrix = new SpecialityMatrix();
        expect(matrix).toBeDefined();
    });
});

describe('orchestrator/sensei module', () => {
    it('exports Sensei class', async () => {
        const mod = await import('../../src/orchestrator/sensei');
        expect(typeof mod.Sensei).toBe('function');
    });
});
