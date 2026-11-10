'use client';
import { useState } from 'react';
import Image from 'next/image';
import { Music2, Camera, Clapperboard, Globe, Play } from 'lucide-react';
import type { DashboardData, Post } from '@/domain/model';
import { postReview } from '@/domain/post-review';
import { usableThumbnail } from '@/domain/post-media';
import { Badge, date, number, Empty } from './Primitives';
function Thumbnail({ post, now }: { post: Post; now: number }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const src =
    !post.deleted && !post.source_erased_at
      ? usableThumbnail(post.tracking?.thumbnail, now)
      : undefined;
  const Icon = { tiktok: Music2, instagram: Camera, youtube: Clapperboard, facebook: Globe }[
    post.platform
  ];
  return (
    <div className={`post-thumbnail ${post.platform}`}>
      {src && failedUrl !== src ? (
        <Image
          src={src}
          alt=""
          fill
          unoptimized
          sizes="(max-width: 767px) 100vw, (max-width: 1279px) 50vw, 33vw"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(src)}
        />
      ) : (
        <div className="post-thumbnail-fallback">
          <Icon size={28} strokeWidth={1.5} />
          <span>{post.source_erased_at ? 'Source removed' : 'Preview unavailable'}</span>
        </div>
      )}
      <span className="post-play" aria-hidden="true">
        <Play size={16} fill="currentColor" />
      </span>
      <span className="post-platform">{post.platform}</span>
    </div>
  );
}
export function postPublicViews(data: DashboardData, post: Post): number | null {
  if (
    post.source_erased_at ||
    post.deleted ||
    data.accounts.find((a) => a.id === post.account_id)?.integration?.payoutsBlocked
  )
    return null;
  const latest = data.snapshots
    .filter(
      (s) =>
        s.post_id === post.id &&
        s.metric === 'public_views' &&
        s.provenance?.kind !== 'daily' &&
        !s.provenance?.supporting
    )
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
  return latest?.views ?? null;
}
export function PostGrid({
  data,
  posts,
  onOpen,
  now,
  compact = false,
}: {
  data: DashboardData;
  posts: Post[];
  onOpen: (post: Post) => void;
  now: number;
  compact?: boolean;
}) {
  if (!posts.length)
    return (
      <Empty
        title="No posts to show"
        description="Connect an account or adjust your campaign and search filters."
      />
    );
  return (
    <div className={`post-grid ${compact ? 'post-grid-compact' : ''}`}>
      {posts.map((post) => {
        const views = postPublicViews(data, post);
        const review = postReview(data, post, new Date(now).toISOString());
        const blocked = data.accounts.find((a) => a.id === post.account_id)?.integration
          ?.sourceErasedAt;
        const safePost = blocked ? { ...post, tracking: null } : post;
        return (
          <button
            type="button"
            className="post-card"
            key={post.id}
            onClick={() => onOpen(post)}
            aria-label={`View post details: ${post.caption || 'Untitled video'}`}
          >
            <Thumbnail key={safePost.tracking?.thumbnail?.capturedAt} post={safePost} now={now} />
            <div className="post-card-content">
              <h3>{post.caption || 'Untitled video'}</h3>
              <p className="post-creator">
                {data.creators.find((c) => c.id === post.creator_id)?.name || 'Unknown creator'}
              </p>
              <div className="post-card-meta">
                <time dateTime={post.published_at}>
                  {post.source_erased_at ? 'Source removed' : date(post.published_at)}
                </time>
                <Badge
                  tone={
                    review.stage === 'ready'
                      ? 'green'
                      : review.stage === 'review'
                        ? 'amber'
                        : 'neutral'
                  }
                >
                  {review.label}
                </Badge>
              </div>
              {!compact && ['review', 'historical'].includes(review.stage) && (
                <p className="post-stage-reason">{review.reason}</p>
              )}
              <div className="post-card-views">
                <strong>{views === null ? '—' : number(views)}</strong>
                <span>public views · unverified traffic</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
