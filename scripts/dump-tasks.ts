// Dump tasks for a project, with revision metadata.
// Usage: KAGEOPS_DATA_DIR=... npx tsx scripts/dump-tasks.ts <project-id>
import { initDatabase, getMany, closePool } from '../src/db/client';

(async () => {
    const projectId = process.argv[2];
    if (projectId === undefined) {
        console.error('usage: dump-tasks.ts <project-id>');
        process.exit(2);
    }
    await initDatabase();
    const rows = await getMany<{
        id: string;
        status: string;
        assigned_agent: string | null;
        task_type: string | null;
        iteration_id: string | null;
        revision_instruction: string | null;
        title: string;
        created_at: string;
        completed_at: string | null;
    }>(
        `SELECT id, status, assigned_agent, task_type, iteration_id, revision_instruction, title,
                created_at::text AS created_at, completed_at::text AS completed_at
           FROM tasks
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [projectId],
    );
    console.log(`TASKS (${rows.length}):`);
    for (const r of rows) {
        const ts = r.created_at.slice(11, 19);
        const done = r.completed_at !== null ? r.completed_at.slice(11, 19) : '         ';
        const tt = r.task_type ?? 'null';
        const it = r.iteration_id?.slice(0, 8) ?? 'null';
        console.log(`  [${ts} → ${done}] ${r.status.padEnd(10)} ${tt.padEnd(10)} iter=${it} ${r.assigned_agent ?? '-'} | ${r.title.slice(0, 60)}`);
        if (r.revision_instruction !== null) {
            console.log(`      revision: "${r.revision_instruction.slice(0, 100)}"`);
        }
    }
    await closePool();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
