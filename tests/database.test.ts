import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database';
import { seedData, runCommand } from '@/domain/commands';
let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});
describe('Supabase migration and persistence', () => {
  it('seeds Versel and returns the normalized dashboard document', async () => {
    const r = await db.query<{ value: { data: { apps: unknown[] }; revision: number } }>(
      'select public.read_dashboard() as value'
    );
    expect(r.rows[0].value.data.apps).toHaveLength(1);
    expect(r.rows[0].value.revision).toBe(0);
  });
  it('denies financial and job functions to anonymous and authenticated roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1,'public.commit_dashboard(bigint,jsonb)','execute') as allowed",
        [role]
      );
      expect(r.rows[0].allowed).toBe(false);
      const j = await db.query<{ allowed: boolean }>(
        "select has_function_privilege($1,'public.lease_tracking_job()','execute') as allowed",
        [role]
      );
      expect(j.rows[0].allowed).toBe(false);
    }
  });
  it('enables RLS for every public application table', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'"
    );
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    expect(r.rows.length).toBeGreaterThan(10);
  });
  it('commits a server-computed document and rejects stale revision writes', async () => {
    let data = seedData(new Date('2026-11-07'));
    data = runCommand(data, { type: 'createCreator', name: 'Database creator' });
    await db.query('select public.commit_dashboard($1,$2::jsonb)', [0, JSON.stringify(data)]);
    const r = await db.query<{ name: string }>('select name from public.creators');
    expect(r.rows[0].name).toBe('Database creator');
    await expect(
      db.query('select public.commit_dashboard($1,$2::jsonb)', [0, JSON.stringify(data)])
    ).rejects.toThrow(/CONFLICT/);
  });
  it('keeps append-only observations on repeated commits', async () => {
    const r = await db.query<{ value: { data: ReturnType<typeof seedData>; revision: number } }>(
      'select public.read_dashboard() as value'
    );
    const { data, revision } = r.rows[0].value;
    await db.query('select public.commit_dashboard($1,$2::jsonb)', [
      revision,
      JSON.stringify(data),
    ]);
    expect((await db.query('select * from public.creators')).rows).toHaveLength(1);
  });
  it('enforces finalized statement immutability in the database', async () => {
    const creator = (await db.query<{ id: string }>('select id from public.creators limit 1'))
      .rows[0].id;
    await db.query(
      `insert into public.statements(id,app_id,creator_id,month,policy,status,potential_bonus_cents,approved_bonus_cents,fingerprint,base_cents,payable_cents,capped_cents,lines,finalized_at) values('90000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',$1,'2026-10','{}','finalized',0,0,'locked',1000,1000,0,'[]',now())`,
      [creator]
    );
    await expect(
      db.exec("update public.statements set payable_cents=5000 where month='2026-10'")
    ).rejects.toThrow(/immutable/);
    await db.exec(
      "update public.statements set status='paid',payment_reference='bank-1',payment_amount_cents=1000,paid_at=now() where month='2026-10'"
    );
    await expect(
      db.exec("update public.statements set payment_reference='changed' where month='2026-10'")
    ).rejects.toThrow(/immutable/);
  });
});

it('rolls back connection ticket consumption on revision conflict', async () => {
  const creator = (await db.query<{ id: string }>('select id from public.creators limit 1')).rows[0]
    .id;
  const account = '80000000-0000-4000-8000-000000000001';
  await db.query(
    "insert into public.accounts(id,creator_id,platform,username,ownership,provider,status) values($1,$2,'tiktok','ticket-test','creator','zernio','registered')",
    [account, creator]
  );
  await db.query("select public.store_connection('test-hash',$1,'profile-1',0,false)", [account]);
  await expect(
    db.query("select public.commit_connection('test-hash',-1,'{}'::jsonb)")
  ).rejects.toThrow(/CONFLICT/);
  const row = await db.query<{ value: unknown }>(
    "select public.read_connection('test-hash') as value"
  );
  expect(row.rows[0].value).toBeTruthy();
});

it('deduplicates jobs, leases exclusively, and applies retry backoff', async () => {
  const account = '80000000-0000-4000-8000-000000000001';
  await db.query('select public.request_tracking($1)', [account]);
  await db.query('select public.request_tracking($1)', [account]);
  const count = await db.query<{ n: number }>(
    "select count(*)::integer as n from private.jobs where account_id=$1 and status in ('queued','running')",
    [account]
  );
  expect(count.rows[0].n).toBe(1);
  const job = (
    await db.query<{ value: { id: string; attempts: number } }>(
      'select public.lease_tracking_job() as value'
    )
  ).rows[0].value;
  expect(job.attempts).toBe(1);
  expect(
    (await db.query<{ value: unknown }>('select public.lease_tracking_job() as value')).rows[0]
      .value
  ).toBeNull();
  await db.query("select public.finish_tracking_job($1,false,'Temporary provider failure')", [
    job.id,
  ]);
  const retry = (
    await db.query<{ status: string; delayed: boolean }>(
      'select status,available_at>now() as delayed from private.jobs where id=$1',
      [job.id]
    )
  ).rows[0];
  expect(retry).toEqual({ status: 'queued', delayed: true });
  await db.query("update private.jobs set available_at=now()-interval '1 second' where id=$1", [
    job.id,
  ]);
  expect(
    (await db.query<{ value: { attempts: number } }>('select public.lease_tracking_job() as value'))
      .rows[0].value.attempts
  ).toBe(2);
  await db.query('select public.finish_tracking_job($1,true)', [job.id]);
});
it('reserves pending free slots across simultaneous connection links', async () => {
  const creator = (await db.query<{ id: string }>('select id from public.creators limit 1')).rows[0]
    .id;
  const second = '80000000-0000-4000-8000-000000000002';
  await db.query(
    "insert into public.accounts(id,creator_id,platform,username,ownership,provider,status) values($1,$2,'tiktok','second-ticket-test','creator','zernio','registered')",
    [second, creator]
  );
  await expect(
    db.query("select public.store_connection('second-hash',$1,'profile-2',1,false)", [second])
  ).rejects.toThrow(/pending/);
  // Reissuing the same account's link invalidates its predecessor without adding a slot.
  await db.query(
    "select public.store_connection('replacement-hash','80000000-0000-4000-8000-000000000001','profile-1',0,false)"
  );
  expect(
    (await db.query<{ value: unknown }>("select public.read_connection('test-hash') as value"))
      .rows[0].value
  ).toBeNull();
});
