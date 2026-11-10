import type { DashboardData, Post } from './model';
import { postReview } from './post-review';
export type ReviewCause =
  | 'mapping'
  | 'historical'
  | 'policy'
  | 'promotion'
  | 'format'
  | 'evidence'
  | 'data';
export type ReviewGroup = {
  key: string;
  accountId: string;
  cause: ReviewCause;
  count: number;
  title: string;
  description: string;
};
const descriptions: Record<ReviewCause, [string, string]> = {
  mapping: [
    'Missing campaign attribution',
    'Connection grants tracking access. Routing determines future campaign attribution. No eligibility window is assumed for unmapped posts.',
  ],
  historical: [
    'Historical window unavailable',
    'Tracking began too late to establish original eligibility. Retained separately from operational reviews, without assigning a campaign or approving compensation.',
  ],
  policy: [
    'Provider policy restriction',
    'Resolve the account policy restriction before compensation review.',
  ],
  promotion: [
    'Suspected promotion',
    'Review a supported organic total separately from paid traffic.',
  ],
  format: ['Content format needs review', 'Verify eligible video format.'],
  evidence: [
    'Eligibility evidence needed',
    'Provide organic and exact-cutoff evidence or explicitly exclude content.',
  ],
  data: [
    'Tracking data needs attention',
    'Inspect account synchronization and data coverage; automatic retries continue.',
  ],
};
export function reviewCause(data: DashboardData, post: Post, now: string): ReviewCause | null {
  const review = postReview(data, post, now);
  if (['excluded', 'ready', 'tracking'].includes(review.stage)) return null;
  if (review.stage === 'historical') return 'historical';
  if (!post.campaign_id) return 'mapping';
  const account = data.accounts.find((a) => a.id === post.account_id);
  if (account?.integration?.payoutsBlocked) return 'policy';
  if (post.tracking?.isAd === true) return 'promotion';
  if (post.tracking?.contentType === 'other' || post.tracking?.contentType === 'shorts_candidate')
    return 'format';
  if (post.tracking?.lastError || !post.tracking?.lastCounterAt) return 'data';
  return 'evidence';
}
export function groupReviews(
  data: DashboardData,
  app = 'all',
  now = new Date().toISOString()
): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const post of data.posts) {
    if (app !== 'all' && post.app_id !== app) continue;
    const cause = reviewCause(data, post, now);
    if (!cause) continue;
    const key = `${post.account_id}:${cause}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else
      groups.set(key, {
        key,
        accountId: post.account_id,
        cause,
        count: 1,
        title: descriptions[cause][0],
        description: descriptions[cause][1],
      });
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.cause === 'historical' ? 1 : 0) - (b.cause === 'historical' ? 1 : 0) ||
      b.count - a.count ||
      a.key.localeCompare(b.key)
  );
}
