import type { Post, TrackingState } from './model';
import { providerImageUrl } from '@/lib/provider-images';
export const thumbnailRetentionMs = 29 * 86400000;
export function usableThumbnail(
  thumbnail: TrackingState['thumbnail'],
  now: number
): string | undefined {
  if (
    !thumbnail ||
    !Number.isFinite(Date.parse(thumbnail.capturedAt)) ||
    Date.parse(thumbnail.capturedAt) > now ||
    now - Date.parse(thumbnail.capturedAt) >= thumbnailRetentionMs
  )
    return undefined;
  const url = providerImageUrl(thumbnail.url);
  if (!url) return undefined;
  // TikTok documents expiring, signed image URLs. Other providers may fail without an expiry hint.
  const expires = new URL(url).searchParams.get('x-expires');
  if (expires && /^\d+$/.test(expires) && Number(expires) * 1000 <= now) return undefined;
  return url;
}
/** Only visual metadata. No view reading, eligibility decision or financial input is changed. */
export function cacheThumbnail(post: Post, candidate: unknown, now: string) {
  if (
    post.source_erased_at ||
    post.deleted ||
    usableThumbnail(post.tracking?.thumbnail, Date.parse(now))
  )
    return;
  const url = providerImageUrl(candidate);
  if (!url) return; // Optional fields and temporary failures must not erase valid cached media.
  if (usableThumbnail({ url, capturedAt: now }, Date.parse(now))) {
    // synchronizeAccount always initializes the ordinary tracking state before caching.
    if (post.tracking) post.tracking.thumbnail = { url, capturedAt: now };
  }
}

/** A missing optional preview is not an urgent error; retry on the normal account schedule. */
export function thumbnailBackfillDue(post: Post, now: number): boolean {
  if (post.deleted || post.source_erased_at || usableThumbnail(post.tracking?.thumbnail, now))
    return false;
  const checked = Date.parse(post.tracking?.thumbnailCheckedAt || '');
  return !Number.isFinite(checked) || checked > now || now - checked >= 86400000;
}
