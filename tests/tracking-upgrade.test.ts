import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand, seedData } from '@/domain/commands';
import { publicationMonth, nextMonthStart, calculateProvisional } from '@/domain/compensation';
import { instant, formatTimestamp } from '@/domain/time';
import { synchronizeAccount } from '@/services/tracking/sync';
import { ZernioProvider } from '@/services/tracking/zernio';
import type { MetricObservation, TrackingProvider } from '@/services/tracking/provider';
const published = '2026-10-31T16:00:00.000Z',
  deadline = '2026-11-07T16:00:00.000Z';
function setup(pub = published, at = '2026-10-31T17:00:00.000Z') {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  let d = seedData(new Date('2026-01-01T12:00:00Z'));
  const go = (c: unknown) => (d = runCommand(d, c));
  go({ type: 'createCreator', name: 'US creator' });
  const creator = d.creators[0],
    campaign = d.campaigns[0];
  go({
    type: 'assignCreator',
    creatorId: creator.id,
    campaignId: campaign.id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'registerAccount',
    creatorId: creator.id,
    platform: 'tiktok',
    username: 'creator',
    ownership: 'creator',
    provider: 'zernio',
  });
  const account = d.accounts[0];
  account.status = 'connected';
  account.provider_account_id = 'remote';
  go({
    type: 'mapAccount',
    accountId: account.id,
    membershipId: d.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'addPost',
    input: {
      accountId: account.id,
      platformPostId: '123456789',
      url: 'https://www.tiktok.com/@creator/video/123456789',
      publishedAt: pub,
    },
  });
  return { data: d, accountId: account.id, postId: d.posts[0].id };
}
function provider(at: string | null, views = 2000): TrackingProvider {
  return {
    name: 'test',
    capabilities: () => ({
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['tiktok'],
    }),
    discoverPosts: vi.fn().mockResolvedValue([]),
    fetchMetrics: vi.fn().mockResolvedValue([
      {
        platformPostId: '123456789',
        views,
        metric: 'public_views',
        providerUpdatedAt: at,
        organicVerified: false,
      } satisfies MetricObservation,
    ]),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('UTC windows and New York accounting', () => {
  it.each([
    ['2026-03-07T12:00:00-05:00', '2026-03-14T17:00:00.000Z'],
    ['2026-10-31T12:00:00-04:00', deadline],
    ['2026-03-07T09:00:00-08:00', '2026-03-14T17:00:00.000Z'],
  ])('keeps 168 elapsed hours from %s', (pub, end) => {
    const f = setup(pub, '2026-12-01T12:00:00Z');
    expect(f.data.posts[0].deadline).toBe(end);
    expect((Date.parse(end) - Date.parse(f.data.posts[0].published_at)) / 3600000).toBe(168);
  });
  it('assigns months and monthly rules at New York midnight across DST', () => {
    expect(publicationMonth('2026-11-01T03:59:59Z')).toBe('2026-10');
    expect(publicationMonth('2026-11-01T04:00:00Z')).toBe('2026-11');
    expect(publicationMonth('2026-12-01T04:59:59Z')).toBe('2026-11');
    expect(publicationMonth('2026-12-01T05:00:00Z')).toBe('2026-12');
    expect(nextMonthStart(new Date('2026-10-15T12:00:00Z'))).toBe('2026-11-01T04:00:00.000Z');
    expect(nextMonthStart(new Date('2026-11-15T12:00:00Z'))).toBe('2026-12-01T05:00:00.000Z');
    expect(formatTimestamp('2026-11-01T06:30:00Z')).toContain('EST');
  });
  it.each(['2026-11-01T01:30:00', '2026-02-30T10:00:00Z', 'not-a-date'])(
    'rejects ambiguous or malformed instant %s',
    (value) => {
      expect(() => instant(value)).toThrow();
    }
  );
});
describe('closing reads and unattended diagnostics', () => {
  it('retries cached closing data, completes only after a fresh provider update, and excludes later views', async () => {
    const f = setup();
    let d = await synchronizeAccount(f.data, f.accountId, provider('2026-10-31T16:55:00Z', 1000));
    vi.setSystemTime(new Date('2026-11-07T15:30:00Z'));
    d = await synchronizeAccount(d, f.accountId, provider('2026-11-07T15:20:00Z', 2000));
    vi.setSystemTime(new Date('2026-11-07T16:05:00Z'));
    d = await synchronizeAccount(d, f.accountId, provider('2026-11-07T15:20:00Z', 2000));
    expect(d.posts[0].tracking?.status).toBe('closing');
    expect(d.syncRuns[0].diagnostics?.staleCounters).toBe(1);
    vi.setSystemTime(new Date('2026-11-07T17:15:00Z'));
    d = await synchronizeAccount(d, f.accountId, provider('2026-11-07T16:30:00Z', 5000));
    expect(d.posts[0].tracking).toMatchObject({
      status: 'complete',
      provisionalViews: 2000,
      cutoffVerified: false,
    });
    expect(d.posts[0].eligibility_status).toBe('review');
    expect(d.posts[0].eligible_views).toBeNull();
    expect(d.statements[0].payable_cents).toBe(0);
    const estimate = calculateProvisional(
      d,
      d.apps[0].id,
      d.creators[0].id,
      '2026-10',
      d.statements[0].policy
    );
    expect(estimate.eligibleViews).toBe(2000);
    expect(estimate.payableCents).toBe(1300);
    const count = d.snapshots.length;
    d = await synchronizeAccount(d, f.accountId, provider('2026-11-07T16:30:00Z', 5000));
    expect(d.snapshots).toHaveLength(count);
    expect(d.syncRuns[0].diagnostics?.skipped.tracking_finished).toBe(1);
  });
  it('bounds missing closing retries at 24 hours and marks unresolved data for review', async () => {
    const f = setup();
    let d = await synchronizeAccount(f.data, f.accountId, provider('2026-10-31T16:55:00Z'));
    const p = provider(null);
    vi.mocked(p.fetchMetrics).mockResolvedValue([]);
    vi.setSystemTime(new Date('2026-11-07T17:00:00Z'));
    d = await synchronizeAccount(d, f.accountId, p);
    expect(d.posts[0].tracking?.status).toBe('closing');
    expect(d.syncRuns[0].diagnostics?.missingCounters).toBe(1);
    vi.setSystemTime(new Date('2026-11-08T16:00:00Z'));
    d = await synchronizeAccount(d, f.accountId, p);
    expect(d.posts[0].tracking?.status).toBe('review');
    expect(d.posts[0].tracking?.issues).toContain('closing_reading_missing');
  });
  it('records historical videos without inventing original-window eligibility', async () => {
    const f = setup(published, '2026-11-20T12:00:00Z');
    const d = await synchronizeAccount(
      f.data,
      f.accountId,
      provider('2026-11-20T11:59:00Z', 50000)
    );
    expect(d.snapshots).toHaveLength(1);
    expect(d.posts[0].tracking).toMatchObject({ status: 'review', provisionalViews: 0 });
    expect(d.posts[0].tracking?.issues).toContain('historical_window_missing');
    expect(d.statements[0].payable_cents).toBe(0);
  });
  it('samples unchanged metrics daily, avoids duplicate rapid samples, and diagnoses freshness', async () => {
    const f = setup();
    let d = await synchronizeAccount(f.data, f.accountId, provider('2026-10-31T16:55:00Z'));
    d = await synchronizeAccount(d, f.accountId, provider('2026-10-31T16:55:00Z'));
    expect(d.snapshots).toHaveLength(1);
    expect(d.syncRuns[0].diagnostics).toMatchObject({ snapshotsSaved: 0, updatedCounters: 0 });
    vi.setSystemTime(new Date('2026-11-01T18:00:00Z'));
    d = await synchronizeAccount(d, f.accountId, provider('2026-10-31T16:55:00Z'));
    expect(d.snapshots).toHaveLength(2);
    expect(d.syncRuns[0].diagnostics?.staleCounters).toBe(1);
  });
  it('preserves refresh failures and recovers without approving eligibility', async () => {
    const f = setup();
    const p = provider(null);
    vi.mocked(p.fetchMetrics).mockRejectedValueOnce(new Error('Temporary provider failure'));
    let d = await synchronizeAccount(f.data, f.accountId, p);
    expect(d.syncRuns[0].status).toBe('failed');
    expect(d.posts[0].tracking?.lastError).toContain('Refresh failed');
    d = await synchronizeAccount(d, f.accountId, provider('2026-10-31T16:55:00Z'));
    expect(d.syncRuns[0].status).toBe('success');
    expect(d.posts[0].tracking?.lastError).toBeNull();
  });
  it('requires auditable organic and cutoff evidence for eligibility approval', () => {
    const f = setup();
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    expect(() =>
      runCommand(f.data, {
        type: 'reviewPost',
        postId: f.postId,
        decision: 'accepted',
        eligibleViews: 0,
        note: 'Lifetime counter is not proof',
      })
    ).toThrow(/Evidence/);
  });
  it('rejects malformed provider timestamps before Date can interpret them in server local time', async () => {
    vi.stubEnv('ZERNIO_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            posts: [
              {
                platformPostId: '123',
                publishedAt: '2026-11-01T01:30:00',
                platformPostUrl: 'https://www.tiktok.com/@creator/video/123',
              },
            ],
          }),
          { status: 200 }
        )
      )
    );
    await expect(new ZernioProvider().discoverPosts('remote')).rejects.toThrow();
  });
});

