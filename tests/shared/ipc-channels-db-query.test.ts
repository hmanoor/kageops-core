import { describe, it, expect } from 'vitest';

import { IPC } from '../../src/shared/ipc-channels';

// KO-SEC-002: the renderer must never be able to send raw SQL across the
// IPC boundary. `db:query` accepted an arbitrary `sql` string from the
// renderer and executed it verbatim against the pool — remove the channel
// entirely and replace its one caller with a fixed, parameterless query.
describe('IPC channels — db:query removal (KO-SEC-002)', () => {
  it('does not expose a generic db:query passthrough channel', () => {
    expect('DB_QUERY' in IPC).toBe(false);
    expect(Object.values(IPC)).not.toContain('db:query');
  });

  it('exposes a narrow projects:is-empty channel instead', () => {
    expect(IPC.PROJECTS_IS_EMPTY).toBe('projects:is-empty');
  });
});
