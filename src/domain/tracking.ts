import type { DashboardData, Post, Snapshot, TrackingState, ReviewEvidence } from './model';
export const closingGraceHours = 24;
export const freshnessHours = 2;
const hour = 3600000;
export function inWindow(post: Post, s: Snapshot) {
  return (
    s.metric !== 'paid_views' &&
    s.provenance?.kind !== 'daily' &&
    !s.provenance?.supporting &&
    !!post.deadline &&
    s.observed_at >= post.published_at &&
    s.observed_at <= post.deadline &&
    ((!!s.provider_updated_at &&
      s.provider_updated_at >= post.published_at &&
      s.provider_updated_at <= post.deadline) ||
      (!s.provider_updated_at && s.provenance?.kind === 'cumulative'))
  );
}
export function provisionalViews(data: DashboardData, post: Post) {
  if (data.accounts.find((a) => a.id === post.account_id)?.integration?.payoutsBlocked) return 0;
  if (post.tracking?.contentType === 'other') return 0;
  if (post.tracking?.contentType === 'shorts_candidate' && post.eligibility_status !== 'accepted')
    return 0;
  if (post.eligibility_status === 'excluded') return 0;
  if (post.eligibility_status === 'accepted') return post.eligible_views ?? 0;
  const observations = data.snapshots
    .filter((s) => s.post_id === post.id && inWindow(post, s))
    .map((s) => ({
      views: s.views,
      providerAt: s.provider_updated_at ?? s.observed_at,
      observedAt: s.observed_at,
    }));
  const cached = post.tracking?.latestInWindow;
  if (
    cached &&
    post.deadline &&
    cached.observedAt >= post.published_at &&
    cached.observedAt <= post.deadline &&
    cached.providerAt >= post.published_at &&
    cached.providerAt <= post.deadline
  )
    observations.push(cached);
  return (
    observations.sort(
      (a, b) => b.providerAt.localeCompare(a.providerAt) || b.observedAt.localeCompare(a.observedAt)
    )[0]?.views ?? 0
  );
}
export function trackingState(data: DashboardData, post: Post, now: string): TrackingState {
  const snapshots = data.snapshots
    .filter(
      (s) =>
        s.post_id === post.id &&
        s.source === 'api' &&
        s.metric !== 'paid_views' &&
        s.provenance?.kind !== 'daily' &&
        !s.provenance?.supporting
    )
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const prior = post.tracking;
  const firstSeenAt = prior?.firstSeenAt ?? snapshots[0]?.observed_at ?? now;
  const latest = snapshots.at(-1);
  const deadline = post.deadline;
  const counterAt =
    prior?.lastCounterAt && (!latest || prior.lastCounterAt >= latest.observed_at)
      ? prior.lastCounterAt
      : (latest?.observed_at ?? null);
  const providerAt =
    counterAt === prior?.lastCounterAt
      ? (prior?.lastProviderAt ?? null)
      : (latest?.provider_updated_at ?? null);
  const followupUntil = deadline
    ? new Date(
        new Date(deadline).getTime() +
          (data.accounts.find((a) => a.id === post.account_id)?.provider === 'direct'
            ? 72
            : closingGraceHours) *
            hour
      ).toISOString()
    : null;
  const issues: string[] = [];
  if (data.accounts.find((a) => a.id === post.account_id)?.integration?.payoutsBlocked)
    issues.push('provider_policy_blocked');
  if (prior?.contentType === 'shorts_candidate') issues.push('shorts_classification_unverified');
  if (prior?.contentType === 'other') issues.push('not_a_short');
  if (!post.campaign_id) issues.push('campaign_unassigned');
  const isHistorical = !!followupUntil && firstSeenAt > followupUntil;
  if (isHistorical) issues.push('historical_window_missing');
  if (!counterAt) issues.push('counter_missing');
  else if (!providerAt) issues.push('provider_time_unknown');
  else if (
    (!deadline || now < deadline || !prior || prior.status === 'closing') &&
    new Date(now).getTime() - new Date(providerAt!).getTime() > freshnessHours * hour
  )
    issues.push('provider_stale');
  const exact = post.eligibility_status === 'accepted' && !!post.review_evidence?.cutoffConfirmed;
  const freshClosing =
    !!deadline &&
    snapshots.some(
      (s) =>
        !!s.provider_updated_at &&
        s.provider_updated_at >= deadline &&
        s.observed_at >= deadline &&
        new Date(s.observed_at).getTime() - new Date(s.provider_updated_at).getTime() <=
          freshnessHours * hour
    );
  let status: TrackingState['status'] = 'active';
  if (deadline && now >= deadline) {
    status = isHistorical
      ? 'review'
      : freshClosing
        ? 'complete'
        : followupUntil && now < followupUntil && !isHistorical
          ? 'closing'
          : 'review';
    if (!exact) issues.push('cutoff_uncertain');
    if (!freshClosing) issues.push('closing_reading_missing');
  }
  if (post.eligibility_status !== 'accepted' && post.eligibility_status !== 'excluded')
    issues.push('organic_unverified');
  if (post.eligibility_status === 'accepted' && !post.review_evidence)
    issues.push('evidence_missing');
  if (prior?.lastError) issues.push('refresh_failed');
  return {
    contentType: prior?.contentType,
    status,
    issues,
    firstSeenAt,
    lastViews: prior?.lastViews ?? latest?.views ?? null,
    latestInWindow: prior?.latestInWindow ?? null,
    lastAttemptAt: prior?.lastAttemptAt ?? null,
    lastCounterAt: counterAt,
    lastProviderAt: providerAt,
    lastError: prior?.lastError ?? null,
    followupUntil,
    provisionalViews: provisionalViews(data, post),
    cutoffVerified: exact,
  };
}
export function needsMetricPolling(state: TrackingState) {
  return state.status === 'active' || state.status === 'closing';
}
export function validateEvidence(post: Post, evidence: ReviewEvidence | undefined) {
  if (post.tracking?.contentType === 'other')
    throw new Error('Analytics identifies this video as non-Shorts content.');
  if (post.tracking?.contentType === 'shorts_candidate' && !evidence?.shortsConfirmed)
    throw new Error('Confirm this candidate is actually a YouTube Short using auditable evidence.');
  if (
    !evidence ||
    evidence.reference.trim().length < 10 ||
    !evidence.organicConfirmed ||
    !evidence.cutoffConfirmed
  )
    throw new Error(
      'Evidence must verify organic attribution and the exact eligibility window. Provide an analytics export or other auditable reference.'
    );
  if (evidence.windowStart !== post.published_at || evidence.windowEnd !== post.deadline)
    throw new Error(
      'Evidence coverage must match the original publication time and eligibility deadline exactly.'
    );
}
export function metricSamplingDecision(
  data: DashboardData,
  post: Post,
  now: string,
  providerAt: string | null,
  views: number
): string | null {
  const previous = data.snapshots
    .filter(
      (s) =>
        s.post_id === post.id &&
        s.source === 'api' &&
        s.metric !== 'paid_views' &&
        s.provenance?.kind !== 'daily' &&
        !s.provenance?.supporting
    )
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at))
    .at(-1);
  const state = trackingState(data, post, now);
  if (previous && !needsMetricPolling(state)) return 'tracking_finished';
  if (!previous) return null;
  const age = new Date(now).getTime() - new Date(previous.observed_at).getTime();
  const closing = !!post.deadline && now >= post.deadline;
  const near =
    !!post.deadline && new Date(post.deadline).getTime() - new Date(now).getTime() <= 6 * hour;
  const changed = providerAt !== previous.provider_updated_at || views !== previous.views;
  if (closing) {
    if (!changed && age < 24 * hour) return 'unchanged_closing';
    return null;
  }
  if (age >= 24 * hour) return null;
  if (!near || age < hour) return 'sampling_interval';
  return changed ? null : 'unchanged';
}