it('requires both evidence confirmations and exact coverage, not a lifetime counter', () => {
  const f = setup(published, '2026-11-08T12:00:00Z');
  const p = f.data.posts[0];
  const base = {
    type: 'reviewPost',
    postId: p.id,
    decision: 'accepted',
    eligibleViews: 0,
    note: 'Review original organic export',
    evidence: {
      reference: 'Company-controlled analytics export',
      windowStart: p.published_at,
      windowEnd: p.deadline!,
      organicConfirmed: true,
      cutoffConfirmed: true,
    },
  };
  expect(() =>
    runCommand(f.data, { ...base, evidence: { ...base.evidence, organicConfirmed: false } })
  ).toThrow(/Evidence/);
  expect(() =>
    runCommand(f.data, {
      ...base,
      evidence: { ...base.evidence, windowEnd: '2026-11-09T00:00:00Z' },
    })
  ).toThrow(/coverage/);
  const d = runCommand(f.data, base);
  expect(d.posts[0].review_evidence?.reference).toContain('analytics export');
});
it('never treats an unknown provider timestamp as a completed closing measurement', async () => {
  const f = setup();
  let d = await synchronizeAccount(f.data, f.accountId, provider('2026-10-31T16:55:00Z'));
  vi.setSystemTime(new Date('2026-11-07T17:00:00Z'));
  d = await synchronizeAccount(d, f.accountId, provider(null, 9000));
  expect(d.posts[0].tracking?.status).toBe('closing');
  expect(d.posts[0].tracking?.issues).toContain('provider_time_unknown');
  expect(d.posts[0].tracking?.provisionalViews).toBe(2000);
  expect(d.syncRuns[0].diagnostics?.staleCounters).toBe(1);
});
it('validates analytics freshness timestamps as strictly as publication timestamps', async () => {
  vi.stubEnv('ZERNIO_API_KEY', 'test-key');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          posts: [
            {
              platform: 'tiktok',
              platformPostId: '123',
              platformPostUrl: 'https://www.tiktok.com/@creator/video/123',
              analytics: { views: 1000, lastUpdated: '2026-11-01T01:30:00' },
            },
          ],
          pagination: { page: 1, pages: 1 },
        }),
        { status: 200 }
      )
    )
  );
  await expect(new ZernioProvider().fetchMetrics('remote')).rejects.toThrow();
});
it('updates provisional estimates from changed in-window readings without adding duplicate samples', async () => {
  const f = setup();
  let d = await synchronizeAccount(f.data, f.accountId, provider('2026-10-31T16:55:00Z', 1000));
  vi.setSystemTime(new Date('2026-10-31T18:00:00Z'));
  d = await synchronizeAccount(d, f.accountId, provider('2026-10-31T17:55:00Z', 2000));
  expect(d.snapshots).toHaveLength(1);
  expect(d.posts[0].tracking?.provisionalViews).toBe(2000);
  expect(d.posts[0].eligible_views).toBeNull();
  expect(d.syncRuns[0].diagnostics?.updatedCounters).toBe(1);
});

