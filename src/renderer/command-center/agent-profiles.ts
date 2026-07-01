/**
 * KageOps Agent Profiles
 *
 * Shared agent profile data (name, title, description, specialities, color)
 * used by the Command Center and any renderer that needs agent metadata.
 */

export interface AgentProfile {
    readonly title: string;
    readonly description: string;
    readonly specialities: readonly string[];
    readonly color: string;
}

export const AGENT_PROFILES: Readonly<Record<string, AgentProfile>> = {
    sensei: {
        title: 'The Orchestrator',
        description: 'Sensei is the master coordinator of KageOps. He decomposes projects into phases, assigns tasks to the right agents based on the speciality matrix, and ensures quality gates are met before advancing.',
        specialities: ['Task decomposition', 'Agent coordination', 'Phase gate management', 'Quality oversight'],
        color: '#D4AF37',
    },
    scout: {
        title: 'The Strategist',
        description: 'Scout is the reconnaissance specialist who explores project requirements, researches market viability, and maps out the competitive landscape. First on the scene for every new project.',
        specialities: ['Market research', 'Competitive analysis', 'Requirements gathering', 'Feasibility assessment'],
        color: '#6BCB77',
    },
    blueprint: {
        title: 'The Architect',
        description: 'Blueprint designs the technical architecture, defines system boundaries, and creates the structural plans that guide the entire development process. Precision and scalability are his hallmarks.',
        specialities: ['System architecture', 'API design', 'Database schema', 'Technical specifications'],
        color: '#3B82F6',
    },
    pixel: {
        title: 'The Designer',
        description: 'Pixel crafts the visual identity and user experience. From wireframes to polished interfaces, she ensures every interaction feels intuitive and every screen looks stunning.',
        specialities: ['UI/UX design', 'Wireframing', 'Visual design', 'Design systems'],
        color: '#D946EF',
    },
    forge: {
        title: 'The Engineer',
        description: 'Forge is the master builder who turns architectural plans into working code. He writes clean, tested, production-ready implementations with an eye for performance and reliability.',
        specialities: ['Full-stack development', 'Code implementation', 'Testing', 'Performance optimization'],
        color: 'oklch(0.66 0.12 150)',
    },
    cipher: {
        title: 'The Data Specialist',
        description: 'Cipher handles all things data — from database design and query optimization to data pipelines and analytics. He speaks fluent SQL and knows how to make data sing.',
        specialities: ['Database design', 'Data pipelines', 'Query optimization', 'Analytics & reporting'],
        color: '#7C3AED',
    },
    aegis: {
        title: 'The Platform Engineer',
        description: 'Aegis is the guardian of infrastructure. She manages deployments, CI/CD pipelines, cloud resources, and ensures the platform runs smoothly and securely at scale.',
        specialities: ['Infrastructure', 'CI/CD pipelines', 'Cloud deployment', 'Security hardening'],
        color: '#94A3B8',
    },
    vigil: {
        title: 'The Quality Guardian',
        description: 'Vigil is the final line of defense before any code ships. He runs comprehensive quality reviews, catches edge cases others miss, and ensures every deliverable meets KageOps standards.',
        specialities: ['Code review', 'Quality assurance', 'Static analysis', 'Security auditing'],
        color: '#10B981',
    },
    herald: {
        title: 'The Marketer',
        description: 'Herald crafts the story around the product — landing pages, documentation, launch strategies, and growth plans. She makes sure great products get the attention they deserve.',
        specialities: ['Content creation', 'Landing pages', 'Launch strategy', 'Growth marketing'],
        color: '#DC2626',
    },
};
