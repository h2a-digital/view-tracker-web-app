import { it, expect } from 'vitest';
import { seedData, runCommand } from '@/domain/commands';
import { postReview } from '@/domain/post-review';
import { verselRules } from '@/domain/model';
import { trackingState } from '@/domain/tracking';
import { populatedDocument } from './helpers/dashboard';
import { auditDescription, ruleDescription } from '@/domain/presentation';
const now = '2026-11-10T12:00:00.000Z';
function fixture(publishedAt = '2026-09-01T12:00:00.000Z') {
  let d = seedData(new Date('2026-01-01T00:00:00Z'));
  const go = (raw: unknown) => (d = runCommand(d, raw, 'Administrator', new Date(now)));
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
    platform: 'tiktok',
    username: 'creator',
    ownership: 'creator',
    provider: 'zernio',
  });
  go({
    type: 'mapAccount',
    accountId: d.accounts[0].id,
    membershipId: d.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'addPost',
    input: {
      accountId: d.accounts[0].id,
      campaignId: d.campaigns[0].id,
      platformPostId: '12345',
      url: 'https://www.tiktok.com/@creator/video/12345',
      publishedAt,
    },
  });
  d.posts[0].tracking = trackingState(d, d.posts[0], now);
  return d;
}
it('keeps newly tracked public posts out of manual review for missing, false or unknown ad detection', () => {
  for (const isAd of [false, null, undefined]) {
    const d = fixture('2026-11-09T12:00:00.000Z'),
      p = d.posts[0];
    p.tracking!.isAd = isAd;
    expect(postReview(d, p, now).stage).toBe('tracking');
    expect(p.eligible_views).toBeNull();
  }
  const d = fixture('2026-11-09T12:00:00.000Z');
  d.posts[0].tracking!.isAd = true;
  expect(postReview(d, d.posts[0], now)).toMatchObject({
    stage: 'review',
    reason: 'The provider flags suspected paid promotion.',
  });
});
it('waits for bounded closing retries, then requests organic/cutoff evidence without approving public counts', () => {
  const d = fixture('2026-11-03T11:30:00.000Z'),
    p = d.posts[0];
  p.tracking!.firstSeenAt = p.published_at;
  p.tracking!.lastCounterAt = '2026-11-10T11:00:00.000Z';
  p.tracking!.lastViews = 50000;
  expect(postReview(d, p, now).stage).toBe('tracking');
  expect(postReview(d, p, '2026-11-12T12:00:00.000Z').stage).toBe('review');
  expect(p.eligible_views).toBeNull();
});
it('detects historical coverage separately and allows one explicit audited bulk exclusion without losing source data', () => {
  const d = fixture(),
    p = d.posts[0];
  expect(postReview(d, p, now).stage).toBe('historical');
  const next = runCommand(
    d,
    {
      type: 'excludeHistoricalPosts',
      postIds: [p.id],
      note: 'Historical publication outside this compensation program.',
    },
    'Administrator',
    new Date(now)
  );
  expect(next.posts[0]).toMatchObject({
    eligibility_status: 'excluded',
    eligible_views: 0,
    url: p.url,
    published_at: p.published_at,
    campaign_id: p.campaign_id,
  });
  expect(postReview(next, next.posts[0], now).stage).toBe('excluded');
  for (const key of ['snapshots', 'accounts', 'mappings', 'memberships', 'ruleVersions'] as const)
    expect(next[key]).toEqual(d[key]);
  expect(next.audit[0].action).toBe('excludeHistoricalPosts');
  expect(d.posts[0].eligible_views).toBeNull();
});
it('rejects mixed active/historical selections atomically and protects finalized financial records', () => {
  const historical = fixture(),
    active = fixture('2026-11-09T12:00:00.000Z');
  historical.posts.push({ ...active.posts[0], id: 'a1000000-0000-4000-8000-000000000001' });
  expect(() =>
    runCommand(
      historical,
      {
        type: 'excludeHistoricalPosts',
        postIds: historical.posts.map((p) => p.id),
        note: 'Exclude historical test content.',
      },
      'Admin',
      new Date(now)
    )
  ).toThrow(/Only unresolved historical/);
  expect(historical.posts[0].eligible_views).toBeNull();
  const paid = populatedDocument();
  const before = structuredClone(paid);
  expect(() =>
    runCommand(
      paid,
      {
        type: 'excludeHistoricalPosts',
        postIds: [paid.posts[0].id],
        note: 'Exclude historical content.',
      },
      'Admin',
      new Date(now)
    )
  ).toThrow(/finalized/);
  expect(paid).toEqual(before);
});
it('displays payout readiness only for accepted evidence, never lifetime public traffic or ad flags alone', () => {
  const d = populatedDocument(),
    p = d.posts[0];
  expect(postReview(d, p, now).stage).toBe('ready');
  p.review_evidence = null;
  expect(postReview(d, p, now).stage).toBe('review');
  p.eligibility_status = 'review';
  p.tracking = {
    ...trackingState(d, p, now),
    firstSeenAt: p.published_at,
    isAd: false,
    lastViews: 999999,
  };
  expect(postReview(d, p, now).stage).not.toBe('ready');
});
it('formats history with readable terms and preserves small CPM precision', () => {
  expect(
    ruleDescription({ windowDays: 7, flatCpm: '0.000001', monthlyCap: '3000', bonusApproval: true })
  ).toContain('168-hour eligibility window');
  expect(ruleDescription({ flatCpm: '0.000001' })).toContain('$0.000001');
  const data = fixture();
  const event = {
    id: 'event',
    action: 'updateEntity',
    entity_id: data.creators[0].id,
    detail: 'Admin · updateEntity',
    created_at: now,
  };
  expect(auditDescription(event, data)).toBe('Details updated · Creator');
  expect(auditDescription(event, data)).not.toContain('Entity');
});

