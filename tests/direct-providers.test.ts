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
import {
  DirectAccess,
  durationSeconds,
  pacificDayBounds,
  safeCounter,
} from '@/services/tracking/direct/base';
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
    thumbnails: { high: { url: 'https://i.ytimg.com/vi/video1/hqdefault.jpg' } },
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
    expect(posts[0]).toMatchObject({
      platformPostId: 'video1',
      contentType: 'shorts_candidate',
      thumbnailUrl: 'https://i.ytimg.com/vi/video1/hqdefault.jpg',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
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
              thumbnail_url: 'https://scontent.cdninstagram.com/reel.jpg',
              timestamp: target.publishedAt,
              permalink: 'https://www.instagram.com/reel/native/',
            },
          ],
        })
      );
    vi.stubGlobal('fetch', fetch);
    const result = await new MetaProvider(account('instagram')).discoverPosts('remote');
    expect(result).toHaveLength(1);
    expect(result[0].thumbnailUrl).toBe('https://scontent.cdninstagram.com/reel.jpg');
    expect(fetch.mock.calls[0][0]).toContain('thumbnail_url');
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

it('discovers native Instagram Login Reels and reads views on the Instagram host without Facebook credentials', async () => {
  vi.stubEnv('INSTAGRAM_APP_ID', 'ig-app');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'ig-secret');
  vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v27.0');
  vi.stubEnv('META_APP_ID', '');
  vi.stubEnv('META_APP_SECRET', '');
  vi.stubEnv('INSTAGRAM_ORGANIC_VIEWS_VERIFIED', 'false');
  const a = account('instagram');
  a.integration = { instagramAuthMode: 'instagram_login' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        data: [
          {
            id: 'video1',
            caption: 'Native Reel',
            timestamp: '2026-11-01T12:00:00+0000',
            permalink: 'https://www.instagram.com/reel/video1/',
            media_product_type: 'REELS',
            thumbnail_url: 'https://scontent.cdninstagram.com/reel.jpg',
          },
          {
            id: 'photo',
            timestamp: '2026-11-01T12:00:00Z',
            permalink: 'https://www.instagram.com/p/photo/',
            media_product_type: 'FEED',
          },
        ],
      })
    )
    .mockResolvedValueOnce(json({ data: [{ name: 'views', values: [{ value: 1200 }] }] }));
  vi.stubGlobal('fetch', fetch);
  const provider = new MetaProvider(a);
  expect(await provider.discoverPosts('remote', '2026-11-01T00:00:00.000Z')).toEqual([
    expect.objectContaining({
      platformPostId: 'video1',
      publishedAt: '2026-11-01T12:00:00.000Z',
      contentType: 'reel',
    }),
  ]);
  expect(await provider.fetchMetrics('remote', undefined, [target])).toEqual([
    expect.objectContaining({
      views: 1200,
      metric: 'uncertain_views',
      organicVerified: false,
      providerUpdatedAt: null,
      provenance: expect.objectContaining({
        metricName: 'views',
        apiVersion: 'v27.0',
        kind: 'cumulative',
      }),
    }),
  ]);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).toContain('https://graph.instagram.com/v27.0/');
    expect(String(url)).not.toMatch(
      /appsecret_proof|access_token|total_views|crossposted_views|facebook_views/
    );
    expect(init.headers).toEqual({ Authorization: 'Bearer token' });
  }
});

