import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendObservation, runCommand, seedData } from '@/domain/commands';
import {
  calculateProvisional,
  calculateStatement,
  cpmBonusCents,
  publicationMonth,
} from '@/domain/compensation';
import { verselRules, type Platform, type Rules } from '@/domain/model';
import { trackingState } from '@/domain/tracking';
import { synchronizeAccount } from '@/services/tracking/sync';
import type { TrackingProvider } from '@/services/tracking/provider';

const clock = new Date('2026-11-12T12:00:00Z');
const published = '2026-10-12T12:00:00.000Z';
type Input = { platform: Platform; views: number };
function scenario(inputs: Input[], splitCampaigns = false) {
  let data = seedData(new Date('2026-01-01T00:00:00Z'));
  const go = (command: unknown) =>
    (data = runCommand(data, command, 'Simulated verification only', clock));
  go({ type: 'createCreator', name: 'Simulated creator' });
  const creatorId = data.creators[0].id,
    appId = data.apps[0].id,
    campaignId = data.campaigns[0].id;
  go({ type: 'assignCreator', creatorId, campaignId, startsAt: '2026-01-01T00:00:00Z' });
  if (splitCampaigns) {
    go({ type: 'createCampaign', appId, name: 'Second simulated campaign' });
    go({
      type: 'assignCreator',
      creatorId,
      campaignId: data.campaigns[1].id,
      startsAt: '2026-01-01T00:00:00Z',
    });
  }
  for (const [index, input] of inputs.entries()) {
    if (!data.accounts.some((a) => a.platform === input.platform))
      go({
        type: 'registerAccount',
        creatorId,
        platform: input.platform,
        username: `simulated_${input.platform}`,
        ownership: 'creator',
        provider: 'manual',
      });
    const account = data.accounts.find((a) => a.platform === input.platform)!;
    const native = String(123456789 + index);
    const url = {
      tiktok: `https://www.tiktok.com/@simulated/video/${native}`,
      instagram: `https://www.instagram.com/reel/${native}/`,
      youtube: `https://www.youtube.com/shorts/${native}`,
      facebook: `https://www.facebook.com/reel/${native}`,
    }[input.platform];
    go({
      type: 'addPost',
      input: {
        accountId: account.id,
        platformPostId: native,
        url,
        publishedAt: published,
        campaignId: splitCampaigns ? data.campaigns[index % 2].id : campaignId,
      },
    });
    const post = data.posts.at(-1)!;
    go({
      type: 'addSnapshot',
      input: {
        postId: post.id,
        views: input.views,
        metric: 'organic_views',
        observedAt: post.deadline,
        evidence: 'SIMULATED analytics evidence, not real creator data',
      },
    });
    go({
      type: 'reviewPost',
      postId: post.id,
      decision: 'accepted',
      eligibleViews: input.views,
      note: 'SIMULATED eligible total for unit testing only',
      evidence: {
        reference: 'SIMULATED original seven-day organic export',
        windowStart: post.published_at,
        windowEnd: post.deadline,
        organicConfirmed: true,
        cutoffConfirmed: true,
      },
    });
  }
  return {
    get data() {
      return data;
    },
    go,
    appId,
    creatorId,
    campaignId,
  };
}
const cases: { name: string; posts: Input[]; base: number; bonus: number; payable: number }[] = [
  {
    name: 'Instagram 1K eligible',
    posts: [{ platform: 'instagram', views: 1000 }],
    base: 0,
    bonus: 150,
    payable: 150,
  },
  {
    name: 'TikTok 999 eligible',
    posts: [{ platform: 'tiktok', views: 999 }],
    base: 0,
    bonus: 150,
    payable: 150,
  },
  {
    name: 'TikTok 1K eligible',
    posts: [{ platform: 'tiktok', views: 1000 }],
    base: 1000,
    bonus: 150,
    payable: 1150,
  },
  {
    name: '100K combined: TikTok 40K, Instagram 30K, YouTube 30K',
    posts: [
      { platform: 'tiktok', views: 40000 },
      { platform: 'instagram', views: 30000 },
      { platform: 'youtube', views: 30000 },
    ],
    base: 1000,
    bonus: 15000,
    payable: 16000,
  },
  {
    name: '500K combined: TikTok 100K, Instagram 400K',
    posts: [
      { platform: 'tiktok', views: 100000 },
      { platform: 'instagram', views: 400000 },
    ],
    base: 1000,
    bonus: 35000,
    payable: 36000,
  },
  {
    name: '600K combined: TikTok 100K, Instagram 200K, YouTube 300K',
    posts: [
      { platform: 'tiktok', views: 100000 },
      { platform: 'instagram', views: 200000 },
      { platform: 'youtube', views: 300000 },
    ],
    base: 1000,
    bonus: 37500,
    payable: 38500,
  },
  {
    name: '12M combined: TikTok 1M, Instagram 5M, YouTube 6M',
    posts: [
      { platform: 'tiktok', views: 1000000 },
      { platform: 'instagram', views: 5000000 },
      { platform: 'youtube', views: 6000000 },
    ],
    base: 1000,
    bonus: 322500,
    payable: 300000,
  },
  {
    name: 'Facebook 100K, excluded in current Versel policy',
    posts: [{ platform: 'facebook', views: 100000 }],
    base: 0,
    bonus: 0,
    payable: 0,
  },
];
afterEach(() => vi.useRealTimers());
describe('Versel simulated cross-platform compensation', () => {
  it.each(cases)('$name', ({ posts, base, bonus, payable }) => {
    const f = scenario(posts),
      before = structuredClone(f.data);
    const held = calculateStatement(f.data, f.appId, f.creatorId, '2026-10', verselRules);
    expect(held.baseCents).toBe(base);
    expect(held.potentialBonus).toBe(bonus);
    expect(held.payableCents).toBe(base); // No discretionary bonus without approval.
    const approved = calculateStatement(
      f.data,
      f.appId,
      f.creatorId,
      '2026-10',
      verselRules,
      bonus
    );
    expect(approved.payableCents).toBe(payable);
    expect(approved.lines.reduce((n, line) => n + line.baseCents + line.bonusCents, 0)).toBe(
      payable
    );
    expect(approved.cappedCents).toBe(Math.max(0, base + bonus - payable));
    expect(approved.eligibleViews).toBe(
      posts
        .filter((p) => verselRules.bonusPlatforms.includes(p.platform))
        .reduce((n, p) => n + p.views, 0)
    );
    for (const line of approved.lines) {
      const post = f.data.posts.find((p) => p.id === line.postId)!;
      if (post.platform !== 'tiktok') expect(line.baseCents).toBe(0);
    }
    expect(f.data).toEqual(before);
  });
  it('can include Facebook only when explicitly enabled, still without a fixed payment', () => {
    const f = scenario([{ platform: 'facebook', views: 100000 }]);
    const policy: Rules = {
      ...verselRules,
      bonusPlatforms: [...verselRules.bonusPlatforms, 'facebook'],
    };
    const result = calculateStatement(f.data, f.appId, f.creatorId, '2026-10', policy, 15000);
    expect(result).toMatchObject({ baseCents: 0, potentialBonus: 15000, payableCents: 15000 });
  });
  it('applies tiers and the cap once across campaigns under the same app', () => {
    const test = cases[6],
      f = scenario(test.posts, true);
    const result = calculateStatement(
      f.data,
      f.appId,
      f.creatorId,
      '2026-10',
      verselRules,
      test.bonus
    );
    expect(new Set(result.lines.map((line) => line.campaignId)).size).toBe(2);
    expect(result).toMatchObject({
      eligibleViews: 12000000,
      potentialBonus: 322500,
      payableCents: 300000,
      cappedCents: 23500,
    });
  });
  it('isolates other creators, apps and New York publication months', () => {
    const f = scenario([{ platform: 'instagram', views: 100000 }]);
    const post = f.data.posts[0];
    f.data.posts.push(
      { ...structuredClone(post), id: crypto.randomUUID(), app_id: crypto.randomUUID() },
      { ...structuredClone(post), id: crypto.randomUUID(), creator_id: crypto.randomUUID() },
      {
        ...structuredClone(post),
        id: crypto.randomUUID(),
        published_at: '2026-11-01T04:00:00.000Z',
      }
    );
    expect(publicationMonth('2026-11-01T03:59:59.999Z')).toBe('2026-10');
    expect(
      calculateStatement(f.data, f.appId, f.creatorId, '2026-10', verselRules, 15000)
    ).toMatchObject({ eligibleViews: 100000, potentialBonus: 15000, payableCents: 15000 });
  });
});