it('classifies old unassigned Instagram imports from recorded discovery time without creating a deadline or changing money', async () => {
  const { paginationFixture } = await import('./helpers/pagination');
  const { groupReviews } = await import('@/domain/review-groups');
  const { browserDashboard } = await import('@/domain/read-model');
  const { performanceReport } = await import('@/domain/analytics');
  const { paginatePosts, postPageSchema } = await import('@/domain/post-pages');
  const { calculateStatement, calculateProvisional } = await import('@/domain/compensation');
  const data = paginationFixture(),
    before = structuredClone(data);
  const imported = data.posts.filter((post) => post.platform === 'instagram');
  for (const post of imported) {
    expect(postReview(data, post, now).stage).toBe('historical');
    expect(post.deadline).toBeNull();
    expect(post.rules).toBeNull();
    expect(post.eligible_views).toBeNull();
  }
  const groups = groupReviews(data, 'all', now);
  expect(groups.find((group) => group.accountId === imported[0].account_id)).toMatchObject({
    cause: 'historical',
    count: 49,
  });
  expect(browserDashboard(data).readModel?.overview.all.reviews).toBe(0);
  expect(performanceReport(data).rows).toHaveLength(54);
  expect(paginatePosts(data, postPageSchema.parse({})).total).toBe(54);
  for (const compute of [calculateStatement, calculateProvisional]) {
    expect(
      compute(data, data.apps[0].id, data.creators[0].id, '2026-10', verselRules).payableCents
    ).toBe(0);
  }
  expect(data).toEqual(before);
});
it('keeps newly discovered unmapped posts under review, including exactly 168 hours and repeated later syncs', async () => {
  const { paginationFixture } = await import('./helpers/pagination');
  const { reviewCause } = await import('@/domain/review-groups');
  const data = paginationFixture(),
    post = data.posts[0];
  data.snapshots = [];
  for (const age of [1, 167, 168]) {
    post.published_at = new Date(Date.parse(now) - age * 3600000).toISOString();
    post.tracking = { ...trackingState(data, post, now), firstSeenAt: now };
    expect(postReview(data, post, now).stage).toBe('review');
    expect(reviewCause(data, post, now)).toBe('mapping');
    expect(postReview(data, post, '2026-12-10T12:00:00.000Z').stage).toBe('review');
  }
  post.published_at = new Date(Date.parse(now) - 168 * 3600000 - 1).toISOString();
  expect(postReview(data, post, now).stage).toBe('historical');
});
it('requires a recorded observation and preserves earlier collection evidence instead of using today or cached provider freshness', async () => {
  const { paginationFixture } = await import('./helpers/pagination');
  const data = paginationFixture(),
    post = data.posts[0],
    snapshot = data.snapshots[0];
  post.tracking = null;
  data.snapshots = [];
  expect(postReview(data, post, now).stage).toBe('review');
  post.tracking = trackingState(data, post, now);
  post.tracking.firstSeenAt = 'bad timestamp';
  expect(postReview(data, post, now).stage).toBe('review');
  post.tracking.firstSeenAt = '2027-01-01T00:00:00Z';
  expect(postReview(data, post, now).stage).toBe('review');
  post.tracking.firstSeenAt = now;
  expect(postReview(data, post, now).stage).toBe('historical');
  data.snapshots = [{ ...snapshot, observed_at: post.published_at }];
  expect(postReview(data, post, now).stage).toBe('review');
  data.snapshots = [{ ...snapshot, observed_at: now, provider_updated_at: post.published_at }];
  expect(postReview(data, post, now).stage).toBe('historical');
  post.tracking.latestInWindow = {
    views: 100,
    observedAt: post.published_at,
    providerAt: post.published_at,
  };
  expect(postReview(data, post, now).stage).toBe('review');
});
