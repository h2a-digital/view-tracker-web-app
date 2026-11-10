import type { DashboardData, Post } from './model';
import { trackingState, validateEvidence } from './tracking';
export type PostReview = {
  stage: 'tracking' | 'ready' | 'review' | 'historical' | 'excluded';
  label: string;
  reason: string;
  action: string;
};
/** Display-only discovery horizon for unassigned content, not an inferred compensation deadline. */
const unassignedHistoryAgeMs = 168 * 3600000;
function isUnassignedHistoricalImport(data: DashboardData, post: Post, now: string): boolean {
  if (post.campaign_id || post.app_id || post.rules || post.deadline) return false;
  const publication = Date.parse(post.published_at);
  const observations = [
    post.tracking?.firstSeenAt,
    post.tracking?.latestInWindow?.observedAt,
    ...data.snapshots.filter((s) => s.post_id === post.id).map((s) => s.observed_at),
  ]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value) && value >= publication && value <= Date.parse(now));
  // Do not manufacture discovery time from `now`, provider freshness, or the account's latest sync.
  // Earlier observations preserve the review path even if firstSeenAt was recorded on a later import.
  return (
    Number.isFinite(publication) &&
    observations.length > 0 &&
    observations.every((observedAt) => observedAt - publication > unassignedHistoryAgeMs)
  );
}
/** Presentation/work-queue states only. This never approves views or changes financial inputs. */
export function postReview(data: DashboardData, post: Post, now: string): PostReview {
  const state = trackingState(data, post, now);
  if (post.deleted || post.source_erased_at || post.eligibility_status === 'excluded')
    return {
      stage: 'excluded',
      label: 'Excluded',
      reason: post.review_note || 'Excluded from compensation. Historical records are retained.',
      action: 'No action required.',
    };
  const blocked = data.accounts.find((a) => a.id === post.account_id)?.integration?.payoutsBlocked;
  let verified = false;
  if (
    post.eligibility_status === 'accepted' &&
    post.eligible_views !== null &&
    post.deadline &&
    Date.parse(post.deadline) <= Date.parse(now) &&
    !blocked
  ) {
    try {
      validateEvidence(post, post.review_evidence ?? undefined);
      verified = true;
    } catch {
      /* Legacy/unverified acceptance is not displayed as payout-ready. */
    }
  }
  if (verified)
    return {
      stage: 'ready',
      label: 'Ready for payout',
      reason: 'The eligible total has been reviewed with organic and cutoff evidence.',
      action: 'Bonus approval and final payout approval remain required where configured.',
    };
  const unassignedHistory = isUnassignedHistoricalImport(data, post, now);
  if (
    (state.issues.includes('historical_window_missing') || unassignedHistory) &&
    post.eligibility_status !== 'accepted'
  )
    return {
      stage: 'historical',
      label: 'Historical',
      reason: unassignedHistory
        ? 'First recorded more than 168 hours after publication, without earlier tracking observations. No campaign or compensation window has been assigned; lifetime public views do not establish eligible organic views.'
        : 'Discovered after its tracking/follow-up window; lifetime views cannot reconstruct its eligible organic total.',
      action: unassignedHistory
        ? 'Retained for historical reporting; no operational review is required. It cannot earn compensation without explicit valid attribution and evidence-backed eligibility review.'
        : 'Exclude historical content from this program, or supply evidence for the original window. It remains unresolved for payouts until then.',
    };
  const review = (reason: string, action: string): PostReview => ({
    stage: 'review',
    label: 'Needs review',
    reason,
    action,
  });
  if (blocked)
    return review(
      'Provider policy restrictions prevent compensation.',
      'Resolve the integration policy restriction; do not approve public views.'
    );
  if (state.issues.includes('campaign_unassigned'))
    return review(
      'No campaign was attributed at publication.',
      'Assign a valid campaign before eligibility review.'
    );
  if (post.eligibility_status === 'accepted')
    return review(
      'The recorded acceptance has incomplete or invalid eligibility evidence.',
      'Review organic and cutoff evidence; finalized months require a linked correction.'
    );
  if (state.issues.includes('suspected_paid_promotion'))
    return review(
      'The provider flags suspected paid promotion.',
      'Review the promotion and provide a separate, supported organic total.'
    );
  if (state.issues.includes('not_a_short'))
    return review(
      'The provider identifies content that does not qualify as a Short.',
      'Verify the format and exclude non-qualifying content.'
    );
  if (state.status === 'active' || state.status === 'closing') {
    const lastCounter = state.lastCounterAt || state.firstSeenAt;
    if (
      Date.parse(now) - Date.parse(lastCounter) > 26 * 3600000 &&
      (state.lastError || !state.lastCounterAt)
    )
      return review(
        'Public counters have been missing or failing beyond the expected daily sampling interval.',
        'Check the account connection and sync diagnostics. Automatic retries continue.'
      );
    return {
      stage: 'tracking',
      label: 'Tracking',
      reason:
        state.status === 'closing'
          ? 'Checking delayed closing readings during the bounded follow-up period.'
          : 'Collecting observations during the configured eligibility window.',
      action:
        'Automatic sampling and retries continue. Public views are not verified organic views.',
    };
  }
  return review(
    'Collection has finished, but the exact in-window organic total is not verified.',
    state.issues.includes('shorts_classification_unverified')
      ? 'Confirm this is a Short and provide evidence for organic views and the original cutoff.'
      : 'Provide an analytics export or other auditable evidence for organic attribution and the exact window, or exclude the post.'
  );
}