it('manual Reel attribution uses original publication plus 168 hours and preserves pre-existing observations and discovery', () => {
  const f = scenario([{ platform: 'instagram', views: 140 }]);
  const post = f.data.posts[0];
  // Simulate the actual order: native discovery and counters first, attribution later.
  Object.assign(post, {
    app_id: null,
    campaign_id: null,
    rules: null,
    deadline: null,
    eligible_views: null,
    eligibility_status: 'review',
    review_evidence: null,
    accepted_at: null,
    accepted_by: null,
  });
  post.tracking = {
    ...trackingState(f.data, post, clock.toISOString()),
    firstSeenAt: '2026-10-12T12:05:00.000Z',
  };
  const snapshots = structuredClone(f.data.snapshots),
    firstSeen = post.tracking.firstSeenAt,
    publishedAt = post.published_at;
  f.go({ type: 'attributePost', postId: post.id, campaignId: f.campaignId });
  const assigned = f.data.posts[0];
  expect(assigned.published_at).toBe(publishedAt);
  expect(assigned.deadline).toBe('2026-10-19T12:00:00.000Z');
  expect(Date.parse(assigned.deadline!) - Date.parse(assigned.published_at)).toBe(168 * 3600000);
  expect(assigned.tracking?.firstSeenAt).toBe(firstSeen);
  expect(f.data.snapshots).toEqual(snapshots);
  expect(assigned.eligible_views).toBeNull();
  expect(assigned.eligibility_status).toBe('tracking');
});