it('keeps closing when a post-deadline measurement is itself too stale', async () => {
  const f = setup();
  let d = await synchronizeAccount(f.data, f.accountId, provider('2026-10-31T16:55:00Z'));
  vi.setSystemTime(new Date('2026-11-07T20:00:00Z'));
  d = await synchronizeAccount(d, f.accountId, provider('2026-11-07T16:10:00Z', 9000));
  expect(d.posts[0].tracking?.status).toBe('closing');
  expect(d.syncRuns[0].diagnostics?.staleCounters).toBe(1);
  expect(d.posts[0].eligible_views).toBeNull();
});
it('selects the newest duplicate counter rather than freezing an older duplicate', async () => {
  const f = setup();
  const p = provider('2026-10-31T16:55:00Z');
  vi.mocked(p.fetchMetrics).mockResolvedValue([
    {
      platformPostId: '123456789',
      views: 1000,
      providerUpdatedAt: '2026-10-31T16:40:00Z',
      metric: 'public_views',
      organicVerified: false,
    },
    {
      platformPostId: '123456789',
      views: 2000,
      providerUpdatedAt: '2026-10-31T16:55:00Z',
      metric: 'public_views',
      organicVerified: false,
    },
  ]);
  const d = await synchronizeAccount(f.data, f.accountId, p);
  expect(d.snapshots).toHaveLength(1);
  expect(d.snapshots[0].views).toBe(2000);
  expect(d.syncRuns[0].diagnostics?.skipped.duplicate_counter).toBe(1);
});

