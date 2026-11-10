import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
import { trackingState } from '@/domain/tracking';
let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabase(true, 5);
  for (const file of [
    '202611090001_dashboard_management.sql',
    '202611090002_youtube_channel_metadata.sql',
    '202611090003_social_profiles.sql',
  ])
    await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
  const before = (await db.query('select public.read_dashboard() data')).rows;
  await db.exec(readFileSync('supabase/migrations/202611100001_post_thumbnails.sql', 'utf8'));
  expect((await db.query('select public.read_dashboard() data')).rows).toEqual(before);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec('begin');
});
afterEach(async () => {
  await db.exec('rollback');
});
it('round-trips optional thumbnail JSON and expires only media cache on paid posts, preserving finance, mappings, snapshots and identities', async () => {
  const data = populatedDocument();
  const post = data.posts[0];
  post.tracking = {
    ...trackingState(data, post, new Date().toISOString()),
    thumbnail: {
      url: 'https://p16.tiktokcdn.com/real-image',
      capturedAt: new Date().toISOString(),
    },
  };
  await db.query(
    "select public.commit_dashboard((public.read_dashboard()->>'revision')::bigint,$1::jsonb)",
    [JSON.stringify(data)]
  );
  const before = (
    await db.query<{ data: { document: typeof data } }>('select public.read_dashboard() data')
  ).rows[0].data;
  expect(JSON.stringify(before)).toContain('real-image');
  const finances = (await db.query('select * from public.statements order by id')).rows;
  const accounts = (await db.query('select * from public.accounts order by id')).rows;
  const mappings = (await db.query('select * from public.mappings order by id')).rows;
  const snapshots = (await db.query('select * from public.snapshots order by id')).rows;
  await db.query(
    "update public.posts set tracking=jsonb_set(tracking,'{thumbnail,capturedAt}',to_jsonb((now()-interval '30 days')::text)) where id=$1",
    [post.id]
  );
  const result = (
    await db.query<{ result: { thumbnailsExpired: number } }>(
      'select public.sweep_provider_retention() result'
    )
  ).rows[0].result;
  expect(result.thumbnailsExpired).toBe(1);
  expect(
    (
      await db.query<{ tracking: Record<string, unknown> }>(
        'select tracking from public.posts where id=$1',
        [post.id]
      )
    ).rows[0].tracking
  ).not.toHaveProperty('thumbnail');
  expect((await db.query('select * from public.statements order by id')).rows).toEqual(finances);
  expect((await db.query('select * from public.accounts order by id')).rows).toEqual(accounts);
  expect((await db.query('select * from public.snapshots order by id')).rows).toEqual(snapshots);
  expect((await db.query('select * from public.mappings order by id')).rows).toEqual(mappings);
});
it('keeps retention functions service-only and private wrapper implementations inaccessible', async () => {
  const rows = (
    await db.query<{ role: string; allowed: boolean }>(
      "select r role,has_function_privilege(r,'public.sweep_provider_retention()','execute') allowed from unnest(array['anon','authenticated','service_role']) r"
    )
  ).rows;
  expect(rows).toEqual([
    { role: 'anon', allowed: false },
    { role: 'authenticated', allowed: false },
    { role: 'service_role', allowed: true },
  ]);
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select has_function_privilege('service_role','private.sweep_provider_retention_before_post_thumbnails()','execute') allowed"
      )
    ).rows[0].allowed
  ).toBe(false);
});
