'use client';
import { useEffect, useState } from 'react';
import type { DashboardData, Post } from '@/domain/model';
import { paginatePosts, type PostPage, type PostPageQuery } from '@/domain/post-pages';
import { requestJson } from '@/lib/client/request';
import { withThumbnailOverrides, type ThumbnailOverride } from '@/domain/thumbnail-overrides';
import { PostGrid } from './PostGrid';
import { PostTable } from './PostTable';
import { Pagination } from './Pagination';
export function PagedPosts({
  data,
  query,
  view,
  onPage,
  onSize,
  onOpen,
  overrides,
  now: displayNow,
}: {
  data: DashboardData;
  query: PostPageQuery;
  view: 'grid' | 'table';
  onPage: (p: number) => void;
  onSize: (size: number) => void;
  onOpen: (p: Post) => void;
  overrides: ThumbnailOverride[];
  now: number;
}) {
  const [result, setResult] = useState<{ key: string; page: PostPage; asOf: string } | null>(null),
    [error, setError] = useState('');
  const remote = !!data.readModel,
    key = JSON.stringify(query),
    generation = data.readModel?.generatedAt;
  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    requestJson<PostPage & { asOf: string }>(
      `/api/posts?${new URLSearchParams(Object.entries(JSON.parse(key) as Record<string, string>).map(([k, v]) => [k, String(v)]))}`,
      { signal: controller.signal }
    )
      .then((page) => {
        if (!controller.signal.aborted) {
          setResult({ key, page, asOf: page.asOf });
          setError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
        else if (!controller.signal.reason?.message?.includes('unmount'))
          setError('Posts request timed out. Refresh to retry.');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort(new Error('unmount'));
      clearTimeout(timeout);
    };
  }, [remote, key, generation]);
  const page = remote ? (result?.key === key ? result.page : null) : paginatePosts(data, query),
    now = result ? Date.parse(result.asOf) : displayNow;
  if (!page)
    return (
      <div className="padded" role={error ? 'alert' : 'status'}>
        {error || 'Loading posts…'}
      </div>
    );
  const scoped = withThumbnailOverrides(
    { ...data, posts: page.posts, snapshots: page.snapshots },
    overrides,
    now
  );
  return (
    <>
      {error && (
        <p role="alert" className="form-error padded">
          {error}
        </p>
      )}
      {view === 'grid' ? (
        <PostGrid data={scoped} posts={scoped.posts} now={now} onOpen={onOpen} />
      ) : (
        <PostTable data={scoped} posts={scoped.posts} now={now} onOpen={onOpen} />
      )}
      <Pagination
        page={page.page}
        pageSize={page.pageSize}
        total={page.total}
        onPage={onPage}
        onSize={onSize}
      />
    </>
  );
}