function unifiedAccount() {
  vi.stubEnv('INSTAGRAM_META_APP_ID', '123456');
  vi.stubEnv('INSTAGRAM_META_APP_SECRET', 'unified-secret');
  vi.stubEnv('INSTAGRAM_LOGIN_CONFIG_ID', '4372319632985486');
  vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v27.0');
  return {
    ...account('instagram'),
    provider_account_id: '222',
    integration: { instagramAuthMode: 'unified_login' as const },
  };
}
it('discovers native SUAT Reels and collects uncertain views with proof from the separate Meta app', async () => {
  const a = unifiedAccount();
  vi.stubEnv('INSTAGRAM_ORGANIC_VIEWS_VERIFIED', 'false');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        data: [
          {
            id: '777',
            caption: 'Native Reel',
            timestamp: target.publishedAt,
            permalink: 'https://www.instagram.com/reel/test/',
            media_product_type: 'REELS',
            thumbnail_url: 'https://scontent.cdninstagram.com/reel.jpg',
          },
        ],
      })
    )
    .mockResolvedValueOnce(json({ data: [{ name: 'views', values: [{ value: 1200 }] }] }));
  vi.stubGlobal('fetch', fetch);
  const provider = new MetaProvider(a);
  expect(await provider.discoverPosts('222', '2026-11-01T00:00:00Z')).toEqual([
    expect.objectContaining({
      platformPostId: '777',
      thumbnailUrl: 'https://scontent.cdninstagram.com/reel.jpg',
    }),
  ]);
  expect(
    await provider.fetchMetrics('222', undefined, [{ ...target, platformPostId: '777' }])
  ).toEqual([
    expect.objectContaining({
      views: 1200,
      metric: 'uncertain_views',
      organicVerified: false,
      providerUpdatedAt: null,
    }),
  ]);
  for (const [url, init] of fetch.mock.calls) {
    expect(new URL(String(url)).hostname).toBe('graph.facebook.com');
    expect(String(url)).toContain('appsecret_proof=');
    expect(String(url)).not.toMatch(/messages|conversations|access_token|total_views/);
    expect(init.headers).toEqual({ Authorization: 'Bearer token' });
  }
});
it.each([
  'https://graph.facebook.com/v27.0/222/messages',
  'https://graph.facebook.com/v27.0/222/conversations',
  'https://graph.facebook.com/v27.0/222?fields=messages',
  'https://graph.facebook.com/v27.0/222/media?fields=id,messages',
  'https://graph.facebook.com/v27.0/222/insights?metric=views&period=lifetime&fields=messages',
  'https://attacker.example/v27.0/me/assigned_instagram_accounts?fields=id,username',
])(
  'blocks non-tracking Unified request %s before reading a credential or making an API call',
  async (url) => {
    const access = new DirectAccess(unifiedAccount(), Date.now() + 10000);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    token.get.mockClear();
    await expect(access.request(url)).rejects.toThrow('not permitted');
    expect(fetch).not.toHaveBeenCalled();
    expect(token.get).not.toHaveBeenCalled();
  }
);
it('erases revoked SUAT credentials safely instead of applying Instagram refresh', async () => {
  const access = new DirectAccess(unifiedAccount(), Date.now() + 10000);
  const fetch = vi.fn().mockResolvedValue(json({ error: { code: 190 } }, 400));
  vi.stubGlobal('fetch', fetch);
  await expect(
    access.request(
      'https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?fields=id,username'
    )
  ).rejects.toThrow('Reconnect');
  expect(token.revoke).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});

it('allows only the exact connected Instagram profile fields without opening arbitrary Graph endpoints', async () => {
  const a = unifiedAccount();
  const access = new DirectAccess(a, Date.now() + 5000);
  const fetch = vi.fn().mockResolvedValue(
    json({
      id: '222',
      username: 'creator',
      profile_picture_url: 'https://cdninstagram.com/avatar',
    })
  );
  vi.stubGlobal('fetch', fetch);
  await access.request(
    'https://graph.facebook.com/v27.0/222?fields=id,username,name,profile_picture_url'
  );
  expect(fetch).toHaveBeenCalledOnce();
  await expect(
    access.request(
      'https://graph.facebook.com/v27.0/999?fields=id,username,name,profile_picture_url'
    )
  ).rejects.toThrow(/not permitted/);
  await expect(
    access.request('https://graph.facebook.com/v27.0/222?fields=id,messages')
  ).rejects.toThrow(/not permitted/);
  expect(fetch).toHaveBeenCalledOnce();
});
