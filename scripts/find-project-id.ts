// One-shot lookup: print most recent project row matching --name.
// Usage: KAGEOPS_DATA_DIR=... npx tsx scripts/find-project-id.ts <name>
import { initDatabase, getOne, closePool } from '../src/db/client';

(async () => {
    const name = process.argv[2];
    if (name === undefined || name === '') {
        console.error('usage: find-project-id.ts <name>');
        process.exit(2);
    }
    await initDatabase();
    const row = await getOne<{
        id: string;
        status: string;
        phase: string;
        name: string;
    }>(
        'SELECT id, status, phase, name FROM projects WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
        [name],
    );
    if (row === null) {
        console.log('NOT_FOUND');
    } else {
        console.log(`ID=${row.id} STATUS=${row.status} PHASE=${row.phase}`);
    }
    await closePool();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
