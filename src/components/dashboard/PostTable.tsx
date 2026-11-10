'use client';
import type { DashboardData, Post } from '@/domain/model';
import { postReview } from '@/domain/post-review';
import { postPublicViews } from './PostGrid';
import { Badge, date, number } from './Primitives';
export function PostTable({
  data,
  posts,
  now,
  onOpen,
}: {
  data: DashboardData;
  posts: Post[];
  now: number;
  onOpen: (post: Post) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Post / campaign</th>
            <th>Creator</th>
            <th>Public views</th>
            <th>Eligible views</th>
            <th>Status</th>
            <th>Published</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => {
            const review = postReview(data, p, new Date(now).toISOString()),
              views = postPublicViews(data, p);
            return (
              <tr key={p.id}>
                <td>
                  <button className="table-post-link" onClick={() => onOpen(p)}>
                    {p.caption || 'Untitled post'}
                  </button>
                  <small>
                    {data.campaigns.find((c) => c.id === p.campaign_id)?.name || 'Unassigned'}
                  </small>
                </td>
                <td>
                  {data.creators.find((c) => c.id === p.creator_id)?.name || 'Unknown creator'}
                </td>
                <td>{views === null ? '—' : number(views)}</td>
                <td>{p.eligible_views === null ? '—' : number(p.eligible_views)}</td>
                <td>
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
                </td>
                <td>{p.source_erased_at ? 'Source erased' : date(p.published_at)}</td>
              </tr>
            );
          })}
          {!posts.length && (
            <tr>
              <td colSpan={6}>No matching posts.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
