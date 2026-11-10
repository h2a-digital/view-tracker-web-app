import { it, expect, vi, afterEach } from 'vitest';
import { ZernioProvider } from '@/services/tracking/zernio';
import { synchronizeAccount } from '@/services/tracking/sync';
import { populatedDocument } from './helpers/dashboard';
import type { TrackingProvider } from '@/services/tracking/provider';
const native = '123456789',
  account = 'remote';
const response = (posts: unknown[], pages = 1) =>
  new Response(JSON.stringify({ posts, pagination: { page: 1, pages } }), { status: 200 });
const row = (id = native, accountId = account) => ({
  publishedAt: '2026-10-12T12:00:00Z',
  platform: 'tiktok',
  mediaType: 'video',
  thumbnailUrl: 'https://media.zernio.com/real-cover.jpg',
  platforms: [
    {
      platform: 'tiktok',
      accountId,
      platformPostId: id,
      platformPostUrl: `https://www.tiktok.com/@creator/video/${id}`,
    },
  ],
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('backfills known native IDs from one bounded read-only analytics request without importing unrelated rows', async () => {
  vi.stubEnv('ZERNIO_API_KEY', 'test');
  const fetch = vi
    .fn()
    .mockResolvedValue(response([row(), row('987654321'), row(native, 'another-account')]));
  vi.stubGlobal('fetch', fetch);
  const result = await new ZernioProvider().fetchThumbnails(account, [
    { platformPostId: native, publishedAt: '2026-10-12T12:00:00Z', deadline: null },
  ]);
  expect(result).toEqual([
    { platformPostId: native, thumbnailUrl: 'https://media.zernio.com/real-cover.jpg' },
  ]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toContain('/analytics?');
  expect(fetch.mock.calls[0][0]).toContain('accountId=remote');
  expect(fetch.mock.calls[0][0]).toContain('toDate=2026-10-12');
  expect(fetch.mock.calls[0][1].method).not.toBe('POST');
});
it('reuses already fetched empty thumbnail fields instead of asking the provider again', async () => {
  vi.stubEnv('ZERNIO_API_KEY', 'test');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ posts: [] })))
    .mockResolvedValueOnce(response([{ ...row(), thumbnailUrl: null }]));
  vi.stubGlobal('fetch', fetch);
  const provider = new ZernioProvider();
  await provider.discoverPosts(account, '2026-10-01');
  const images = await provider.fetchThumbnails(account, [
    { platformPostId: native, publishedAt: '2026-10-12T12:00:00Z', deadline: null },
  ]);
  expect(images?.[0].thumbnailUrl).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('preserves approved money, snapshots and valid caches while automatically backfilling historical media', async () => {
  const d = populatedDocument();
  d.accounts[0].status = 'connected';
  d.accounts[0].provider_account_id = account;
  const thumbnails = vi.fn().mockResolvedValue([
    {
      platformPostId: native,
      thumbnailUrl: 'https://media.zernio.com/real-cover.jpg',
      views: 99999999,
    },
  ]);
  const provider: TrackingProvider = {
    name: 'test',
    capabilities: () => ({
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['tiktok'],
    }),
    discoverPosts: async () => [],
    fetchMetrics: async () => [],
    fetchThumbnails: thumbnails,
  };
  const next = await synchronizeAccount(d, d.accounts[0].id, provider);
  expect(next.posts[0].tracking?.thumbnail?.url).toBe('https://media.zernio.com/real-cover.jpg');
  expect(next.statements).toEqual(d.statements);
  expect(next.snapshots).toEqual(d.snapshots);
  expect(next.posts[0].eligible_views).toBe(d.posts[0].eligible_views);
  const repeated = await synchronizeAccount(next, d.accounts[0].id, provider);
  expect(thumbnails).toHaveBeenCalledOnce();
  expect(repeated.posts[0].tracking?.thumbnail).toEqual(next.posts[0].tracking?.thumbnail);
});
it('waits 24 hours before retrying missing previews and never requests erased source media', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  const d = populatedDocument();
  d.accounts[0].status = 'connected';
  d.accounts[0].provider_account_id = account;
  const thumbnails = vi.fn().mockResolvedValue([]);
  const provider: TrackingProvider = {
    name: 'test',
    capabilities: () => ({
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['tiktok'],
    }),
    discoverPosts: async () => [],
    fetchMetrics: async () => [],
    fetchThumbnails: thumbnails,
  };
  let next = await synchronizeAccount(d, d.accounts[0].id, provider);
  next = await synchronizeAccount(next, d.accounts[0].id, provider);
  expect(thumbnails).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date('2026-11-11T12:01:00Z'));
  next = await synchronizeAccount(next, d.accounts[0].id, provider);
  expect(thumbnails).toHaveBeenCalledTimes(2);
  next.posts[0].source_erased_at = new Date().toISOString();
  await synchronizeAccount(next, d.accounts[0].id, provider);
  expect(thumbnails).toHaveBeenCalledTimes(2);
});

it('recognizes Instagram Reels from the matched native entry URL without broadening its media filter', async () => {
  vi.stubEnv('ZERNIO_API_KEY', 'test');
  vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'true');
  const fetch = vi
    .fn()
    .mockResolvedValue(
      response([
        {
          ...row(),
          platform: 'instagram',
          platformPostUrl: undefined,
          mediaProductType: null,
          platforms: [
            {
              platform: 'instagram',
              accountId: account,
              platformPostId: native,
              platformPostUrl: 'https://www.instagram.com/reel/native/',
            },
          ],
        },
      ])
    );
  vi.stubGlobal('fetch', fetch);
  expect(
    (
      await new ZernioProvider(Date.now() + 45000, 'instagram').fetchThumbnails(account, [
        { platformPostId: native, publishedAt: '2026-10-12T12:00:00Z', deadline: null },
      ])
    )?.[0].thumbnailUrl
  ).toContain('media.zernio.com');
});
it('keeps optional preview failures from failing otherwise successful tracking', async () => {
  const data = populatedDocument();
  data.accounts[0].status = 'connected';
  data.accounts[0].provider_account_id = account;
  const provider: TrackingProvider = {
    name: 'test',
    capabilities: () => ({
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['tiktok'],
    }),
    discoverPosts: async () => [],
    fetchMetrics: async () => [],
    fetchThumbnails: async () => {
      throw new Error('Temporary optional media failure');
    },
  };
  const next = await synchronizeAccount(data, data.accounts[0].id, provider);
  expect(next.syncRuns[0].diagnostics?.skipped.thumbnail_backfill_failed).toBe(1);
  expect(next.syncRuns[0].diagnostics?.errors).toEqual([]);
  expect(next.statements).toEqual(data.statements);
  expect(next.snapshots).toEqual(data.snapshots);
});
