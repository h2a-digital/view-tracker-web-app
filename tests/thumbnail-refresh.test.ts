import { it, expect, vi, afterEach } from 'vitest';
import { loadMissingThumbnails } from '@/services/tracking/thumbnail-refresh';
import { withThumbnailOverrides, workspaceDisplayTime } from '@/domain/thumbnail-overrides';
import { thumbnailPersistenceAllowed } from '@/lib/server/thumbnail-policy';
import { usableThumbnail } from '@/domain/post-media';
import { populatedDocument } from './helpers/dashboard';
import type { TrackingProvider } from '@/services/tracking/provider';
const now = Date.parse('2026-11-10T12:00:00Z');
function fixture() {
  const d = populatedDocument();
  d.accounts[0].status = 'connected';
  d.accounts[0].provider_account_id = 'remote';
  return d;
}
const provider = (images: unknown[]): TrackingProvider => ({
  name: 'test',
  capabilities: () => ({
    discovery: true,
    publicViews: true,
    organicViews: false,
    platforms: ['tiktok'],
  }),
  discoverPosts: vi.fn(),
  fetchMetrics: vi.fn(),
  fetchThumbnails: vi.fn().mockResolvedValue(images),
});
afterEach(() => {
  vi.useRealTimers();
});
it('loads only missing metadata without touching views, eligibility, rules, attribution or financial history', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const data = fixture(),
    before = structuredClone(data),
    p = provider([
      {
        platformPostId: data.posts[0].platform_post_id,
        thumbnailUrl: 'https://media.zernio.com/cover.jpg',
        views: 999999,
      },
    ]);
  const result = await loadMissingThumbnails(data, data.accounts[0], p);
  expect(data).toEqual(before);
  expect(p.fetchMetrics).not.toHaveBeenCalled();
  expect(p.discoverPosts).not.toHaveBeenCalled();
  const next = withThumbnailOverrides(data, result.overrides, now);
  expect(next.posts[0].tracking?.thumbnail?.url).toBe('https://media.zernio.com/cover.jpg');
  for (const key of [
    'snapshots',
    'statements',
    'adjustments',
    'mappings',
    'memberships',
    'accounts',
    'ruleVersions',
  ] as const)
    expect(next[key]).toEqual(data[key]);
  expect(next.posts[0].eligible_views).toBe(data.posts[0].eligible_views);
  expect(next.posts[0].deadline).toBe(data.posts[0].deadline);
  expect(next.posts[0].campaign_id).toBe(data.posts[0].campaign_id);
  await loadMissingThumbnails(next, next.accounts[0], p);
  expect(p.fetchThumbnails).toHaveBeenCalledOnce();
});
it('does not count an expired cached URL as a retrieved preview when the provider has none', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const data = fixture();
  data.posts[0].tracking = {
    ...data.posts[0].tracking!,
    thumbnail: { url: 'https://media.zernio.com/expired.jpg', capturedAt: '2026-01-01T00:00:00Z' },
  };
  const result = await loadMissingThumbnails(data, data.accounts[0], provider([]));
  expect(result.overrides).toEqual([]);
  expect(result.unavailable).toBe(1);
});
it('keeps local overrides on refresh but rejects revoked, removed and changed provider identities', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const data = fixture();
  const { overrides } = await loadMissingThumbnails(
    data,
    data.accounts[0],
    provider([
      {
        platformPostId: data.posts[0].platform_post_id,
        thumbnailUrl: 'https://media.zernio.com/image.jpg',
      },
    ])
  );
  expect(
    withThumbnailOverrides(structuredClone(data), overrides, now).posts[0].tracking?.thumbnail
  ).toBeDefined();
  for (const mutation of [
    (d: typeof data) => (d.accounts[0].status = 'disconnected'),
    (d: typeof data) => (d.accounts[0].provider_account_id = 'changed'),
    (d: typeof data) => (d.posts[0].source_erased_at = '2026-11-10T12:00:00Z'),
  ]) {
    const d = structuredClone(data);
    mutation(d);
    expect(withThumbnailOverrides(d, overrides, now).posts[0].tracking?.thumbnail).toBeUndefined();
  }
});
it('advances the display clock for fetched previews rather than comparing them with page mount time', () => {
  const thumbnail = {
    url: 'https://media.zernio.com/image.jpg',
    capturedAt: new Date(now + 5000).toISOString(),
  };
  expect(usableThumbnail(thumbnail, now)).toBeUndefined();
  const display = workspaceDisplayTime(now, now + 1000, new Date(now + 6000).toISOString());
  expect(usableThumbnail(thumbnail, display)).toBe(thumbnail.url);
  expect(workspaceDisplayTime(display, now + 2000)).toBe(display);
});
it('never writes the shared Supabase project during localhost testing, including next start', () => {
  for (const NODE_ENV of ['development', 'production'])
    expect(
      thumbnailPersistenceAllowed({
        NODE_ENV,
        APP_URL: 'http://localhost:3000',
        NEXT_PUBLIC_SUPABASE_URL: 'https://shared.supabase.co',
      })
    ).toBe(false);
  expect(
    thumbnailPersistenceAllowed({
      APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    })
  ).toBe(true);
  expect(
    thumbnailPersistenceAllowed({ APP_URL: 'https://hub.example.com', CONTEXT: 'production' })
  ).toBe(true);
  expect(
    thumbnailPersistenceAllowed({
      APP_URL: 'https://branch.example.com',
      CONTEXT: 'deploy-preview',
    })
  ).toBe(false);
});
