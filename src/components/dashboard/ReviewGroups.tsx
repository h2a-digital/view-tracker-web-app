'use client';
import { useEffect, useState } from 'react';
import type { DashboardData } from '@/domain/model';
import { groupReviews, reviewCause, type ReviewGroup } from '@/domain/review-groups';
import { requestJson } from '@/lib/client/request';
import { AsyncButton } from './AsyncButton';
import { Pagination } from './Pagination';
import { date } from './Primitives';
type Row = { id: string; caption: string; published_at: string; platform: string };
function ExpandedIssue({
  group,
  data,
  appId,
  onPost,
}: {
  group: ReviewGroup;
  data: DashboardData;
  appId: string;
  onPost: (id: string) => void;
}) {
  const [page, setPage] = useState(1),
    [result, setResult] = useState<{
      key: string;
      posts: Row[];
      page: number;
      pageSize: number;
      total: number;
    } | null>(null),
    [error, setError] = useState('');
  const requestKey = JSON.stringify([appId, group.accountId, group.cause, page]);
  const remote = !!data.readModel,
    generation = data.readModel?.generatedAt;
  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController(),
      timeout = setTimeout(() => {
        controller.abort();
        setError('Issue request timed out. Refresh to retry.');
      }, 25000);
    requestJson<{ posts: Row[]; page: number; pageSize: number; total: number }>(
      `/api/review-groups?${new URLSearchParams({ app: appId, accountId: group.accountId, cause: group.cause, page: String(page) })}`,
      { signal: controller.signal }
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setResult({ ...value, key: requestKey });
          setError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [remote, appId, group.accountId, group.cause, page, generation, requestKey]);
  const local = data.posts
    .filter(
      (p) =>
        (appId === 'all' || p.app_id === appId) &&
        p.account_id === group.accountId &&
        reviewCause(data, p, new Date().toISOString()) === group.cause
    )
    .sort((a, b) => b.published_at.localeCompare(a.published_at) || b.id.localeCompare(a.id));
  const shown = remote
    ? result?.key === requestKey
      ? result
      : null
    : { posts: local.slice((page - 1) * 12, page * 12), page, pageSize: 12, total: local.length };
  return (
    <div className="expanded-issue">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {shown ? (
        <>
          <div className="issue-posts">
            {shown.posts.map((post) => (
              <div className="issue-post" key={post.id}>
                <div>
                  <strong>{post.caption || 'Untitled post'}</strong>
                  <small>
                    {post.platform} · {date(post.published_at)}
                  </small>
                </div>
                <AsyncButton className="button" onClick={() => onPost(post.id)}>
                  View post
                </AsyncButton>
              </div>
            ))}
          </div>
          <Pagination page={shown.page} pageSize={12} total={shown.total} onPage={setPage} />
        </>
      ) : (
        !error && <p role="status">Loading affected posts…</p>
      )}
    </div>
  );
}
export function ReviewGroups({
  data,
  appId,
  onPost,
  onRoute,
  onExclude,
}: {
  data: DashboardData;
  appId: string;
  onPost: (id: string) => void;
  onRoute: (accountId: string) => void;
  onExclude: (group: ReviewGroup) => Promise<void>;
}) {
  const [remoteGroups, setRemoteGroups] = useState<{ app: string; groups: ReviewGroup[] } | null>(
      null
    ),
    [expanded, setExpanded] = useState<string[]>([]),
    [error, setError] = useState('');
  const remote = !!data.readModel,
    generation = data.readModel?.generatedAt;
  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController(),
      timeout = setTimeout(() => {
        controller.abort();
        setError('Issue request timed out. Refresh to retry.');
      }, 25000);
    requestJson<{ groups: ReviewGroup[] }>(`/api/review-groups?app=${appId}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setRemoteGroups({ app: appId, groups: value.groups });
          setError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [remote, appId, generation]);
  const groups = remote
    ? remoteGroups?.app === appId
      ? remoteGroups.groups
      : []
    : groupReviews(data, appId);
  const operational = groups.filter((group) => group.cause !== 'historical');
  const historical = groups.filter((group) => group.cause === 'historical');
  const renderGroup = (group: ReviewGroup) => {
    const account = data.accounts.find((a) => a.id === group.accountId),
      open = expanded.includes(group.key);
    return (
      <article
        className={`issue-group ${group.cause === 'historical' ? 'issue-historical' : ''}`}
        key={group.key}
      >
        <div className="issue-group-heading">
          <div>
            <h3>
              {account?.platform === 'youtube'
                ? account.integration?.channelIdentity?.title || 'YouTube channel'
                : `@${account?.integration?.profileMetadata?.username || account?.username || 'Unknown account'}`}{' '}
              — {group.count} posts · {group.title.toLowerCase()}
            </h3>
            <p>{group.description}</p>
          </div>
          <div className="button-group">
            {group.cause === 'mapping' && (
              <AsyncButton className="button primary" onClick={() => onRoute(group.accountId)}>
                Route posts
              </AsyncButton>
            )}
            {['mapping', 'historical'].includes(group.cause) && (
              <AsyncButton className="button" onClick={() => onExclude(group)}>
                {group.cause === 'mapping'
                  ? 'Exclude imported content'
                  : 'Exclude historical posts'}
              </AsyncButton>
            )}
            <AsyncButton
              className="text-button"
              aria-expanded={open}
              onClick={() =>
                setExpanded((current) =>
                  open ? current.filter((k) => k !== group.key) : [...current, group.key]
                )
              }
            >
              {open ? 'Collapse' : 'Inspect posts'}
            </AsyncButton>
          </div>
        </div>
        {open && <ExpandedIssue group={group} data={data} appId={appId} onPost={onPost} />}
      </article>
    );
  };
  return (
    <section className="card">
      <div className="section-heading">
        <div>
          <h2>Grouped post issues</h2>
          <p>
            {operational.length} operational groups · {operational.reduce((n, g) => n + g.count, 0)}{' '}
            affected posts. Expand a group to inspect records.
          </p>
        </div>
      </div>
      {error && (
        <p className="form-error padded" role="alert">
          {error}
        </p>
      )}
      {!operational.length && (
        <p className="padded subtle">
          {remote && remoteGroups?.app !== appId
            ? 'Loading issue groups…'
            : 'No operational post issues in this app scope.'}
        </p>
      )}
      <div className="issue-groups">{operational.map(renderGroup)}</div>
      {historical.length > 0 && (
        <details className="history-panel">
          <summary>
            Historical records · {historical.reduce((n, group) => n + group.count, 0)} posts
          </summary>
          <p className="padded subtle">
            Retained for reporting, outside the operational review queue. Historical classification
            does not approve compensation or change attribution.
          </p>
          <div className="issue-groups">{historical.map(renderGroup)}</div>
        </details>
      )}
    </section>
  );
}