it('keeps public snapshots provisional, deduplicates ingestion and never sums cumulative counters as bonus views', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-13T12:00:00Z');
  const f = scenario([{ platform: 'instagram', views: 2000 }]);
  const post = f.data.posts[0],
    account = f.data.accounts[0];
  Object.assign(post, {
    eligibility_status: 'tracking',
    eligible_views: null,
    accepted_by: null,
    accepted_at: null,
    review_evidence: null,
  });
  post.tracking = {
    ...trackingState(f.data, post, new Date().toISOString()),
    firstSeenAt: published,
    lastAttemptAt: null,
    lastCounterAt: null,
    lastProviderAt: null,
    lastViews: null,
    latestInWindow: null,
    isAd: false,
  };
  f.data.snapshots = [];
  account.provider = 'zernio';
  account.status = 'connected';
  account.provider_account_id = 'simulated-remote';
  const discovered = {
    platformPostId: post.platform_post_id,
    url: post.url,
    caption: post.caption,
    publishedAt: published,
    contentType: 'reel' as const,
    isAd: false,
  };
  const metric = {
    platformPostId: post.platform_post_id,
    views: 2000,
    metric: 'public_views' as const,
    providerUpdatedAt: new Date().toISOString(),
    organicVerified: false,
  };
  const provider: TrackingProvider = {
    name: 'simulation',
    capabilities: () => ({
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['instagram'],
    }),
    discoverPosts: vi.fn().mockResolvedValue([discovered, discovered]),
    fetchMetrics: vi.fn().mockResolvedValue([metric, metric]),
  };
  let data = await synchronizeAccount(f.data, account.id, provider);
  expect(data.posts).toHaveLength(1);
  expect(data.snapshots).toHaveLength(1);
  expect(data.syncRuns[0].diagnostics?.skipped.duplicate_counter).toBe(1);
  data = await synchronizeAccount(data, account.id, provider);
  expect(data.posts).toHaveLength(1);
  expect(data.snapshots).toHaveLength(1);
  const old = data.snapshots[0];
  appendObservation(
    data,
    data.posts[0],
    { ...old, id: crypto.randomUUID() },
    new Date().toISOString()
  );
  expect(data.snapshots).toHaveLength(1);
  vi.setSystemTime('2026-10-14T13:00:00Z');
  data = await synchronizeAccount(data, account.id, provider);
  expect(data.snapshots).toHaveLength(2); // Intentional daily sample, not another 2K earned views.
  const before = structuredClone(data);
  const estimated = calculateProvisional(data, f.appId, f.creatorId, '2026-10', verselRules);
  expect(estimated).toMatchObject({
    eligibleViews: 2000,
    baseCents: 0,
    potentialBonus: cpmBonusCents(2000, verselRules),
  });
  expect(calculateStatement(data, f.appId, f.creatorId, '2026-10', verselRules)).toMatchObject({
    eligibleViews: 0,
    baseCents: 0,
    potentialBonus: 0,
    payableCents: 0,
  });
  expect(data.posts[0].eligible_views).toBeNull();
  expect(data.snapshots.every((s) => s.quality === 'uncertain')).toBe(true);
  expect(data).toEqual(before);
});

it('does not award the TikTok fixed threshold from post-deadline public growth', () => {
  const f = scenario([{ platform: 'tiktok', views: 999 }]);
  const post = f.data.posts[0];
  Object.assign(post, {
    eligibility_status: 'review',
    eligible_views: null,
    accepted_by: null,
    accepted_at: null,
    review_evidence: null,
  });
  f.data.snapshots = [
    {
      ...f.data.snapshots[0],
      metric: 'public_views',
      observed_at: post.deadline!,
      provider_updated_at: post.deadline,
      quality: 'uncertain',
      provenance: { kind: 'cumulative', metricName: 'views', scope: 'public' },
    },
    {
      ...f.data.snapshots[0],
      id: crypto.randomUUID(),
      metric: 'public_views',
      views: 5000,
      observed_at: '2026-10-20T12:00:00.000Z',
      provider_updated_at: '2026-10-20T12:00:00.000Z',
      quality: 'uncertain',
    },
  ];
  expect(calculateProvisional(f.data, f.appId, f.creatorId, '2026-10', verselRules)).toMatchObject({
    eligibleViews: 999,
    baseCents: 0,
    potentialBonus: 150,
  });
  expect(calculateStatement(f.data, f.appId, f.creatorId, '2026-10', verselRules)).toMatchObject({
    eligibleViews: 0,
    baseCents: 0,
    potentialBonus: 0,
    payableCents: 0,
  });
});
