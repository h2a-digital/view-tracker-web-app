import { beforeEach, it, expect, vi } from 'vitest';
import { paginationFixture } from './helpers/pagination';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), load: vi.fn(), page: vi.fn() }));
vi.mock('@/lib/server/supabase', () => ({ requireAdmin: mocks.admin }));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('@/repositories/post-pages', () => ({ readPostPage: mocks.page }));
import { GET as posts } from '@/app/api/posts/route';
import { GET as groups } from '@/app/api/review-groups/route';
let data: ReturnType<typeof paginationFixture>;
beforeEach(() => {
  vi.resetAllMocks();
  data = paginationFixture(true);
  mocks.load.mockResolvedValue({ data });
  mocks.page.mockResolvedValue({ posts: [], snapshots: [], page: 1, pageSize: 24, total: 54 });
});
it('requires administrator access before reading pages or review groups', async () => {
  mocks.admin.mockRejectedValue(new Error('UNAUTHORIZED'));
  expect((await posts(new Request('https://hub.example/api/posts'))).status).toBe(401);
  expect((await groups(new Request('https://hub.example/api/review-groups'))).status).toBe(401);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.page).not.toHaveBeenCalled();
});
it('validates page size and forwards full filtering/sorting to the repository', async () => {
  expect((await posts(new Request('https://hub.example/api/posts?pageSize=100'))).status).toBe(400);
  expect(mocks.page).not.toHaveBeenCalled();
  const response = await posts(
    new Request(
      `https://hub.example/api/posts?page=2&pageSize=12&campaign=${data.campaigns[0].id}&search=Video&sort=views`
    )
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.page).toHaveBeenCalledWith(
    expect.objectContaining({
      page: 2,
      pageSize: 12,
      search: 'Video',
      sort: 'views',
      campaign: data.campaigns[0].id,
    })
  );
});
it('returns issue summaries without individual posts and paginates expanded lists', async () => {
  const summary = await (await groups(new Request('https://hub.example/api/review-groups'))).json();
  expect(summary).not.toHaveProperty('posts');
  expect(summary.groups.find((g: { cause: string }) => g.cause === 'mapping').count).toBe(49);
  const account = data.accounts.find((a) => a.platform === 'instagram')!;
  const base = `https://hub.example/api/review-groups?accountId=${account.id}&cause=mapping`;
  const first = await (await groups(new Request(base))).json(),
    second = await (await groups(new Request(base + '&page=2'))).json();
  expect(first.total).toBe(49);
  expect(first.posts).toHaveLength(12);
  expect(second.posts).toHaveLength(12);
  expect(new Set([...first.posts, ...second.posts].map((p) => p.id)).size).toBe(24);
  expect(first.posts[0]).not.toHaveProperty('tracking');
  const selection = await (await groups(new Request(base + '&action=selection'))).json();
  expect(selection.ids).toHaveLength(49);
  expect(data.posts.every((p) => p.eligibility_status !== 'excluded')).toBe(true);
});

it('keeps historical unmapped records out of mapping alerts while supporting paginated historical inspection', async () => {
  data = paginationFixture();
  mocks.load.mockResolvedValue({ data });
  const account = data.accounts.find((a) => a.platform === 'instagram')!;
  const summary = await (await groups(new Request('https://hub.example/api/review-groups'))).json();
  expect(
    summary.groups.find((group: { accountId: string }) => group.accountId === account.id)
  ).toMatchObject({ cause: 'historical', count: 49 });
  const response = await (
    await groups(
      new Request(`https://hub.example/api/review-groups?accountId=${account.id}&cause=historical`)
    )
  ).json();
  expect(response.total).toBe(49);
  expect(response.posts).toHaveLength(12);
  expect(
    data.posts.filter((post) => !post.campaign_id).every((post) => post.eligible_views === null)
  ).toBe(true);
});
