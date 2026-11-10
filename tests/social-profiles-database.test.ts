import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database';
let db: PGlite;
const creator = 'b1000000-0000-4000-8000-000000000001',
  account = 'b2000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTestDatabase(true, 5);
  for (const file of [
    '202611090001_dashboard_management.sql',
    '202611090002_youtube_channel_metadata.sql',
    '202611090003_social_profiles.sql',
  ])
    await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
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
    "insert into public.accounts(id,creator_id,platform,username,ownership,provider,provider_account_id,provider_profile_id,status) values($1,$2,'tiktok','creator','creator','zernio','remote','profile','connected')",
    [account, creator]
  );
});
afterEach(async () => {
  await db.exec('rollback');
});
async function lease() {
  return (
    await db.query<{ job: { lease_token: string; account: { id: string } } | null }>(
      'select public.lease_profile_metadata($1,true) job',
      [account]
    )
  ).rows[0].job;
}
async function finish(token: string, profile: unknown) {
  return (
    await db.query<{ saved: boolean }>(
      "select public.finish_profile_metadata($1,$2,'creator','remote','zernio',$3) saved",
      [account, token, profile === null ? null : JSON.stringify(profile)]
    )
  ).rows[0].saved;
}
it('leases existing accounts without metadata once and schedules successful profiles 24 hours later', async () => {
  const job = await lease();
  expect(job?.account.id).toBe(account);
  expect(await lease()).toBeNull();
  expect(
    await finish(job!.lease_token, {
      name: 'Creator',
      avatarUrl: 'https://p16.tiktokcdn.com/avatar',
      refreshedAt: new Date().toISOString(),
    })
  ).toBe(true);
  expect(await lease()).toBeNull();
  const row = (
    await db.query<{ hours: number }>(
      'select extract(epoch from (next_due_at-now()))/3600 hours from private.profile_metadata_jobs where account_id=$1',
      [account]
    )
  ).rows[0];
  expect(Number(row.hours)).toBe(24);
});
it('retains cached avatars and uses one-hour backoff after a temporary failure', async () => {
  const profile = {
    avatarUrl: 'https://p16.tiktokcdn.com/valid',
    refreshedAt: new Date().toISOString(),
  };
  await db.query('update public.accounts set integration=$2 where id=$1', [
    account,
    JSON.stringify({ profileMetadata: profile }),
  ]);
  const job = await lease();
  await finish(job!.lease_token, null);
  const cached = (
    await db.query<{ integration: { profileMetadata: unknown } }>(
      'select integration from public.accounts where id=$1',
      [account]
    )
  ).rows[0].integration.profileMetadata;
  expect(cached).toEqual(profile);
  expect(
    Number(
      (
        await db.query<{ hours: number }>(
          'select extract(epoch from(next_due_at-now()))/3600 hours from private.profile_metadata_jobs where account_id=$1',
          [account]
        )
      ).rows[0].hours
    )
  ).toBe(1);
});
it('never restores metadata after source deletion or accepts a lost lease', async () => {
  const job = await lease();
  expect(await finish('00000000-0000-4000-8000-000000000000', null)).toBe(false);
  await db.query(
    'update public.accounts set integration=\'{"sourceErasedAt":"2026-11-01"}\' where id=$1',
    [account]
  );
  expect(
    await finish(job!.lease_token, {
      name: 'Do not restore',
      refreshedAt: new Date().toISOString(),
    })
  ).toBe(false);
  expect(
    (
      await db.query<{ profile: unknown }>(
        "select integration->'profileMetadata' profile from public.accounts where id=$1",
        [account]
      )
    ).rows[0].profile
  ).toBeNull();
});
it('expires only profile metadata and preserves TikTok connection and history', async () => {
  await db.query('update public.accounts set integration=$2 where id=$1', [
    account,
    JSON.stringify({
      profileMetadata: {
        name: 'Old',
        refreshedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      },
      payoutsBlocked: false,
    }),
  ]);
  await db.exec('select public.sweep_provider_retention()');
  const row = (
    await db.query<{
      status: string;
      provider_account_id: string;
      integration: Record<string, unknown>;
    }>('select * from public.accounts where id=$1', [account])
  ).rows[0];
  expect(row.status).toBe('connected');
  expect(row.provider_account_id).toBe('remote');
  expect(row.integration.profileMetadata).toBeUndefined();
  expect(row.integration.payoutsBlocked).toBe(false);
});
it('does not refresh paused Instagram/Zernio accounts and keeps RPCs service-only', async () => {
  await db.query("update public.accounts set platform='instagram' where id=$1", [account]);
  expect(
    (
      await db.query<{ job: unknown }>('select public.lease_profile_metadata($1,false) job', [
        account,
      ])
    ).rows[0].job
  ).toBeNull();
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.lease_profile_metadata(uuid,boolean)','execute') allowed"
      )
    ).rows[0].allowed
  ).toBe(false);
});
