import { afterEach, describe, it, expect, vi } from 'vitest';
import { runCommand, seedData } from '@/domain/commands';
import { synchronizeAccount } from '@/services/tracking/sync';
import { provisionalViews } from '@/domain/tracking';
import type { MetricObservation, TrackingProvider } from '@/services/tracking/provider';
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  let d = seedData(new Date('2026-01-01T00:00:00Z'));
  const go = (c: unknown) => (d = runCommand(d, c));
  go({ type: 'createCreator', name: 'Creator' });
  go({
    type: 'assignCreator',
    creatorId: d.creators[0].id,
    campaignId: d.campaigns[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'registerAccount',
    creatorId: d.creators[0].id,
    platform: 'instagram',
    username: 'native',
    ownership: 'creator',
    provider: 'direct',
  });
  d.accounts[0].status = 'connected';
  d.accounts[0].provider_account_id = 'native';
  go({
    type: 'mapAccount',
    accountId: d.accounts[0].id,
    membershipId: d.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  return d;
}
function provider(metrics: MetricObservation[]): TrackingProvider {
  return {
    name: 'instagram_official',
    capabilities: () => ({
      discovery: true,
      publicViews: false,
      organicViews: false,
      platforms: ['instagram'],
    }),
    discoverPosts: async () => [
      {
        platformPostId: 'video',
        url: 'https://www.instagram.com/reel/video/',
        caption: 'Native',
        publishedAt: '2026-11-01T12:00:00.000Z',
        contentType: 'reel',
      },
    ],
    fetchMetrics: vi.fn().mockResolvedValue(metrics),
  };
}
const primary: MetricObservation = {
  platformPostId: 'video',
  views: 1000,
  metric: 'uncertain_views',
  providerUpdatedAt: null,
  organicVerified: false,
  provenance: { kind: 'cumulative', metricName: 'views', scope: 'unverified' },
};
afterEach(() => vi.useRealTimers());
describe('direct-provider tracking and compensation boundaries', () => {
  it('retains equal daily counts from separate reporting days collected at one instant', async () => {
    const d = setup();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const daily = (day: number): MetricObservation => ({
      ...primary,
      metric: 'organic_views',
      provenance: {
        kind: 'daily',
        metricName: 'analytics.views.non_advertising',
        scope: 'day',
        periodStart: `2026-11-0${day}T08:00:00.000Z`,
        periodEnd: `2026-11-0${day + 1}T08:00:00.000Z`,
      },
    });
    const p = provider([primary, daily(1), daily(2)]);
    const next = await synchronizeAccount(d, d.accounts[0].id, p);
    expect(next.snapshots).toHaveLength(3);
    expect((await synchronizeAccount(next, d.accounts[0].id, p)).snapshots).toHaveLength(3);
  });
  it('stores primary/paid/daily observations separately and never promotes paid or daily totals into the tracking counter', async () => {
    const d = setup(),
      p = provider([
        primary,
        {
          ...primary,
          views: 100000,
          metric: 'paid_views',
          provenance: { kind: 'cumulative', metricName: 'paid', scope: 'paid' },
        },
        {
          ...primary,
          views: 300000,
          metric: 'organic_views',
          provenance: {
            kind: 'daily',
            metricName: 'daily',
            scope: 'day',
            periodStart: '2026-11-01T00:00:00Z',
            periodEnd: '2026-11-02T00:00:00Z',
          },
        },
      ]);
    const next = await synchronizeAccount(d, d.accounts[0].id, p);
    expect(next.snapshots).toHaveLength(3);
    expect(next.posts[0].tracking?.lastViews).toBe(1000);
    expect(next.posts[0].eligible_views).toBeNull();
    expect(provisionalViews(next, next.posts[0])).toBe(1000);
    const again = await synchronizeAccount(next, d.accounts[0].id, p);
    expect(again.snapshots).toHaveLength(3);
    expect(again.syncRuns[0].diagnostics?.snapshotsSaved).toBe(0);
  });
  it('does not fetch unnecessary native counters between daily samples', async () => {
    const d = setup(),
      p = provider([primary]);
    const first = await synchronizeAccount(d, d.accounts[0].id, p);
    p.fetchMetrics = vi.fn().mockResolvedValue([]);
    vi.setSystemTime(new Date('2026-11-02T13:00:00Z'));
    const next = await synchronizeAccount(first, d.accounts[0].id, p);
    expect(p.fetchMetrics).toHaveBeenCalledWith('native', expect.any(String), []);
    expect(next.syncRuns[0].diagnostics?.missingCounters).toBe(0);
  });
  it('does not poll a missing historical counter forever after the bounded follow-up window', async () => {
    const d = setup(),
      p = provider([]);
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const first = await synchronizeAccount(d, d.accounts[0].id, p);
    expect(p.fetchMetrics).toHaveBeenLastCalledWith('native', expect.any(String), [
      expect.objectContaining({ platformPostId: 'video' }),
    ]);
    vi.setSystemTime(new Date('2026-11-15T13:00:00Z'));
    const next = await synchronizeAccount(first, d.accounts[0].id, p);
    expect(p.fetchMetrics).toHaveBeenLastCalledWith('native', expect.any(String), []);
    expect(next.posts[0].tracking?.status).toBe('review');
    expect(next.posts[0].eligible_views).toBeNull();
  });
  it('holds closing uncertainty when the API supplies no measurement timestamp', async () => {
    const d = setup(),
      p = provider([primary]);
    const first = await synchronizeAccount(d, d.accounts[0].id, p);
    vi.setSystemTime(new Date('2026-11-08T12:30:00Z'));
    const next = await synchronizeAccount(first, d.accounts[0].id, p);
    expect(next.posts[0].deadline).toBe('2026-11-08T12:00:00.000Z');
    expect(next.posts[0].tracking?.status).toBe('closing');
    expect(next.posts[0].tracking?.issues).toContain('cutoff_uncertain');
    expect(next.posts[0].eligible_views).toBeNull();
    expect(provisionalViews(next, next.posts[0])).toBe(1000);
  });
  it('blocks policy-restricted acceptance and excludes paid-only evidence from the eligible maximum', async () => {
    const d = setup();
    const next = await synchronizeAccount(
      d,
      d.accounts[0].id,
      provider([{ ...primary, metric: 'paid_views' }])
    );
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    const post = next.posts[0];
    const command = {
      type: 'reviewPost',
      postId: post.id,
      decision: 'accepted',
      eligibleViews: 100,
      note: 'Verified evidence',
      evidence: {
        reference: 'Original verified evidence',
        windowStart: post.published_at,
        windowEnd: post.deadline,
        organicConfirmed: true,
        cutoffConfirmed: true,
      },
    };
    expect(() => runCommand(next, command)).toThrow('exceed recorded');
    next.accounts[0].integration = { payoutsBlocked: true };
    expect(() => runCommand(next, command)).toThrow('policy approval');
    expect(provisionalViews(next, post)).toBe(0);
  });
  it('keeps direct follow-up bounded at 72 hours without extending eligibility', async () => {
    const d = setup();
    const first = await synchronizeAccount(d, d.accounts[0].id, provider([primary]));
    vi.setSystemTime(new Date('2026-11-11T13:00:00Z'));
    const next = await synchronizeAccount(first, d.accounts[0].id, provider([primary]));
    expect(next.posts[0].deadline).toBe('2026-11-08T12:00:00.000Z');
    expect(next.posts[0].tracking?.status).toBe('review');
    expect(next.posts[0].tracking?.issues).toContain('closing_reading_missing');
  });
  it('keeps Facebook out of Versel bonus rules and rejects direct TikTok registration', () => {
    const d = setup();
    expect(d.ruleVersions[0].patch.bonusPlatforms).not.toContain('facebook');
    expect(() =>
      runCommand(d, {
        type: 'registerAccount',
        creatorId: d.creators[0].id,
        platform: 'tiktok',
        username: 'tiktok',
        ownership: 'creator',
        provider: 'direct',
      })
    ).toThrow('Zernio');
  });
});

it('persists thumbnails through duplicate discoveries and unchanged metrics without changing window or snapshots', async () => {
  const d = setup(),
    p = provider([primary]);
  const discover = p.discoverPosts;
  p.discoverPosts = async (...args) =>
    (await discover(...args)).map((post) => ({
      ...post,
      thumbnailUrl: 'https://scontent.cdninstagram.com/cover.jpg',
    }));
  const first = await synchronizeAccount(d, d.accounts[0].id, p);
  const next = await synchronizeAccount(first, d.accounts[0].id, p);
  expect(next.posts[0].tracking?.thumbnail?.url).toBe(
    'https://scontent.cdninstagram.com/cover.jpg'
  );
  expect(Date.parse(next.posts[0].deadline!) - Date.parse(next.posts[0].published_at)).toBe(
    168 * 3600000
  );
  expect(next.snapshots).toEqual(first.snapshots);
  expect(next.posts[0].eligible_views).toBe(first.posts[0].eligible_views);
  expect(next.posts[0].rules).toEqual(first.posts[0].rules);
  expect(next.posts[0].campaign_id).toBe(first.posts[0].campaign_id);
  expect(next.statements).toEqual(first.statements);
});
