import { describe, it, expect } from 'vitest';
import { performanceReport, financialReport, accountingDay } from '@/domain/analytics';
import { emptyData, verselRules, type Post, type Snapshot, type Statement } from '@/domain/model';
const post: Post = {
  id: 'p',
  account_id: 'a',
  creator_id: 'c',
  platform: 'tiktok',
  platform_post_id: 'remote',
  app_id: 'app',
  campaign_id: 'campaign',
  caption: '',
  url: '',
  published_at: '2026-10-31T23:00:00Z',
  deadline: '2026-11-07T23:00:00Z',
  rules: verselRules,
  rule_version_ids: [],
  eligible_views: 1000,
  eligibility_status: 'accepted',
  accepted_at: '2026-11-08T12:00:00Z',
  accepted_by: 'admin',
  deleted: false,
  review_note: 'Evidence checked',
  review_evidence: {
    reference: 'Export',
    windowStart: '2026-10-31T23:00:00Z',
    windowEnd: '2026-11-07T23:00:00Z',
    organicConfirmed: true,
    cutoffConfirmed: true,
  },
};
const snapshot = (id: string, views: number, observed_at = '2026-11-08T12:00:00Z'): Snapshot => ({
  id,
  post_id: 'p',
  views,
  observed_at,
  provider_updated_at: observed_at,
  metric: 'public_views',
  source: 'api',
  evidence: null,
  quality: 'reported',
  provider: 'zernio',
});
function fixture() {
  return {
    ...emptyData(),
    posts: [structuredClone(post)],
    snapshots: [snapshot('one', 700, '2026-11-01T12:00:00Z'), snapshot('two', 1400)],
  };
}
describe('performance reporting', () => {
  it('uses a single latest cumulative public observation, never a sum or paid/daily/supporting/organic counter', () => {
    const d = fixture();
    d.snapshots.push(
      { ...snapshot('paid', 9999), metric: 'paid_views' },
      { ...snapshot('organic', 8000), metric: 'organic_views' },
      {
        ...snapshot('daily', 9000),
        provenance: { kind: 'daily', metricName: 'views', scope: 'daily' },
      },
      {
        ...snapshot('support', 9000),
        provenance: { kind: 'cumulative', metricName: 'views', scope: 'support', supporting: true },
      }
    );
    expect(performanceReport(d, { end: '2026-11-09' })).toMatchObject({
      publicViews: 1400,
      eligibleViews: 1000,
      observed: 1,
      verified: 1,
    });
    expect(performanceReport(d, { end: '2026-11-01' })).toMatchObject({
      publicViews: 700,
      eligibleViews: 0,
    });
  });
  it('deduplicates platform publications and omits conflicting attribution', () => {
    const d = fixture();
    d.posts.push({ ...post, id: 'duplicate' });
    expect(performanceReport(d, { end: '2026-11-09' }).rows).toHaveLength(1);
    d.posts[1].campaign_id = 'other';
    expect(performanceReport(d)).toMatchObject({ rows: [], conflicts: 1 });
  });
  it('does not label missing observations or accepted totals without evidence as verified', () => {
    const d = fixture();
    d.snapshots = [];
    d.posts[0].review_evidence = null;
    expect(performanceReport(d)).toMatchObject({
      publicViews: 0,
      eligibleViews: 0,
      observed: 0,
      verified: 0,
    });
    expect(performanceReport(d).rows[0].publicViews).toBeNull();
  });
  it('respects app, campaign, creator, platform and New York publication date boundaries', () => {
    expect(accountingDay('2026-11-01T03:59:59Z')).toBe('2026-10-31');
    expect(accountingDay('2026-11-01T04:00:00Z')).toBe('2026-11-01');
    for (const filters of [
      { app: 'other' },
      { campaign: 'other' },
      { creator: 'other' },
      { platform: 'youtube' },
      { start: '2026-11-01' },
      { end: '2026-10-30' },
    ])
      expect(performanceReport(fixture(), filters).rows).toHaveLength(0);
  });
  it('omits erased/deleted publications and policy-blocked views without losing coverage information', () => {
    const d = fixture();
    d.posts[0].source_erased_at = '2026-11-09T12:00:00Z';
    expect(performanceReport(d).rows).toHaveLength(0);
    d.posts[0].source_erased_at = null;
    d.posts[0].deleted = true;
    expect(performanceReport(d).rows).toHaveLength(0);
  });
});
const statement: Statement = {
  id: 's',
  app_id: 'app',
  creator_id: 'c',
  month: '2026-10',
  policy: verselRules,
  status: 'finalized',
  potential_bonus_cents: 150,
  approved_bonus_cents: 150,
  base_cents: 1000,
  payable_cents: 1150,
  capped_cents: 0,
  bonus_note: '',
  fingerprint: '',
  finalized_at: '2026-11-09T12:00:00Z',
  paid_at: null,
  payment_reference: null,
  payment_amount_cents: null,
  lines: [{ postId: 'p', campaignId: 'campaign', views: 1000, baseCents: 1000, bonusCents: 150 }],
};
describe('financial reporting', () => {
  it('uses finalized totals and frozen line denominators, never provisional lifetime views', () => {
    const d = fixture();
    d.statements = [statement, { ...statement, id: 'draft', status: 'draft' }];
    const rows = financialReport(d, { end: '2026-11-09' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cents: 1150, views: 1000, effectiveCpm: 11.5 });
    for (const filter of [
      { campaign: 'campaign' },
      { platform: 'tiktok' },
      { start: '2026-10-02' },
      { end: '2026-10-30' },
      { app: 'other' },
    ])
      expect(financialReport(d, filter)).toHaveLength(0);
  });
  it('retains redacted monetary totals but suppresses effective CPM', () => {
    const d = fixture();
    d.statements = [{ ...statement, source_redacted_at: '2026-11-08T12:00:00Z' }];
    expect(financialReport(d)[0]).toMatchObject({ cents: 1150, views: null, effectiveCpm: null });
  });
  it('includes approved corrections without inventing a corrected CPM denominator', () => {
    const d = fixture();
    d.statements = [statement];
    d.adjustments = [
      {
        id: 'correction',
        statement_id: 's',
        post_id: 'p',
        eligible_views: 1100,
        proposed_cents: 50,
        status: 'approved',
        note: '',
        created_at: '2026-11-09T12:00:00Z',
        paid_at: null,
        payment_reference: null,
      },
    ];
    expect(financialReport(d)[0]).toMatchObject({ cents: 1200, effectiveCpm: null });
  });
});
it('builds observed totals over time by replacing cumulative readings and respecting missing coverage', async () => {
  const { observationTrend } = await import('@/domain/analytics');
  const d = fixture();
  d.posts.push({ ...post, id: 'second', platform_post_id: 'second' });
  d.snapshots.push({ ...snapshot('second-reading', 200), post_id: 'second' });
  expect(observationTrend(d, { end: '2026-11-09' })).toEqual([
    { day: '2026-11-01', views: 700, observed: 1 },
    { day: '2026-11-08', views: 1600, observed: 2 },
  ]);
  d.posts.push({ ...post, id: 'alias' });
  d.snapshots.push({ ...snapshot('correction', 1300, '2026-11-09T12:00:00Z'), post_id: 'alias' });
  expect(observationTrend(d, { end: '2026-11-09' }).at(-1)).toEqual({
    day: '2026-11-09',
    views: 1500,
    observed: 2,
  });
});
it('suppresses policy-blocked totals and their trend even across duplicate registrations', async () => {
  const { observationTrend } = await import('@/domain/analytics');
  const d = fixture();
  d.accounts = [
    {
      id: 'blocked',
      creator_id: 'c',
      platform: 'tiktok',
      username: 'creator',
      ownership: 'creator',
      provider: 'zernio',
      provider_account_id: 'remote',
      provider_profile_id: null,
      status: 'connected',
      last_synced_at: null,
      error: null,
      integration: { payoutsBlocked: true },
    },
  ];
  d.posts.push({ ...post, id: 'alias', account_id: 'blocked' });
  expect(performanceReport(d)).toMatchObject({
    publicViews: 0,
    eligibleViews: 0,
    observed: 0,
    verified: 0,
  });
  expect(observationTrend(d)).toEqual([]);
});
