import type { DashboardData, Post } from './model';
export type AnalyticsFilters = {
  app?: string;
  campaign?: string;
  creator?: string;
  platform?: string;
  start?: string;
  end?: string;
};
export function accountingDay(timestamp: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
export function performanceReport(data: DashboardData, filters: AnalyticsFilters = {}) {
  const end = filters.end || accountingDay(new Date().toISOString());
  const candidates = data.posts.filter(
    (p) =>
      !p.deleted &&
      !p.source_erased_at &&
      !data.accounts.find((a) => a.id === p.account_id)?.integration?.sourceErasedAt
  );
  // A platform video is one publication even if duplicated through account/provider registrations.
  // Conflicting attribution is omitted rather than choosing a campaign arbitrarily.
  const grouped = new Map<string, Post[]>();
  for (const p of candidates) {
    const key = `${p.platform}:${p.platform_post_id}`;
    grouped.set(key, [...(grouped.get(key) || []), p]);
  }
  let conflicts = 0;
  const posts = [...grouped.values()]
    .flatMap((group) => {
      if (new Set(group.map((p) => `${p.app_id}:${p.campaign_id}:${p.creator_id}`)).size > 1) {
        conflicts++;
        return [];
      }
      return [group[0]];
    })
    .filter(
      (p) =>
        (!filters.app || filters.app === 'all' || p.app_id === filters.app) &&
        (!filters.campaign || filters.campaign === 'all' || p.campaign_id === filters.campaign) &&
        (!filters.creator || filters.creator === 'all' || p.creator_id === filters.creator) &&
        (!filters.platform || filters.platform === 'all' || p.platform === filters.platform) &&
        (!filters.start || accountingDay(p.published_at) >= filters.start) &&
        accountingDay(p.published_at) <= end
    );
  const rows = posts.map((post) => {
    const aliases = grouped.get(`${post.platform}:${post.platform_post_id}`)!;
    const ids = new Set(aliases.map((p) => p.id));
    const blocked = aliases.some(
      (p) => data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked
    );
    const latest = data.snapshots
      .filter(
        (s) =>
          ids.has(s.post_id) &&
          s.metric === 'public_views' &&
          s.provenance?.kind !== 'daily' &&
          !s.provenance?.supporting &&
          accountingDay(s.observed_at) <= end
      )
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
    const accepted =
      post.eligibility_status === 'accepted' &&
      !blocked &&
      post.review_evidence?.organicConfirmed &&
      post.review_evidence?.cutoffConfirmed;
    // No historical eligible total if approval was recorded after the selected reporting endpoint.
    const eligible =
      accepted && post.accepted_at && accountingDay(post.accepted_at) <= end
        ? post.eligible_views
        : null;
    return {
      post,
      blocked: Boolean(blocked),
      publicViews: !blocked && latest ? latest.views : null,
      observedAt: latest?.observed_at,
      eligibleViews: eligible,
      day: accountingDay(post.published_at),
    };
  });
  return {
    rows,
    conflicts,
    publicViews: rows.reduce((n, r) => n + (r.publicViews ?? 0), 0),
    eligibleViews: rows.reduce((n, r) => n + (r.eligibleViews ?? 0), 0),
    observed: rows.filter((r) => r.publicViews !== null).length,
    verified: rows.filter((r) => r.eligibleViews !== null).length,
  };
}
export function financialReport(data: DashboardData, filters: AnalyticsFilters = {}) {
  // Caps, approvals and tier allocations span campaigns/platforms. Never prorate these totals.
  if (
    (filters.campaign && filters.campaign !== 'all') ||
    (filters.platform && filters.platform !== 'all')
  )
    return [];
  const end = filters.end || accountingDay(new Date().toISOString());
  return data.statements
    .filter(
      (s) =>
        s.status !== 'draft' &&
        (!filters.app || filters.app === 'all' || s.app_id === filters.app) &&
        (!filters.creator || filters.creator === 'all' || s.creator_id === filters.creator)
    )
    .filter((s) => {
      const [y, m] = s.month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return (!filters.start || `${s.month}-01` >= filters.start) && `${s.month}-${last}` <= end;
    })
    .map((s) => {
      const adjustments = data.adjustments.filter(
        (a) => a.statement_id === s.id && ['approved', 'paid'].includes(a.status)
      );
      const cents = s.payable_cents + adjustments.reduce((n, a) => n + a.proposed_cents, 0);
      const views = s.lines.reduce((n, l) => n + (l.views ?? 0), 0);
      const blocked = data.accounts.some(
        (a) => a.creator_id === s.creator_id && a.integration?.payoutsBlocked
      );
      // Redacted evidence or corrections invalidate the original view denominator for reporting.
      const denominatorValid =
        !s.source_redacted_at &&
        !blocked &&
        adjustments.length === 0 &&
        s.lines.every((l) => l.views !== null) &&
        views > 0;
      return {
        statement: s,
        cents,
        views: denominatorValid ? views : null,
        effectiveCpm: denominatorValid ? (cents / 100 / views) * 1000 : null,
      };
    });
}

/** Observed cumulative totals for the selected publication cohort, never daily gained views. */
export function observationTrend(data: DashboardData, filters: AnalyticsFilters = {}) {
  const report = performanceReport(data, filters);
  const end = filters.end || accountingDay(new Date().toISOString());
  const identities = new Map(
    report.rows.map((r) => [`${r.post.platform}:${r.post.platform_post_id}`, r])
  );
  const postKeys = new Map(
    data.posts
      .filter(
        (p) =>
          !p.deleted &&
          !p.source_erased_at &&
          !data.accounts.find((a) => a.id === p.account_id)?.integration?.sourceErasedAt
      )
      .map((p) => [p.id, `${p.platform}:${p.platform_post_id}`])
  );
  const events = data.snapshots
    .filter((s) => {
      const key = postKeys.get(s.post_id);
      return (
        key &&
        identities.has(key) &&
        s.metric === 'public_views' &&
        s.provenance?.kind !== 'daily' &&
        !s.provenance?.supporting &&
        accountingDay(s.observed_at) <= end &&
        !identities.get(key)!.blocked
      );
    })
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const counts = new Map<string, number>();
  const days = new Map<string, { day: string; views: number; observed: number }>();
  let total = 0;
  for (const event of events) {
    const key = postKeys.get(event.post_id)!;
    total += event.views - (counts.get(key) ?? 0);
    counts.set(key, event.views);
    const day = accountingDay(event.observed_at);
    if (!filters.start || day >= filters.start)
      days.set(day, { day, views: total, observed: counts.size });
  }
  return [...days.values()];
}

export function analyticsSummary(data: DashboardData, filters: AnalyticsFilters = {}) {
  const report = performanceReport(data, filters);
  const groups = (by: 'creator' | 'platform') =>
    [
      ...new Set(report.rows.map((r) => (by === 'creator' ? r.post.creator_id : r.post.platform))),
    ].map((id) => {
      const rows = report.rows.filter(
        (r) => (by === 'creator' ? r.post.creator_id : r.post.platform) === id
      );
      return {
        id,
        name:
          by === 'creator' ? data.creators.find((c) => c.id === id)?.name || 'Unknown creator' : id,
        posts: rows.length,
        public: rows.reduce((n, r) => n + (r.publicViews ?? 0), 0),
        eligible: rows.reduce((n, r) => n + (r.eligibleViews ?? 0), 0),
        observed: rows.filter((r) => r.publicViews !== null).length,
      };
    });
  return {
    report: {
      publicViews: report.publicViews,
      eligibleViews: report.eligibleViews,
      observed: report.observed,
      verified: report.verified,
      conflicts: report.conflicts,
      postCount: report.rows.length,
    },
    creators: groups('creator'),
    platforms: groups('platform'),
    days: observationTrend(data, filters),
    financial: financialReport(data, filters).map((row) => ({
      ...row,
      statement: {
        id: row.statement.id,
        app_id: row.statement.app_id,
        creator_id: row.statement.creator_id,
        month: row.statement.month,
        status: row.statement.status,
      },
    })),
  };
}
