import type { DashboardData } from './model';
import { performanceReport } from './analytics';
import { postReview } from './post-review';
import { calculateProvisional, calculateStatement } from './compensation';
import { groupReviews } from './review-groups';
export function overviewSummary(data: DashboardData, appId: string, query: string, now: number) {
  const report = performanceReport(data, { app: appId });
  const nowIso = new Date(now).toISOString();
  const scope = data.posts.filter((p) => appId === 'all' || p.app_id === appId);

  const historical = scope.filter((p) => postReview(data, p, nowIso).stage === 'historical');
  const active = data.creators.filter(
    (c) =>
      !c.archived &&
      data.memberships.some(
        (m) =>
          m.creator_id === c.id &&
          Date.parse(m.starts_at) <= now &&
          (!m.ends_at || Date.parse(m.ends_at) > now) &&
          data.campaigns.some(
            (campaign) =>
              campaign.id === m.campaign_id &&
              campaign.status === 'active' &&
              (appId === 'all' || campaign.app_id === appId) &&
              !data.apps.find((a) => a.id === campaign.app_id)?.archived
          )
      )
  );
  const statements = data.statements.filter((s) => appId === 'all' || s.app_id === appId);
  const approved = statements
    .filter((s) => s.status === 'finalized')
    .reduce((n, s) => n + s.payable_cents, 0);
  const visibleRows = report.rows.filter(
    (r) =>
      !query ||
      `${r.post.caption} ${r.post.platform} ${r.post.platform_post_id} ${data.creators.find((c) => c.id === r.post.creator_id)?.name || ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
  );
  const ranked = [...new Set(visibleRows.map((r) => r.post.creator_id))]
    .map((id) => {
      const rows = visibleRows.filter((r) => r.post.creator_id === id);
      return {
        id,
        name: data.creators.find((c) => c.id === id)?.name || 'Unknown creator',
        views: rows.reduce((n, r) => n + (r.publicViews ?? 0), 0),
        observed: rows.filter((r) => r.publicViews !== null).length,
        posts: rows.length,
      };
    })
    .filter((c) => c.observed > 0)
    .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name))
    .slice(0, 3);
  const platformRows = [...new Set(visibleRows.map((r) => r.post.platform))]
    .map((platform) => {
      const rows = visibleRows.filter((r) => r.post.platform === platform);
      return {
        platform,
        views: rows.reduce((total, row) => total + (row.publicViews ?? 0), 0),
        observed: rows.filter((r) => r.publicViews !== null).length,
        posts: rows.length,
      };
    })
    .sort((a, b) => b.views - a.views || a.platform.localeCompare(b.platform));
  const platformTotal = platformRows.reduce((sum, row) => sum + row.views, 0);
  const recent = [...visibleRows]
    .sort((a, b) => b.post.published_at.localeCompare(a.post.published_at))
    .slice(0, 3)
    .map((r) => r.post);
  return {
    report: {
      publicViews: report.publicViews,
      observed: report.observed,
      postCount: report.rows.length,
    },
    reviews: groupReviews(data, appId, nowIso).filter((g) => g.cause !== 'historical').length,
    historical: historical.length,
    active: active.length,
    approved,
    ranked,
    recent,
    recentSnapshots: data.snapshots.filter((s) => recent.some((p) => p.id === s.post_id)),
    platformRows,
    platformTotal,
  };
}
export type DashboardReadModel = {
  generatedAt: string;
  overview: Record<string, ReturnType<typeof overviewSummary>>;
  counts: Record<string, { posts: number; eligibleViews: number }>;
  groups: ReturnType<typeof groupReviews>;
  statementResults: Record<
    string,
    {
      provisional: ReturnType<typeof calculateProvisional>;
      calculation: ReturnType<typeof calculateStatement>;
    }
  >;
};
/** Browser-only projection. Full data remains exclusively on the server for writes and calculations. */
export function browserDashboard(data: DashboardData): DashboardData {
  const now = new Date().toISOString(),
    overview: DashboardReadModel['overview'] = {},
    counts: DashboardReadModel['counts'] = {};
  for (const scope of ['all', ...data.apps.map((a) => a.id)])
    overview[scope] = overviewSummary(data, scope, '', Date.parse(now));
  for (const post of data.posts)
    for (const key of [
      `account:${post.account_id}`,
      `app:${post.app_id}`,
      `creator:${post.creator_id}`,
      `creator:${post.creator_id}:${post.app_id}`,
    ]) {
      counts[key] ??= { posts: 0, eligibleViews: 0 };
      counts[key].posts++;
      counts[key].eligibleViews += post.eligible_views ?? 0;
    }
  const statementResults: DashboardReadModel['statementResults'] = {};
  for (const s of data.statements) {
    const provisional = calculateProvisional(data, s.app_id, s.creator_id, s.month, s.policy),
      calculation = calculateStatement(
        data,
        s.app_id,
        s.creator_id,
        s.month,
        s.policy,
        s.approved_bonus_cents
      );
    statementResults[s.id] = {
      provisional: { ...provisional, lines: [], fingerprint: '' },
      calculation: { ...calculation, lines: [], fingerprint: '' },
    };
  }
  const recent = overview.all.recent,
    ids = new Set(recent.map((p) => p.id));
  // Only one public snapshot per recent card. Other post histories are read lazily by page/detail.
  const snapshots = recent.flatMap((post) =>
    data.snapshots
      .filter(
        (s) =>
          s.post_id === post.id &&
          s.metric === 'public_views' &&
          s.provenance?.kind !== 'daily' &&
          !s.provenance?.supporting
      )
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, 1)
  );
  const readModel: DashboardReadModel = {
    generatedAt: now,
    overview,
    counts,
    groups: groupReviews(data, 'all', now),
    statementResults,
  };
  return {
    ...data,
    statements: data.statements.map((s) => ({ ...s, fingerprint: '' })),
    posts: data.posts.filter((p) => ids.has(p.id)),
    snapshots,
    audit: data.audit.slice(0, 15),
    syncRuns: data.syncRuns.slice(0, 20),
    readModel,
  };
}
