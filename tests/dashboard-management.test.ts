import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
let db: PGlite;
const creator = 'a1000000-0000-4000-8000-000000000001',
  account = 'a2000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTestDatabase(true, 5);
  await db.exec(readFileSync('supabase/migrations/202611090001_dashboard_management.sql', 'utf8'));
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec('begin');
  await db.query('insert into public.creators(id,name,email,notes) values($1,$2,$3,$4)', [
    creator,
    'Test creator',
    '',
    '',
  ]);
  await db.query(
    "insert into public.accounts(id,creator_id,platform,username,ownership,provider,status) values($1,$2,'youtube','UC_TEST','creator','manual','registered')",
    [account, creator]
  );
});
afterEach(async () => {
  await db.exec('rollback');
});
async function manage(entity: string, id: string, operation: string) {
  await db.query(
    "select public.manage_dashboard_record((public.read_dashboard()->>'revision')::bigint,$1,$2,$3)",
    [entity, id, operation]
  );
}
it('deletes an unused account and releases local reservations/jobs', async () => {
  await db.query('insert into private.jobs(account_id) values($1)', [account]);
  await manage('account', account, 'remove');
  expect(
    (await db.query('select id from public.accounts where id=$1', [account])).rows
  ).toHaveLength(0);
  expect(
    (await db.query('select id from private.jobs where account_id=$1', [account])).rows
  ).toHaveLength(0);
});
it('blocks removal and archival of connected accounts', async () => {
  await db.query(
    "update public.accounts set status='connected',provider_account_id='remote' where id=$1",
    [account]
  );
  await expect(manage('account', account, 'remove')).rejects.toThrow(/Disconnect/);
});
it('retains financial history and archives populated creators after disconnection', async () => {
  const d = populatedDocument();
  await db.query(
    "select public.commit_dashboard((public.read_dashboard()->>'revision')::bigint,$1::jsonb)",
    [JSON.stringify(d)]
  );
  const c = d.creators[0].id;
  const financialBefore = (
    await db.query('select * from public.statements where creator_id=$1', [c])
  ).rows;
  const postsBefore = (await db.query('select * from public.posts where creator_id=$1', [c])).rows;
  await db.exec('savepoint deletion_attempt');
  await expect(manage('creator', c, 'remove')).rejects.toThrow(/Historical/);
  await db.exec('rollback to savepoint deletion_attempt');
  await manage('creator', c, 'archive');
  expect(
    (await db.query<{ archived: boolean }>('select archived from public.creators where id=$1', [c]))
      .rows[0].archived
  ).toBe(true);
  expect((await db.query('select * from public.statements where creator_id=$1', [c])).rows).toEqual(
    financialBefore
  );
  expect((await db.query('select * from public.posts where creator_id=$1', [c])).rows).toEqual(
    postsBefore
  );
  expect((await db.query('select id from public.posts where creator_id=$1', [c])).rows.length).toBe(
    d.posts.length
  );
});
it('preserves archival when an older composite document omits the new column', async () => {
  await manage('account', account, 'archive');
  const result = await db.query<{ d: Record<string, unknown> }>('select public.read_dashboard() d');
  const wrapper = result.rows[0].d;
  const d = wrapper.data as Record<string, unknown>;
  for (const row of d.accounts as { archived?: boolean }[]) delete row.archived;
  await db.query('select public.commit_dashboard($1,$2::jsonb)', [
    wrapper.revision,
    JSON.stringify(d),
  ]);
  expect(
    (
      await db.query<{ archived: boolean }>('select archived from public.accounts where id=$1', [
        account,
      ])
    ).rows[0].archived
  ).toBe(true);
});
it('removes an unused app and its empty campaigns/rules without orphaning records', async () => {
  const id = 'a3000000-0000-4000-8000-000000000001';
  await db.query("insert into public.apps values($1,'Unused','unused','#abcdef',false)", [id]);
  await db.query(
    "insert into public.campaigns values('a4000000-0000-4000-8000-000000000001',$1,'Empty','active')",
    [id]
  );
  await manage('app', id, 'remove');
  expect(
    (await db.query('select id from public.campaigns where app_id=$1', [id])).rows
  ).toHaveLength(0);
});
it('restricts management and metadata writes to the service role', async () => {
  const r = await db.query<{ allowed: boolean }>(
    "select has_function_privilege('authenticated','public.manage_dashboard_record(bigint,text,uuid,text)','execute') allowed"
  );
  expect(r.rows[0].allowed).toBe(false);
});
it('writes YouTube metadata only to the expected immutable connected channel', async () => {
  await db.query(
    "update public.accounts set provider='direct',status='connected',provider_account_id='verified' where id=$1",
    [account]
  );
  await db.query('select public.store_channel_identity($1,\'wrong\',\'{"title":"Wrong"}\')', [
    account,
  ]);
  expect(
    (
      await db.query<{ integration: unknown }>(
        'select integration from public.accounts where id=$1',
        [account]
      )
    ).rows[0].integration
  ).toBeNull();
  await db.query('select public.store_channel_identity($1,\'verified\',\'{"title":"Atalaya"}\')', [
    account,
  ]);
  expect(
    (
      await db.query<{ title: string }>(
        "select integration->'channelIdentity'->>'title' title from public.accounts where id=$1",
        [account]
      )
    ).rows[0].title
  ).toBe('Atalaya');
});

it('returns the exact other Meta accounts sharing a grant, without exposing credentials', async () => {
  const other = 'a2000000-0000-4000-8000-000000000002';
  await db.query("update public.accounts set provider='direct',platform='instagram' where id=$1", [
    account,
  ]);
  await db.query(
    "insert into public.accounts(id,creator_id,platform,username,ownership,provider,status) values($1,$2,'facebook','PAGE_TEST','creator','direct','connected')",
    [other, creator]
  );
  await db.query(
    "insert into private.oauth_credentials(account_id,encrypted_token,subject_hash) values($1,'encrypted-never-return','shared'),($2,'another-secret','shared')",
    [account, other]
  );
  const result = await db.query<{ impact: { id: string }[] }>(
    'select public.get_disconnect_impact($1) impact',
    [account]
  );
  expect(result.rows[0].impact).toEqual([
    { id: other, platform: 'facebook', username: 'PAGE_TEST' },
  ]);
  expect(JSON.stringify(result.rows[0])).not.toContain('encrypted');
});
it('rejects stale management revisions without changing records', async () => {
  await expect(
    db.query("select public.manage_dashboard_record(-1,'account',$1,'remove')", [account])
  ).rejects.toThrow(/CONFLICT/);
});
