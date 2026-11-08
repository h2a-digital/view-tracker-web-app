import { describe, it, expect } from 'vitest';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
import { readFileSync } from 'node:fs';
describe('direct integrations incremental migration', () => {
  it('enforces policy approval in the database before accepting views or inserting a finalized statement', async () => {
    const db = await createTestDatabase(true, 4);
    try {
      const d = populatedDocument();
      const statement = d.statements[0];
      d.statements = [];
      d.adjustments = [];
      d.accounts[0].provider = 'direct';
      d.accounts[0].platform = 'youtube';
      d.posts[0].platform = 'youtube';
      d.posts[0].url = 'https://www.youtube.com/watch?v=video';
      const rev = (
        await db.query<{ r: number }>("select (public.read_dashboard()->>'revision')::int r")
      ).rows[0].r;
      await db.query('select public.commit_dashboard($1,$2::jsonb)', [rev, JSON.stringify(d)]);
      await db.query(
        `update public.accounts set integration='{"payoutsBlocked":true}'::jsonb where id=$1`,
        [d.accounts[0].id]
      );
      await expect(
        db.query('update public.posts set eligible_views=eligible_views+1 where id=$1', [
          d.posts[0].id,
        ])
      ).rejects.toThrow('Provider policy approval');
      await expect(
        db.query(
          'insert into public.statements select (jsonb_populate_record(null::public.statements,$1::jsonb)).*',
          [JSON.stringify({ ...statement, status: 'finalized' })]
        )
      ).rejects.toThrow('Provider policy approval');
    } finally {
      await db.close();
    }
  });
  it('preserves existing financial/history records and isolates encrypted credentials from dashboard and browser roles', async () => {
    const db = await createTestDatabase(true, 3);
    try {
      const d = populatedDocument();
      const rev = Number(
        (await db.query<{ r: number }>("select (public.read_dashboard()->>'revision')::int r"))
          .rows[0].r
      );
      await db.query('select public.commit_dashboard($1,$2::jsonb)', [rev, JSON.stringify(d)]);
      const before = (await db.query<{ d: { data: unknown } }>('select public.read_dashboard() d'))
        .rows[0].d;
      await db.exec(
        readFileSync('supabase/migrations/202611080003_direct_integrations.sql', 'utf8')
      );
      const after = (
        await db.query<{ d: { data: typeof d; schemaVersion: number } }>(
          'select public.read_dashboard() d'
        )
      ).rows[0].d;
      expect(after.schemaVersion).toBe(4);
      expect(after.data.statements).toEqual((before.data as typeof d).statements);
      expect(after.data.snapshots.map((s) => s.views)).toEqual(d.snapshots.map((s) => s.views));
      expect(after.data.accounts[0].provider).toBe(d.accounts[0].provider);
      // Equal daily counters collected at one instant are distinct evidence.
      const snapshot = {
        ...after.data.snapshots[0],
        id: crypto.randomUUID(),
        provenance: {
          kind: 'daily',
          metricName: 'analytics.views.non_advertising',
          periodStart: '2026-11-01T08:00:00.000Z',
        },
      };
      const insert =
        'insert into public.snapshots select (jsonb_populate_record(null::public.snapshots,$1::jsonb)).*';
      await db.query(insert, [JSON.stringify(snapshot)]);
      await db.query(insert, [
        JSON.stringify({
          ...snapshot,
          id: crypto.randomUUID(),
          provenance: { ...snapshot.provenance, periodStart: '2026-11-02T08:00:00.000Z' },
        }),
      ]);
      await expect(
        db.query(insert, [JSON.stringify({ ...snapshot, id: crypto.randomUUID() })])
      ).rejects.toThrow('unique');
      for (const role of ['anon', 'authenticated'])
        for (const name of [
          'read_direct_credentials(uuid)',
          'read_oauth_flow(text)',
          'commit_direct_connection(text,text,bigint,jsonb,text)',
          'forget_direct_credentials(uuid,bigint)',
          'write_direct_credentials(uuid,text,bigint)',
        ])
          expect(
            (
              await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [
                role,
                'public.' + name,
              ])
            ).rows[0].ok
          ).toBe(false);
    } finally {
      await db.close();
    }
  });
  it('binds expiring single-use OAuth flows, saves tokens atomically and cancels stale leases on disconnect', async () => {
    const db = await createTestDatabase(true, 4);
    try {
      const d = populatedDocument();
      d.accounts[0].provider = 'direct';
      d.accounts[0].platform = 'youtube';
      d.accounts[0].status = 'registered';
      d.accounts[0].integration = { payoutsBlocked: true };
      d.posts = [];
      d.snapshots = [];
      d.statements = [];
      d.adjustments = [];
      const revision = async () =>
        Number(
          (await db.query<{ r: number }>("select (public.read_dashboard()->>'revision')::int r"))
            .rows[0].r
        );
      await db.query('select public.commit_dashboard($1,$2::jsonb)', [
        await revision(),
        JSON.stringify(d),
      ]);
      const id = d.accounts[0].id;
      await db.query('select public.create_oauth_invite($1,$2,$3)', ['invite', id, 'youtube']);
      await db.query('select public.start_oauth_flow($1,$2,$3,$4)', [
        'invite',
        'state',
        'browser',
        'encrypted-verifier',
      ]);
      expect(
        (await db.query<{ f: unknown }>('select public.read_oauth_flow($1) f', ['state'])).rows[0].f
      ).toBeTruthy();
      d.accounts[0].status = 'connected';
      d.accounts[0].provider_account_id = 'channel';
      await expect(
        db.query('select public.commit_direct_connection($1,$2,$3,$4::jsonb,$5)', [
          'state',
          'wrong',
          await revision(),
          JSON.stringify(d),
          'ciphertext',
        ])
      ).rejects.toThrow('invalid');
      await db.query('select public.commit_direct_connection($1,$2,$3,$4::jsonb,$5)', [
        'state',
        'browser',
        await revision(),
        JSON.stringify(d),
        'ciphertext',
      ]);
      expect(
        (await db.query<{ f: unknown }>('select public.read_oauth_flow($1) f', ['state'])).rows[0].f
      ).toBeNull();
      expect(JSON.stringify((await db.query('select public.read_dashboard()')).rows)).not.toContain(
        'ciphertext'
      );
      expect(
        (
          await db.query<{ ok: boolean }>('select public.write_direct_credentials($1,$2,$3) ok', [
            id,
            'rotated',
            1,
          ])
        ).rows[0].ok
      ).toBe(true);
      expect(
        (
          await db.query<{ ok: boolean }>('select public.write_direct_credentials($1,$2,$3) ok', [
            id,
            'stale',
            1,
          ])
        ).rows[0].ok
      ).toBe(false);
      await db.query('select public.forget_direct_credentials($1,$2)', [id, 1]);
      expect(
        (await db.query<{ c: unknown }>('select public.read_direct_credentials($1) c', [id]))
          .rows[0].c
      ).toBeTruthy();
      const job = (
        await db.query<{ j: { id: string; lease_token: string } }>(
          'select public.lease_tracking_job() j'
        )
      ).rows[0].j;
      expect(job).toBeTruthy();
      d.accounts[0].status = 'disconnected';
      await db.query('select public.disconnect_direct_account($1,$2,$3::jsonb)', [
        id,
        await revision(),
        JSON.stringify(d),
      ]);
      expect(
        (await db.query<{ c: unknown }>('select public.read_direct_credentials($1) c', [id]))
          .rows[0].c
      ).toBeNull();
      expect(
        (
          await db.query<{ ok: boolean }>('select public.finish_tracking_job($1,true,null,$2) ok', [
            job.id,
            job.lease_token,
          ])
        ).rows[0].ok
      ).toBe(false);
    } finally {
      await db.close();
    }
  });
});
