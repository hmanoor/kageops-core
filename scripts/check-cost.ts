/**
 * Check what cost_usd values landed in agent_logs for the OpenRouter
 * arm. Diagnoses whether (a) cost is being computed but not surfaced
 * in the UI, or (b) cost is genuinely zero in the DB.
 */

import { initDatabase, getMany, closePool } from '../src/db/client';

async function main(): Promise<void> {
    const dataDirArg = process.argv[2];
    if (dataDirArg !== undefined) {
        process.env['KAGEOPS_DATA_DIR'] = dataDirArg;
    } else if (process.env['KAGEOPS_DATA_DIR'] === undefined) {
        console.error('Usage: tsx scripts/check-cost.ts <KAGEOPS_DATA_DIR>');
        console.error('  (or set the KAGEOPS_DATA_DIR env var — e.g. ~/.kageops)');
        process.exit(1);
    }
    await initDatabase();

    const rows = await getMany<{
        readonly agent: string;
        readonly action: string;
        readonly cost_usd: string | null;
        readonly metadata: Record<string, unknown> | null;
    }>(
        `SELECT agent, action, cost_usd::text AS cost_usd, metadata
         FROM agent_logs
         WHERE action = 'ai-request'
         ORDER BY created_at DESC
         LIMIT 20`,
        [],
    );

    console.log(`agent_logs ai-request rows: ${rows.length}\n`);
    for (const r of rows) {
        const meta = r.metadata ?? {};
        const tokensIn = meta['tokensIn'];
        const tokensOut = meta['tokensOut'];
        const model = meta['model'];
        console.log(
            `  ${r.agent.padEnd(10, ' ')} cost=$${r.cost_usd ?? '?'}  ` +
            `tokens=${tokensIn ?? '?'}→${tokensOut ?? '?'}  ` +
            `model=${model ?? '?'}`,
        );
    }

    const totalRow = await getMany<{ total: string | null; nonzero: string }>(
        `SELECT SUM(cost_usd)::text AS total,
                COUNT(*) FILTER (WHERE cost_usd > 0)::text AS nonzero
         FROM agent_logs WHERE action = 'ai-request'`,
        [],
    );
    if (totalRow.length > 0) {
        const t = totalRow[0];
        console.log(`\n  TOTAL: $${t.total ?? '0'} across ${rows.length} calls; ${t.nonzero} non-zero`);
    }

    await closePool();
}

main().catch((err: unknown) => {
    console.error('Failed:', err);
    process.exit(1);
});
