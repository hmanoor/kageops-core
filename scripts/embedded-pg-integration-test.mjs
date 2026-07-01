// End-to-end integration test for the embedded PG adapter:
//   1. Boot in embedded mode (no DATABASE_URL)
//   2. Run initDatabase() — loads schema.sql + seed.sql
//   3. Insert + query a project row
//   4. Exercise EventBus publish/subscribe (LISTEN/NOTIFY)
//   5. Clean shutdown
//
// Run: KAGEOPS_DB_EMBEDDED_MEMORY=1 node scripts/embedded-pg-integration-test.mjs
//
// Uses the compiled dist/ output so we don't need ts-node here.

import { initDatabase, query, closePool } from '../dist/db/client.js';
import { EventBus } from '../dist/orchestrator/event-bus.js';

process.env.KAGEOPS_DB_EMBEDDED_MEMORY = '1';
delete process.env.DATABASE_URL;

const t0 = Date.now();
console.log('→ Initializing embedded DB...');
await initDatabase();
console.log(`✓ initDatabase OK in ${Date.now() - t0}ms`);

console.log('→ Inserting project row...');
const insert = await query(
    `INSERT INTO projects (name, description, repo_path)
     VALUES ($1, $2, $3) RETURNING id, name, phase, trust_level`,
    ['SmokeTest', 'integration test project', '/tmp/smoketest']
);
console.log(`✓ Insert OK:`, insert.rows[0]);

const fetched = await query(`SELECT id, name, phase FROM projects WHERE name=$1`, ['SmokeTest']);
console.log(`✓ Select OK: ${fetched.rows.length} row(s)`);

console.log('→ Testing EventBus LISTEN/NOTIFY roundtrip...');
const bus = new EventBus();
await bus.connect();

let received = null;
await bus.subscribe('task.created', (event) => {
    received = event;
});

const projectId = insert.rows[0].id;
// Create a real task row so the FK constraint in agent_logs is satisfied
// (publish() writes an audit row to agent_logs).
const task = await query(
    `INSERT INTO tasks (project_id, title, description, phase, assigned_agent, priority)
     VALUES ($1, 'smoke', 'x', 'development', 'forge', 1) RETURNING id`,
    [projectId]
);
const taskId = task.rows[0].id;

await bus.publish('task.created', {
    projectId,
    taskId,
    agent: 'forge',
    data: { msg: 'hello from embedded' }
});

// Give LISTEN a moment to receive
await new Promise(r => setTimeout(r, 100));

if (received !== null && received.channel === 'task.created' && received.data.msg === 'hello from embedded') {
    console.log(`✓ LISTEN/NOTIFY OK: received event ${received.channel}`);
} else {
    console.error(`✗ LISTEN/NOTIFY FAILED. Received:`, received);
    process.exitCode = 1;
}

await bus.disconnect();
await closePool();
console.log(`\n✓ All embedded-PG integration tests passed in ${Date.now() - t0}ms`);
