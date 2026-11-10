import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from './helpers/database';
let db: PGlite;
const creator = 'b1000000-0000-4000-8000-000000000001',
  account = 'b2000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTestDatabase(true, 5);
  for (const name of [
    '202611090001_dashboard_management.sql',
    '202611090002_youtube_channel_metadata.sql',
  ])
    await db.exec(readFileSync(`supabase/migrations/${name}`, 'utf8'));
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.creators(id,name,email,notes) values($1,'Creator','','')", [
    creator,
  ]);
  await db.query(
    "insert into public.accounts(id,creator_id,platform,username,ownership,provider,status,integration) values($1,$2,'youtube','UC_TEST','creator','direct','registered','{\"payoutsBlocked\":true}')",
    [account, creator]
  );
});
afterEach(async () => {
  await db.exec('rollback');
});
it('persists public metadata for unconnected accounts without changing authorization or policy flags', async () => {
  const result = await db.query<{ saved: boolean }>(
    "select public.cache_youtube_channel_identity($1,'UC_TEST',null,$2,'updated') saved",
    [
      account,
      JSON.stringify({
        title: 'Atalaya',
        handle: '@atalaya',
        refreshedAt: new Date().toISOString(),
      }),
    ]
  );
  expect(result.rows[0].saved).toBe(true);
  const row = (
    await db.query<{
      status: string;
      provider_account_id: string | null;
      integration: { payoutsBlocked: boolean; channelIdentity: { title: string } };
    }>('select * from public.accounts where id=$1', [account])
  ).rows[0];
  expect(row.status).toBe('registered');
  expect(row.provider_account_id).toBeNull();
  expect(row.integration.payoutsBlocked).toBe(true);
  expect(row.integration.channelIdentity.title).toBe('Atalaya');
});
it('rejects stale identity bindings and erased sources', async () => {
  expect(
    (
      await db.query<{ saved: boolean }>(
        "select public.cache_youtube_channel_identity($1,'wrong',null,null,'not_found') saved",
        [account]
      )
    ).rows[0].saved
  ).toBe(false);
  await db.query(
    'update public.accounts set integration=\'{"sourceErasedAt":"2026-11-01"}\' where id=$1',
    [account]
  );
  expect(
    (
      await db.query<{ saved: boolean }>(
        "select public.cache_youtube_channel_identity($1,'UC_TEST',null,null,'not_found') saved",
        [account]
      )
    ).rows[0].saved
  ).toBe(false);
});
it('expires public-only metadata without deleting the registration or changing source retention', async () => {
  await db.query('update public.accounts set integration=$2 where id=$1', [
    account,
    JSON.stringify({
      channelIdentity: {
        title: 'Expired',
        refreshedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      },
      channelIdentityLookup: {
        status: 'updated',
        checkedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      },
    }),
  ]);
  await db.exec('select public.sweep_provider_retention()');
  const row = (
    await db.query<{ username: string; integration: Record<string, unknown> }>(
      'select username,integration from public.accounts where id=$1',
      [account]
    )
  ).rows[0];
  expect(row.username).toBe('UC_TEST');
  expect(row.integration.channelIdentity).toBeUndefined();
  expect(row.integration.channelIdentityLookup).toBeUndefined();
});
it('keeps metadata persistence service-only', async () => {
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.cache_youtube_channel_identity(uuid,text,text,jsonb,text)','execute') allowed"
      )
    ).rows[0].allowed
  ).toBe(false);
});
