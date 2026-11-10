import { describe, it, expect, vi, afterEach } from 'vitest';
import { ZernioProvider } from '@/services/tracking/zernio';
import { synchronizeAccount } from '@/services/tracking/sync';
import { runCommand, seedData } from '@/domain/commands';
const native = '7491000000000000001',
  accountId = 'remote-1';
function page(views = 2345) {
  return {
    posts: [
      {
        _id: 'zernio-internal-id',
        content: 'Native TikTok upload',
        publishedAt: new Date(Date.now() - 86400000).toISOString(),
        platform: 'tiktok',
        platforms: [
          {
            platform: 'tiktok',
            accountId,
            platformPostId: native,
            platformPostUrl: `https://www.tiktok.com/@creator/video/${native}`,
            analytics: { views, lastUpdated: new Date(Date.now() - 3600000).toISOString() },
          },
        ],
      },
    ],
    pagination: { page: 1, pages: 1, total: 1 },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mock(responses: unknown[]) {
  vi.stubEnv('ZERNIO_API_KEY', 'test-key');
  const fetch = vi.fn();
  for (const value of responses)
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('Zernio contract', () => {
  it('discovers native uploads without URLs and uses nested native IDs and documented pagination', async () => {
    const fetch = mock([{ posts: [] }, page()]);
    const p = new ZernioProvider();
    const posts = await p.discoverPosts(accountId);
    const metrics = await p.fetchMetrics(accountId);
    expect(posts[0].platformPostId).toBe(native);
    expect(metrics[0]).toMatchObject({
      platformPostId: native,
      views: 2345,
      metric: 'public_views',
      organicVerified: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify({ accountId }));
    expect(fetch.mock.calls[1][0]).toContain('source=all');
    expect(p.capabilities().organicViews).toBe(false);
  });
  it('reads all pages rather than stopping after the recent discovery batch', async () => {
    const first = page(),
      second = page(3000);
    first.pagination.pages = 2;
    second.pagination = { page: 2, pages: 2, total: 2 };
    second.posts[0].platforms[0].platformPostId = '7491000000000000002';
    const fetch = mock([{ posts: [] }, first, second]);
    expect(await new ZernioProvider().discoverPosts(accountId)).toHaveLength(2);
    expect(fetch.mock.calls[2][0]).toContain('page=2');
  });
  it('rejects unmappable counters instead of using provider database IDs', async () => {
    const response = page();
    response.posts[0].platforms[0].platformPostId = '';
    response.posts[0].platforms[0].platformPostUrl = '';
    mock([{ posts: [] }, response]);
    await expect(new ZernioProvider().discoverPosts(accountId)).rejects.toThrow(/native video ID/);
  });
  it('stops on billing gates without buying access or exposing credentials', async () => {
    vi.stubEnv('ZERNIO_API_KEY', 'SECRET_TEST');
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 402 }));
    vi.stubGlobal('fetch', fetch);
    await expect(new ZernioProvider().listAccounts()).rejects.toThrow(/billing gate/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('flags pending analytics and retries without inventing zero views', async () => {
    vi.stubEnv('ZERNIO_API_KEY', 'test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 202 })));
    await expect(new ZernioProvider().fetchMetrics(accountId)).rejects.toThrow(/still syncing/);
  });
  it('persists observations as uncertain, deduplicates the same cached update, and keeps payouts held', async () => {
    let d = seedData();
    d = runCommand(d, { type: 'createCreator', name: 'Creator' });
    d = runCommand(d, {
      type: 'assignCreator',
      creatorId: d.creators[0].id,
      campaignId: d.campaigns[0].id,
      startsAt: d.ruleVersions[0].effective_at,
    });
    d = runCommand(d, {
      type: 'registerAccount',
      creatorId: d.creators[0].id,
      platform: 'tiktok',
      username: 'creator',
      ownership: 'creator',
      provider: 'zernio',
    });
    const a = d.accounts[0];
    a.status = 'connected';
    a.provider_account_id = accountId;
    d = runCommand(d, {
      type: 'mapAccount',
      accountId: a.id,
      membershipId: d.memberships[0].id,
      startsAt: d.ruleVersions[0].effective_at,
    });
    const baseline = page();
    mock([{ posts: [] }, baseline, { posts: [] }, baseline]);
    d = await synchronizeAccount(d, a.id, new ZernioProvider());
    d = await synchronizeAccount(d, a.id, new ZernioProvider());
    expect(d.posts).toHaveLength(1);
    expect(d.snapshots).toHaveLength(1);
    expect(d.snapshots[0].quality).toBe('uncertain');
    expect(d.posts[0].eligible_views).toBeNull();
    expect(d.syncRuns[0].status).toBe('success');
  });
});

it('keeps a daily sample of unchanged cached counters with their original freshness', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    let d = seedData();
    d = runCommand(d, { type: 'createCreator', name: 'Daily Sample' });
    d = runCommand(d, {
      type: 'assignCreator',
      creatorId: d.creators[0].id,
      campaignId: d.campaigns[0].id,
      startsAt: d.ruleVersions[0].effective_at,
    });
    d = runCommand(d, {
      type: 'registerAccount',
      creatorId: d.creators[0].id,
      platform: 'tiktok',
      username: 'creator',
      ownership: 'creator',
      provider: 'zernio',
    });
    const a = d.accounts[0];
    a.status = 'connected';
    a.provider_account_id = accountId;
    d = runCommand(d, {
      type: 'mapAccount',
      accountId: a.id,
      membershipId: d.memberships[0].id,
      startsAt: d.ruleVersions[0].effective_at,
    });
    const cached = page();
    mock([{ posts: [] }, cached, { posts: [] }, cached]);
    d = await synchronizeAccount(d, a.id, new ZernioProvider());
    vi.setSystemTime(new Date('2026-11-08T13:00:00Z'));
    d = await synchronizeAccount(d, a.id, new ZernioProvider());
    expect(d.snapshots).toHaveLength(2);
    expect(d.snapshots[0].views).toBe(d.snapshots[1].views);
    expect(d.snapshots[0].provider_updated_at).toBe(d.snapshots[1].provider_updated_at);
    expect(d.snapshots[0].observed_at).not.toBe(d.snapshots[1].observed_at);
  } finally {
    vi.useRealTimers();
  }
});

it('does not fetch after the shared worker provider deadline', async () => {
  vi.stubEnv('ZERNIO_API_KEY', 'test-key');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const provider = new ZernioProvider(Date.now() - 1);
  await expect(provider.listAccounts()).rejects.toThrow('time budget');
  expect(fetch).not.toHaveBeenCalled();
});

describe('Instagram/Zernio pilot', () => {
  const reel = (overrides = {}) => ({
    platform: 'instagram',
    platformPostId: 'ig-native-1',
    platformPostUrl: 'https://www.instagram.com/reel/SHORTCODE/',
    publishedAt: new Date(Date.now() - 86400000).toISOString(),
    mediaType: 'video',
    mediaProductType: 'REELS',
    analytics: { views: 1200, lastUpdated: new Date().toISOString() },
    ...overrides,
  });
  const enable = () => vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'true');
  it('defaults off without making provider calls, while TikTok still works', async () => {
    const fetch = mock([{ posts: [] }]);
    vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'false');
    const provider = new ZernioProvider(undefined, 'instagram');
    await expect(provider.discoverPosts(accountId)).rejects.toThrow(/disabled/);
    await expect(provider.fetchMetrics(accountId)).rejects.toThrow(/disabled/);
    await expect(
      provider.connectUrl('profile', 'https://hub.example.com/callback', 'creator')
    ).rejects.toThrow(/disabled/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await new ZernioProvider().fetchMetrics(accountId)).toEqual([]);
  });
  it('uses direct Instagram Login and preserves the reconnect identity', async () => {
    enable();
    const fetch = mock([{ authUrl: 'https://www.instagram.com/oauth/authorize' }]);
    await new ZernioProvider(undefined, 'instagram').connectUrl(
      'profile',
      'https://hub.example.com/callback',
      'creator',
      'existing'
    );
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/connect/instagram');
    expect(url.searchParams.get('loginMethod')).toBe('instagram_login');
    expect(url.searchParams.get('reconnectAccountId')).toBe('existing');
  });
  it('discovers confirmed Reels only, including URL evidence when product type is missing', async () => {
    enable();
    const rows = [
      reel(),
      reel({ platformPostId: 'url-reel', mediaProductType: undefined }),
      reel({ platformPostId: 'story', mediaProductType: 'STORY' }),
      reel({ platformPostId: 'photo', mediaType: 'image' }),
      reel({
        platformPostId: 'unknown',
        mediaProductType: undefined,
        platformPostUrl: 'https://www.instagram.com/p/FEED/',
      }),
      reel({
        platformPostId: 'wrong-host',
        mediaProductType: undefined,
        platformPostUrl: 'https://attacker.example/reel/X/',
      }),
    ];
    const fetch = mock([{ posts: rows }, { posts: rows }]);
    const provider = new ZernioProvider(undefined, 'instagram');
    const posts = await provider.discoverPosts(accountId);
    expect(posts.map((p) => p.platformPostId)).toEqual(['ig-native-1', 'url-reel']);
    expect(posts.every((p) => p.contentType === 'reel')).toBe(true);
    const metrics = await provider.fetchMetrics(accountId);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({ metric: 'public_views', organicVerified: false });
    expect(fetch.mock.calls[1][0]).toContain('platform=instagram');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([true, false, null, undefined])(
    'records isAd=%s without treating it as organic proof',
    async (isAd) => {
      enable();
      mock([{ posts: [reel({ isAd })] }]);
      const observations = await new ZernioProvider(undefined, 'instagram').fetchMetrics(accountId);
      expect(observations[0]).toMatchObject({ isAd: isAd ?? null, organicVerified: false });
    }
  );
  it('ignores nested entries belonging to another account', async () => {
    enable();
    mock([
      {
        posts: [
          {
            ...reel(),
            platforms: [
              { platform: 'instagram', accountId: 'someone-else', platformPostId: 'wrong' },
            ],
          },
        ],
      },
    ]);
    expect(await new ZernioProvider(undefined, 'instagram').fetchMetrics(accountId)).toEqual([]);
  });
  it('allows disconnection with the pilot disabled', async () => {
    vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'false');
    const fetch = mock([{}]);
    await new ZernioProvider(undefined, 'instagram').disconnect(accountId);
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
  });
  it.each([true, false, null, undefined])(
    'retains mappings, 168-hour windows and ad review semantics (%s)',
    async (isAd) => {
      enable();
      let d = seedData();
      const go = (command: Parameters<typeof runCommand>[1]) => (d = runCommand(d, command));
      go({ type: 'createCreator', name: 'Instagram pilot' });
      go({
        type: 'assignCreator',
        creatorId: d.creators[0].id,
        campaignId: d.campaigns[0].id,
        startsAt: d.ruleVersions[0].effective_at,
      });
      go({
        type: 'registerAccount',
        creatorId: d.creators[0].id,
        platform: 'instagram',
        username: 'creator',
        ownership: 'creator',
        provider: 'zernio',
      });
      const account = d.accounts[0];
      account.status = 'connected';
      account.provider_account_id = accountId;
      go({
        type: 'mapAccount',
        accountId: account.id,
        membershipId: d.memberships[0].id,
        startsAt: d.ruleVersions[0].effective_at,
      });
      const rows = { posts: [reel({ isAd })] };
      mock([rows, rows, rows, rows]);
      d = await synchronizeAccount(d, account.id, new ZernioProvider(undefined, 'instagram'));
      d = await synchronizeAccount(d, account.id, new ZernioProvider(undefined, 'instagram'));
      expect(d.posts).toHaveLength(1);
      expect(d.snapshots).toHaveLength(1);
      expect(d.posts[0].campaign_id).toBe(d.campaigns[0].id);
      expect(Date.parse(d.posts[0].deadline!) - Date.parse(d.posts[0].published_at)).toBe(
        168 * 3600000
      );
      expect(d.posts[0].tracking?.isAd).toBe(isAd ?? null);
      expect(d.posts[0].tracking?.issues.includes('suspected_paid_promotion')).toBe(isAd === true);
      expect(d.posts[0].eligible_views).toBeNull();
    }
  );
});

it.each([true, false, null, undefined])(
  'reads the analytics row isAd field for existing TikTok accounts (%s)',
  async (isAd) => {
    const row = { ...page().posts[0], isAd };
    mock([{ posts: [row] }]);
    expect((await new ZernioProvider().fetchMetrics(accountId))[0]).toMatchObject({
      isAd: isAd ?? null,
      organicVerified: false,
    });
  }
);

it.each(['tiktok', 'instagram'] as const)(
  'reads %s thumbnails from existing discovery/analytics requests without extra calls',
  async (platform) => {
    vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'true');
    const thumbnailUrl =
      platform === 'tiktok'
        ? 'https://p16.tiktokcdn.com/cover.jpg'
        : 'https://scontent.cdninstagram.com/reel.jpg';
    const row = {
      platform,
      platformPostId: native,
      platformPostUrl:
        platform === 'instagram'
          ? `https://www.instagram.com/reel/${native}/`
          : `https://www.tiktok.com/@creator/video/${native}`,
      content: 'Native video',
      publishedAt: new Date(Date.now() - 86400000).toISOString(),
      mediaType: 'video',
      mediaProductType: platform === 'instagram' ? 'REELS' : undefined,
      thumbnailUrl,
      analytics: { views: 2000, lastUpdated: new Date(Date.now() - 3600000).toISOString() },
    };
    const fetch = mock([{ posts: [] }, { posts: [row], pagination: { page: 1, pages: 1 } }]);
    const provider = new ZernioProvider(Date.now() + 45000, platform);
    expect((await provider.discoverPosts(accountId))[0]).toMatchObject({ thumbnailUrl });
    expect((await provider.fetchMetrics(accountId))[0]).toMatchObject({
      thumbnailUrl,
      views: 2000,
      organicVerified: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);
it('uses documented per-item thumbnail fallback and ignores malformed optional preview fields', async () => {
  const first = {
    ...page().posts[0],
    thumbnailUrl: null,
    mediaItems: [{ type: 'video', thumbnail: 'https://p16.tiktokcdn.com/cover.jpg' }],
  };
  mock([{ posts: [] }, { posts: [first], pagination: { page: 1, pages: 1 } }]);
  expect((await new ZernioProvider().discoverPosts(accountId))[0].thumbnailUrl).toContain(
    '/cover.jpg'
  );
  mock([
    { posts: [] },
    {
      posts: [{ ...first, thumbnailUrl: 9, mediaItems: 'bad' }],
      pagination: { page: 1, pages: 1 },
    },
  ]);
  expect((await new ZernioProvider().discoverPosts(accountId))[0].thumbnailUrl).toBeUndefined();
});