it('refreshes a newly discovered older video during the same job while its window is still open', async () => {
  const f = setup(published, '2026-11-07T15:30:00Z');
  f.data.posts = [];
  f.data.accounts[0].last_synced_at = '2026-11-07T14:30:00.000Z';
  const p = provider('2026-11-07T15:25:00Z', 2000);
  vi.mocked(p.discoverPosts).mockResolvedValue([
    {
      platformPostId: '123456789',
      url: 'https://www.tiktok.com/@creator/video/123456789',
      caption: 'Delayed discovery',
      publishedAt: published,
    },
  ]);
  vi.mocked(p.fetchMetrics).mockImplementation(async (_account, fromDate) =>
    fromDate! <= '2026-10-31'
      ? [
          {
            platformPostId: '123456789',
            views: 2000,
            metric: 'public_views',
            providerUpdatedAt: '2026-11-07T15:25:00Z',
            organicVerified: false,
          },
        ]
      : []
  );
  const d = await synchronizeAccount(f.data, f.accountId, p);
  expect(d.syncRuns[0].diagnostics?.newPosts).toBe(1);
  expect(d.syncRuns[0].diagnostics?.countersFetched).toBe(1);
  expect(d.snapshots).toHaveLength(1);
  expect(p.fetchMetrics).toHaveBeenCalledWith(
    'remote',
    '2026-10-31',
    expect.arrayContaining([expect.objectContaining({ platformPostId: '123456789' })])
  );
});
