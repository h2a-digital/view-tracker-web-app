import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const token = vi.hoisted(() => ({ get: vi.fn(), revoke: vi.fn() }));
vi.mock('@/services/oauth/tokens', () => ({
  AccountToken: class {
    get = token.get;
    revoke = token.revoke;
  },
}));
import { YouTubeProvider } from '@/services/tracking/direct/youtube';
import { MetaProvider } from '@/services/tracking/direct/meta';
import { durationSeconds, pacificDayBounds, safeCounter } from '@/services/tracking/direct/base';
import { providerJson, ProviderError } from '@/services/oauth/http';
import type { SocialAccount } from '@/domain/model';
const account = (platform: SocialAccount['platform']): SocialAccount => ({
  id: 'account',
  creator_id: 'creator',
  platform,
  username: 'creator',
  provider: 'direct',
  ownership: 'creator',
  provider_account_id: 'remote',
  provider_profile_id: null,
  status: 'connected',
  last_synced_at: null,
  error: null,
});
const target = {
  platformPostId: 'video1',
  publishedAt: '2026-11-01T12:00:00.000Z',
  deadline: '2026-11-08T12:00:00.000Z',
};
const video = {
  id: 'video1',
  snippet: {
    channelId: 'remote',
    title: 'Native Short',
    publishedAt: target.publishedAt,
    liveBroadcastContent: 'none',
  },
  contentDetails: { duration: 'PT2M' },
  statistics: { viewCount: '1234' },
  status: { privacyStatus: 'public' },
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  token.get.mockResolvedValue('token');
  token.revoke.mockResolvedValue(undefined);
  for (const [key, value] of Object.entries({
    META_APP_ID: 'meta',
    META_APP_SECRET: 'secret',
    META_GRAPH_VERSION: 'v26.0',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('direct providers', () => {
  it('discovers native YouTube uploads and filters private/live/long videos without asserting duration proves Shorts', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          items: [{ id: 'remote', contentDetails: { relatedPlaylists: { uploads: 'uploads' } } }],
        })
      )
      .mockResolvedValueOnce(
        json({
          items: [{ contentDetails: { videoId: 'video1', videoPublishedAt: target.publishedAt } }],
        })
      )
      .mockResolvedValueOnce(
        json({
          items: [
            video,
            { ...video, id: 'long', contentDetails: { duration: 'PT10M' } },
            { ...video, id: 'private', status: { privacyStatus: 'private' } },
            { ...video, id: 'live', snippet: { ...video.snippet, liveBroadcastContent: 'live' } },
          ],
        })
      );
    vi.stubGlobal('fetch', fetch);
    const posts = await new YouTubeProvider(account('youtube')).discoverPosts(
      'remote',
      '2026-11-01'
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ platformPostId: 'video1', contentType: 'shorts_candidate' });
    expect(fetch.mock.calls[1][0]).toContain('playlistItems');
  });
  it('separates public cumulative counters, daily non-advertising evidence and paid traffic, with no fabricated freshness', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [video] }))
        .mockResolvedValueOnce(
          json({
            columnHeaders: ['day', 'insightTrafficSourceType', 'creatorContentType', 'views'].map(
              (name) => ({ name })
            ),
            rows: [
              ['2026-11-03', 'SHORTS', 'SHORTS', 900],
              ['2026-11-03', 'YT_SEARCH', 'SHORTS', 100],
              ['2026-11-03', 'ADVERTISING', 'SHORTS', 200],
            ],
          })
        )
    );
    const provider = new YouTubeProvider(account('youtube'));
    const result = await provider.fetchMetrics('remote', '2026-11-01', [target]);
    expect(result.map((r) => r.metric)).toEqual(['public_views', 'organic_views', 'paid_views']);
    expect(result.map((r) => r.views)).toEqual([1234, 1000, 200]);
    expect(result.every((r) => r.providerUpdatedAt === null && !r.organicVerified)).toBe(true);
    expect(result[1].provenance).toMatchObject({
      kind: 'daily',
      contentType: 'shorts',
      timezone: 'America/Los_Angeles',
    });
    expect(provider.accountPatch().payoutsBlocked).toBe(true);
  });
  it('retains public counters if the Analytics endpoint is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [video] }))
        .mockResolvedValueOnce(json({ error: { code: 503 } }, 503))
    );
    const provider = new YouTubeProvider(account('youtube'));
    const result = await provider.fetchMetrics('remote', undefined, [target]);
    expect(result[0].views).toBe(1234);
    expect(provider.diagnosticErrors()).toHaveLength(1);
    expect(provider.accountPatch().lastAnalyticsAt).toBeUndefined();
  });
  it('paginates daily reports and bounds queries by Pacific publication/cutoff dates', async () => {
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const headers = ['day', 'insightTrafficSourceType', 'creatorContentType', 'views'].map(
      (name) => ({ name })
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [video] }))
      .mockResolvedValueOnce(
        json({
          columnHeaders: headers,
          rows: Array.from({ length: 200 }, (_, i) => ['2026-11-03', `SOURCE_${i}`, 'SHORTS', 1]),
        })
      )
      .mockResolvedValueOnce(
        json({ columnHeaders: headers, rows: [['2026-11-03', 'YT_SEARCH', 'SHORTS', 3]] })
      );
    vi.stubGlobal('fetch', fetch);
    const result = await new YouTubeProvider(account('youtube')).fetchMetrics('remote', undefined, [
      { ...target, publishedAt: '2026-11-01T03:00:00.000Z', deadline: '2026-11-08T03:00:00.000Z' },
    ]);
    expect(result.find((r) => r.metric === 'organic_views')?.views).toBe(203);
    const query = new URL(fetch.mock.calls[2][0]).searchParams;
    expect(query.get('startIndex')).toBe('201');
    expect(query.get('startDate')).toBe('2026-10-31');
    expect(query.get('endDate')).toBe('2026-11-07');
  });
  it('does not query daily analytics on every hourly sync', async () => {
    const a = account('youtube');
    a.integration = { lastAnalyticsAt: new Date().toISOString() };
    const fetch = vi.fn().mockResolvedValue(json({ items: [video] }));
    vi.stubGlobal('fetch', fetch);
    expect(await new YouTubeProvider(a).fetchMetrics('remote', undefined, [target])).toHaveLength(
      1
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed or timezone-less native publication timestamps', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          items: [{ id: 'remote', contentDetails: { relatedPlaylists: { uploads: 'uploads' } } }],
        })
      )
      .mockResolvedValueOnce(
        json({
          items: [
            { contentDetails: { videoId: 'video1', videoPublishedAt: '2026-11-01T12:00:00' } },
          ],
        })
      );
    vi.stubGlobal('fetch', fetch);
    await expect(new YouTubeProvider(account('youtube')).discoverPosts('remote')).rejects.toThrow();
  });
  it('discovers only Instagram Reels and follows cursor pagination without following untrusted next URLs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          data: [{ id: 'photo', media_product_type: 'FEED' }],
          paging: { next: 'https://untrusted.example', cursors: { after: 'next' } },
        })
      )
      .mockResolvedValueOnce(
        json({
          data: [
            {
              id: 'reel',
              media_product_type: 'REELS',
              timestamp: target.publishedAt,
              permalink: 'https://www.instagram.com/reel/native/',
            },
          ],
        })
      );
    vi.stubGlobal('fetch', fetch);
    const result = await new MetaProvider(account('instagram')).discoverPosts('remote');
    expect(result).toHaveLength(1);
    expect(fetch.mock.calls[1][0]).toContain('graph.facebook.com/v26.0/remote/media');
    expect(fetch.mock.calls[1][0]).toContain('after=next');
    expect(fetch.mock.calls[0][0]).toContain('appsecret_proof=');
  });
  it('does not label Instagram organic views verified by default or synthesize zero from empty Insights', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ name: 'views', values: [{ value: 900 }] }] }))
      .mockResolvedValueOnce(json({ data: [] }));
    vi.stubGlobal('fetch', fetch);
    const provider = new MetaProvider(account('instagram'));
    const result = await provider.fetchMetrics('remote', undefined, [target]);
    expect(result[0]).toMatchObject({
      metric: 'uncertain_views',
      organicVerified: false,
      providerUpdatedAt: null,
    });
    expect(await provider.fetchMetrics('remote', undefined, [target])).toEqual([]);
  });
  it('reads native Facebook Page Reels and keeps paid/organic/supporting metrics separate', async () => {
    vi.stubEnv('FACEBOOK_REEL_ORGANIC_METRIC', 'organic_counter');
    vi.stubEnv('FACEBOOK_REEL_PAID_METRIC', 'paid_counter');
    vi.stubEnv('FACEBOOK_ORGANIC_VIEWS_VERIFIED', 'true');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json({
            data: [
              {
                id: 'fb',
                created_time: '2026-11-01T07:00:00-0500',
                permalink_url: 'https://www.facebook.com/reel/123/',
              },
            ],
          })
        )
        .mockResolvedValueOnce(
          json({ data: [{ name: 'fb_reels_total_plays', values: [{ value: 1200 }] }] })
        )
        .mockResolvedValueOnce(
          json({ data: [{ name: 'organic_counter', values: [{ value: 1000 }] }] })
        )
        .mockResolvedValueOnce(json({ data: [{ name: 'paid_counter', values: [{ value: 200 }] }] }))
    );
    const provider = new MetaProvider(account('facebook'));
    expect((await provider.discoverPosts('remote'))[0]).toMatchObject({
      contentType: 'reel',
      publishedAt: target.publishedAt,
    });
    const metrics = await provider.fetchMetrics('remote', undefined, [target]);
    expect(metrics.map((m) => m.metric)).toEqual([
      'uncertain_views',
      'organic_views',
      'paid_views',
    ]);
    expect(metrics[1].provenance?.supporting).toBe(true);
  });
  it('rejects timezone-less Graph publication dates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          data: [
            {
              id: 'fb',
              created_time: '2026-11-01T07:00:00',
              permalink_url: 'https://www.facebook.com/reel/123/',
            },
          ],
        })
      )
    );
    await expect(new MetaProvider(account('facebook')).discoverPosts('remote')).rejects.toThrow();
  });
  it('honors Retry-After and preserves rate-limit diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { code: 4 } }, 429, { 'Retry-After': '7200' }))
    );
    const provider = new MetaProvider(account('instagram'));
    expect(await provider.fetchMetrics('remote', undefined, [target])).toEqual([]);
    expect(provider.accountPatch().retryAfterAt).toBe('2026-11-07T14:00:00.000Z');
    expect(provider.diagnosticErrors()[0]).toContain('rate limit');
  });
  it('handles external Meta token revocation without exposing the response token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { code: 190, message: 'do not echo secret' } }, 400))
    );
    const provider = new MetaProvider(account('instagram'));
    await provider.fetchMetrics('remote', undefined, [target]);
    expect(token.revoke).toHaveBeenCalledOnce();
    expect(provider.diagnosticErrors()[0]).toContain('Reconnect');
    expect(provider.diagnosticErrors()[0]).not.toContain('secret');
  });
  it('never trusts an unsafe count or an exhausted request budget', async () => {
    for (const value of [null, '', -1, '1e3', Number.MAX_SAFE_INTEGER + 1])
      expect(safeCounter(value)).toBeNull();
    expect(safeCounter('123')).toBe(123);
    expect(durationSeconds('PT3M')).toBe(180);
    expect(durationSeconds('bad')).toBe(Infinity);
    await expect(providerJson('https://example.com', {}, Date.now() - 1)).rejects.toBeInstanceOf(
      ProviderError
    );
  });
  it('computes Pacific reporting-day boundaries across both DST transitions', () => {
    const spring = pacificDayBounds('2026-03-08'),
      fall = pacificDayBounds('2026-11-01');
    expect(Date.parse(spring.periodEnd) - Date.parse(spring.periodStart)).toBe(23 * 3600000);
    expect(Date.parse(fall.periodEnd) - Date.parse(fall.periodStart)).toBe(25 * 3600000);
  });
});
