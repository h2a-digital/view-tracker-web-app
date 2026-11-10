import 'server-only';
import type { DashboardData, SocialAccount } from '@/domain/model';
import type { TrackingProvider } from './provider';
import { cacheThumbnail, usableThumbnail } from '@/domain/post-media';
import type { ThumbnailOverride } from '@/domain/thumbnail-overrides';
import { trackingState } from '@/domain/tracking';
/** Separate from synchronizeAccount: never fetch counters, discover posts, generate drafts or run lifecycle jobs. */
export async function loadMissingThumbnails(
  initial: DashboardData,
  account: SocialAccount,
  provider: TrackingProvider
) {
  if (!provider.fetchThumbnails)
    throw new Error('Preview refresh is unavailable for this provider.');
  const now = Date.now();
  const targets = initial.posts
    .filter(
      (p) =>
        p.account_id === account.id &&
        !p.deleted &&
        !p.source_erased_at &&
        !usableThumbnail(p.tracking?.thumbnail, now)
    )
    .slice(0, 50);
  if (!targets.length)
    return { overrides: [] as ThumbnailOverride[], requested: 0, unavailable: 0, deferred: false };
  const media = await provider.fetchThumbnails(
    account.provider_account_id!,
    targets.map((p) => ({
      platformPostId: p.platform_post_id,
      publishedAt: p.published_at,
      deadline: p.deadline,
    }))
  );
  if (media === null)
    return {
      overrides: [] as ThumbnailOverride[],
      requested: targets.length,
      unavailable: 0,
      deferred: true,
    };
  const capturedAt = new Date().toISOString();
  const overrides: ThumbnailOverride[] = [];
  for (const post of targets) {
    const copy = {
      ...post,
      tracking: { ...(post.tracking ?? trackingState(initial, post, capturedAt)) },
    };
    cacheThumbnail(
      copy,
      media.find((m) => m.platformPostId === post.platform_post_id)?.thumbnailUrl,
      capturedAt
    );
    if (copy.tracking.thumbnail && usableThumbnail(copy.tracking.thumbnail, Date.parse(capturedAt)))
      overrides.push({
        postId: post.id,
        accountId: account.id,
        platformPostId: post.platform_post_id,
        providerAccountId: account.provider_account_id!,
        thumbnail: copy.tracking.thumbnail,
      });
  }
  return {
    overrides,
    requested: targets.length,
    unavailable: targets.length - overrides.length,
    deferred: false,
  };
}
