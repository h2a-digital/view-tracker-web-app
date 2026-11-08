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
