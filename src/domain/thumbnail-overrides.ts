import type { DashboardData, TrackingState } from './model';
import { usableThumbnail } from './post-media';
import { trackingState } from './tracking';
export type ThumbnailOverride = {
  postId: string;
  accountId: string;
  platformPostId: string;
  providerAccountId: string;
  thumbnail: NonNullable<TrackingState['thumbnail']>;
};
/** A local, in-memory preview overlay. Revalidate identity/source state after every dashboard refresh. */
export function withThumbnailOverrides(
  data: DashboardData,
  overrides: ThumbnailOverride[],
  now: number
): DashboardData {
  if (!overrides.length) return data;
  const byPost = new Map(overrides.map((value) => [value.postId, value]));
  return {
    ...data,
    posts: data.posts.map((post) => {
      const value = byPost.get(post.id);
      const account = data.accounts.find((a) => a.id === post.account_id);
      if (
        !value ||
        post.deleted ||
        post.source_erased_at ||
        !account ||
        account.archived ||
        account.status !== 'connected' ||
        account.integration?.sourceErasedAt ||
        account.provider !== 'zernio' ||
        value.accountId !== account.id ||
        value.platformPostId !== post.platform_post_id ||
        value.providerAccountId !== account.provider_account_id ||
        !usableThumbnail(value.thumbnail, now) ||
        usableThumbnail(post.tracking?.thumbnail, now)
      )
        return post;
      return {
        ...post,
        tracking: {
          ...(post.tracking ?? trackingState(data, post, new Date(now).toISOString())),
          thumbnail: value.thumbnail,
        },
      };
    }),
  };
}
/** New data can be newer than page-mount time. Use the confirmed server time, not the mount clock. */
export function workspaceDisplayTime(previous: number, receivedAt: number, asOf?: string): number {
  const serverTime = Date.parse(asOf || '');
  return Math.max(previous, receivedAt, Number.isFinite(serverTime) ? serverTime : 0);
}
