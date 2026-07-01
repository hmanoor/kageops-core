// PGlite smoke test — verifies our actual schema loads, LISTEN/NOTIFY works,
// pgvector works, triggers fire, full-text search works, gen_random_uuid works.
//
// Run: node scripts/pglite-smoke-test.mjs
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import fs from 'node:fs/promises';
import path from 'node:path';

const t0 = Date.now();
console.log('→ Booting PGlite with vector extension...');
const db = new PGlite({ extensions: { vector } });
await db.waitReady;
console.log(`✓ PGlite ready in ${Date.now() - t0}ms`);

// Test 1: gen_random_uuid()
try {
    const r = await db.query(`SELECT gen_random_uuid() as id`);
    console.log(`✓ gen_random_uuid: ${r.rows[0].id}`);
} catch (e) {
    console.error(`✗ gen_random_uuid FAILED: ${e.message}`);
}

// Test 2: pgvector
try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.query(`CREATE TABLE embed_test (id SERIAL PRIMARY KEY, emb VECTOR(3))`);
    await db.query(`INSERT INTO embed_test (emb) VALUES ('[1,2,3]'), ('[4,5,6]')`);
    const r = await db.query(`SELECT id, emb <-> '[1,2,3]'::vector as dist FROM embed_test ORDER BY dist`);
    console.log(`✓ pgvector: nearest-neighbor query returned ${r.rows.length} rows, closest dist=${r.rows[0].dist}`);
} catch (e) {
    console.error(`✗ pgvector FAILED: ${e.message}`);
}

// Test 3: triggers
try {
    await db.query(`
        CREATE OR REPLACE FUNCTION update_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `);
    await db.query(`CREATE TABLE trig_test (id SERIAL PRIMARY KEY, val TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await db.query(`CREATE TRIGGER trig_update BEFORE UPDATE ON trig_test FOR EACH ROW EXECUTE FUNCTION update_updated_at()`);
    await db.query(`INSERT INTO trig_test (val) VALUES ('hello')`);
    const before = (await db.query(`SELECT updated_at FROM trig_test WHERE id=1`)).rows[0].updated_at;
    await new Promise(r => setTimeout(r, 50));
    await db.query(`UPDATE trig_test SET val='world' WHERE id=1`);
    const after = (await db.query(`SELECT updated_at FROM trig_test WHERE id=1`)).rows[0].updated_at;
    console.log(`✓ triggers: updated_at changed from ${before?.toISOString?.() ?? before} → ${after?.toISOString?.() ?? after}`);
} catch (e) {
    console.error(`✗ triggers FAILED: ${e.message}`);
}

// Test 4: full-text search (to_tsvector + GIN + @@)
try {
    await db.query(`
        CREATE TABLE fts_test (
            id SERIAL PRIMARY KEY,
            body TEXT NOT NULL,
            search_vec TSVECTOR
        )
    `);
    await db.query(`CREATE INDEX fts_test_idx ON fts_test USING GIN(search_vec)`);
    await db.query(`INSERT INTO fts_test (body, search_vec) VALUES ('hello world cats', to_tsvector('english', 'hello world cats')), ('dogs are fine', to_tsvector('english', 'dogs are fine'))`);
    const r = await db.query(`SELECT id, body FROM fts_test WHERE search_vec @@ to_tsquery('english', 'cat')`);
    console.log(`✓ full-text search: query 'cat' matched ${r.rows.length} row(s): ${JSON.stringify(r.rows)}`);
} catch (e) {
    console.error(`✗ full-text search FAILED: ${e.message}`);
}

// Test 5: LISTEN/NOTIFY
try {
    let received = null;
    const unsub = await db.listen('kageops_test_channel', (payload) => {
        received = payload;
    });
    await db.query(`NOTIFY kageops_test_channel, 'hello from kageops'`);
    await new Promise(r => setTimeout(r, 100));
    await unsub();
    if (received === 'hello from kageops') {
        console.log(`✓ LISTEN/NOTIFY: payload delivered correctly`);
    } else {
        console.error(`✗ LISTEN/NOTIFY: expected 'hello from kageops', got ${received}`);
    }
} catch (e) {
    console.error(`✗ LISTEN/NOTIFY FAILED: ${e.message}`);
}

// Test 6: UUID[] arrays and JSONB
try {
    await db.query(`CREATE TABLE array_test (id SERIAL PRIMARY KEY, deps UUID[], meta JSONB)`);
    const u1 = (await db.query(`SELECT gen_random_uuid() as id`)).rows[0].id;
    const u2 = (await db.query(`SELECT gen_random_uuid() as id`)).rows[0].id;
    await db.query(`INSERT INTO array_test (deps, meta) VALUES ($1::UUID[], $2::JSONB)`, [[u1, u2], { foo: 'bar', count: 42 }]);
    const r = await db.query(`SELECT deps, meta FROM array_test WHERE id=1`);
    console.log(`✓ UUID[] + JSONB: deps=${JSON.stringify(r.rows[0].deps)}, meta=${JSON.stringify(r.rows[0].meta)}`);
} catch (e) {
    console.error(`✗ UUID[] / JSONB FAILED: ${e.message}`);
}

// Test 7: ON CONFLICT ... DO UPDATE
try {
    await db.query(`CREATE TABLE conflict_test (key TEXT PRIMARY KEY, val INTEGER)`);
    await db.query(`INSERT INTO conflict_test (key, val) VALUES ('a', 1) ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val`);
    await db.query(`INSERT INTO conflict_test (key, val) VALUES ('a', 99) ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val`);
    const r = await db.query(`SELECT val FROM conflict_test WHERE key='a'`);
    console.log(`✓ ON CONFLICT DO UPDATE: val=${r.rows[0].val} (expected 99)`);
} catch (e) {
    console.error(`✗ ON CONFLICT FAILED: ${e.message}`);
}

// Test 8: load real schema.sql
try {
    const schemaPath = new URL('../src/db/schema.sql', import.meta.url);
    const schema = await fs.readFile(schemaPath, 'utf-8');
    // Create a fresh db for full schema load
    const db2 = new PGlite({ extensions: { vector } });
    await db2.waitReady;
    // PGlite needs `CREATE EXTENSION IF NOT EXISTS vector` to be replaced with explicit loader,
    // but we passed `extensions: { vector }` so vector is preloaded. The SQL line should still work.
    const tLoad = Date.now();
    await db2.exec(schema);
    console.log(`✓ Full schema.sql loaded in ${Date.now() - tLoad}ms`);
    const tables = await db2.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    console.log(`  Tables created: ${tables.rows.map(r => r.tablename).join(', ')}`);
    await db2.close();
} catch (e) {
    console.error(`✗ schema.sql load FAILED: ${e.message}`);
    console.error(`   ${e.stack?.split('\n').slice(0, 3).join('\n   ')}`);
}

await db.close();
console.log(`\nTotal wall-clock: ${Date.now() - t0}ms`);
