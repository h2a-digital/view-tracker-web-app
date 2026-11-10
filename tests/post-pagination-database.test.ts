import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database';
import { paginationFixture } from './helpers/pagination';
import { paginatePosts, postPageSchema, type PostPage } from '@/domain/post-pages';
let db: PGlite;
const data = paginationFixture();
beforeAll(async () => {
  db = await createTestDatabase(true, 5);
  await db.query(
    "select public.commit_dashboard((public.read_dashboard()->>'revision')::bigint,$1::jsonb)",
    [JSON.stringify(data)]
  );
  const before = (await db.query('select public.read_dashboard()')).rows;
  await db.exec(readFileSync('supabase/migrations/202611100002_post_pagination.sql', 'utf8'));
  expect((await db.query('select public.read_dashboard()')).rows).toEqual(before);
}, 30000);
afterAll(async () => {
  await db?.close();
});
it('queries actual PostgreSQL pages, filters, totals and stable sorting, matching preview semantics', async () => {
  for (const input of [
    { page: 1 },
    { page: 2 },
    { page: 3 },
    { page: 999 },
    { pageSize: 12 },
    { pageSize: 48 },
    { campaign: data.campaigns[0].id },
    { app: data.apps[0].id },
    { search: 'Video 00' },
    { search: 'First creator' },
    { search: '%' },
    { sort: 'oldest' },
    { sort: 'views' },
    { postId: data.posts[0].id },
  ]) {
    const q = postPageSchema.parse(input),
      expected = paginatePosts(data, q);
    const actual = (
      await db.query<{ page: PostPage }>(
        'select public.read_post_page($1,$2,$3,$4,$5,$6,$7) page',
        [
          q.page,
          q.pageSize,
          q.app === 'all' ? null : q.app,
          q.campaign === 'all' ? null : q.campaign,
          q.search,
          q.sort,
          q.postId ?? null,
        ]
      )
    ).rows[0].page;
    expect(
      {
        page: actual.page,
        total: actual.total,
        pageSize: actual.pageSize,
        ids: actual.posts.map((p) => p.id),
      },
      JSON.stringify(input)
    ).toEqual({
      page: expected.page,
      total: expected.total,
      pageSize: expected.pageSize,
      ids: expected.posts.map((p) => p.id),
    });
    expect(actual.snapshots.every((s) => actual.posts.some((p) => p.id === s.post_id))).toBe(true);
  }
});
it('keeps pagination service-only even with Supabase default grants', async () => {
  const rows = (
    await db.query<{ role: string; allowed: boolean }>(
      "select r role,has_function_privilege(r,'public.read_post_page(integer,integer,uuid,uuid,text,text,uuid)','execute') allowed from unnest(array['anon','authenticated','service_role']) r"
    )
  ).rows;
  expect(rows).toEqual([
    { role: 'anon', allowed: false },
    { role: 'authenticated', allowed: false },
    { role: 'service_role', allowed: true },
  ]);
  await expect(db.query('select public.read_post_page(1,1000)')).rejects.toThrow(
    /Invalid pagination/
  );
});

it('sorts by latest public observations, ignoring paid and supporting counters', async () => {
  await db.exec('begin');
  try {
    const post = data.posts[0];
    let counter = 0;
    for (const [metric, provenance] of [
      ['paid_views', null],
      ['public_views', { kind: 'daily' }],
      ['public_views', { supporting: true }],
    ] as const)
      await db.query(
        "insert into public.snapshots(id,post_id,views,metric,source,observed_at,provider_updated_at,evidence,quality,provider,provenance) values($1,$2,999999,$3,'api',$5,null,null,'reported','zernio',$4::jsonb)",
        [
          crypto.randomUUID(),
          post.id,
          metric,
          JSON.stringify(provenance),
          `2026-11-${11 + counter++}T12:00:00Z`,
        ]
      );
    const page = (
      await db.query<{ page: PostPage }>(
        "select public.read_post_page(1,24,null,null,'','views') page"
      )
    ).rows[0].page;
    expect(page.posts[0].caption).toBe('Video 53');
    await db.query(
      "update public.accounts set integration=jsonb_build_object('payoutsBlocked',true) where platform='tiktok'"
    );
    const blocked = (
      await db.query<{ page: PostPage }>(
        "select public.read_post_page(1,24,null,null,'','views') page"
      )
    ).rows[0].page;
    expect(blocked.posts[0].caption).toBe('Video 48');
  } finally {
    await db.exec('rollback');
  }
});
