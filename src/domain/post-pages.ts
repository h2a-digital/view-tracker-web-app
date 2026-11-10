import { z } from 'zod';
import type { DashboardData, Post, Snapshot } from './model';
export const postPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce
    .number()
    .refine((v) => [12, 24, 48].includes(v))
    .default(24),
  app: z.union([z.uuid(), z.literal('all')]).default('all'),
  campaign: z.union([z.uuid(), z.literal('all')]).default('all'),
  search: z.string().trim().max(200).default(''),
  sort: z.enum(['newest', 'oldest', 'views']).default('newest'),
  postId: z.uuid().optional(),
});
export type PostPageQuery = z.infer<typeof postPageSchema>;
export type PostPage = {
  page: number;
  pageSize: number;
  total: number;
  posts: Post[];
  snapshots: Snapshot[];
};
export function paginatePosts(data: DashboardData, q: PostPageQuery): PostPage {
  const counts = new Map(
    data.posts.map((p) => [
      p.id,
      data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked ||
      p.deleted ||
      p.source_erased_at
        ? null
        : (data.snapshots
            .filter(
              (s) =>
                s.post_id === p.id &&
                s.metric === 'public_views' &&
                s.provenance?.kind !== 'daily' &&
                !s.provenance?.supporting
            )
            .sort(
              (a, b) => b.observed_at.localeCompare(a.observed_at) || b.id.localeCompare(a.id)
            )[0]?.views ?? null),
    ])
  );
  const rows = data.posts
    .filter(
      (p) =>
        (q.app === 'all' || p.app_id === q.app) &&
        (q.campaign === 'all' || p.campaign_id === q.campaign) &&
        (!q.postId || p.id === q.postId) &&
        (!q.search ||
          `${p.caption} ${p.platform} ${p.platform_post_id} ${data.creators.find((c) => c.id === p.creator_id)?.name || ''}`
            .toLowerCase()
            .includes(q.search.toLowerCase()))
    )
    .sort(
      (a, b) =>
        (q.sort === 'views' ? (counts.get(b.id) ?? -1) - (counts.get(a.id) ?? -1) : 0) ||
        (q.sort === 'oldest'
          ? a.published_at.localeCompare(b.published_at)
          : b.published_at.localeCompare(a.published_at)) ||
        b.id.localeCompare(a.id)
    );
  const page = Math.max(1, Math.min(q.page, Math.ceil(rows.length / q.pageSize))),
    posts = rows.slice((page - 1) * q.pageSize, page * q.pageSize),
    ids = new Set(posts.map((p) => p.id));
  return {
    page,
    pageSize: q.pageSize,
    total: rows.length,
    posts,
    snapshots: data.snapshots.filter((s) => ids.has(s.post_id)),
  };
}
