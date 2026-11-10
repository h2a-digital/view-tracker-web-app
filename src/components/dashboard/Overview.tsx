'use client';
import { useEffect, useState } from 'react';
import { requestJson } from '@/lib/client/request';
import type { DashboardData, Post } from '@/domain/model';
import { overviewSummary } from '@/domain/read-model';
import { PostGrid } from './PostGrid';
import { Avatar, Money, number } from './Primitives';
import { AsyncButton } from './AsyncButton';
import {
  ArrowUpRight,
  Clapperboard,
  Users,
  ClipboardCheck,
  Wallet,
  Music2,
  Camera,
  Globe,
} from 'lucide-react';
export function Overview({
  data,
  appId,
  query = '',
  now,
  onNavigate,
  onOpenPost,
}: {
  data: DashboardData;
  appId: string;
  query?: string;
  now: number;
  onNavigate: (view: string) => void;
  onOpenPost: (post: Post) => void;
}) {
  const [searched, setSearched] = useState<{
      key: string;
      summary: ReturnType<typeof overviewSummary>;
    } | null>(null),
    [searchError, setSearchError] = useState('');
  const searchKey = JSON.stringify([appId, query]),
    remote = !!data.readModel,
    generation = data.readModel?.generatedAt;
  useEffect(() => {
    if (!remote || !query) return;
    const controller = new AbortController(),
      timeout = setTimeout(() => {
        controller.abort();
        setSearchError('Overview request timed out. Refresh to retry.');
      }, 25000),
      timer = setTimeout(() => {
        requestJson<{ summary: ReturnType<typeof overviewSummary> }>(
          `/api/overview?${new URLSearchParams({ app: appId, search: query })}`,
          { signal: controller.signal }
        )
          .then((value) => {
            if (!controller.signal.aborted) {
              setSearched({ key: searchKey, summary: value.summary });
              setSearchError('');
            }
          })
          .catch((e) => {
            if (!controller.signal.aborted) setSearchError(e.message);
          })
          .finally(() => clearTimeout(timeout));
      }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(timeout);
    };
  }, [remote, searchKey, appId, query, generation]);
  const base = data.readModel?.overview[appId];
  const summary =
    remote && query
      ? searched?.key === searchKey
        ? searched.summary
        : { ...base!, ranked: [], recent: [], platformRows: [] }
      : (base ?? overviewSummary(data, appId, query, now));
  const {
    report,
    reviews,
    historical,
    active,
    approved,
    ranked,
    recent,
    platformRows,
    platformTotal,
  } = summary;
  const platformNames = {
    tiktok: 'TikTok',
    instagram: 'Instagram',
    youtube: 'YouTube',
    facebook: 'Facebook',
  };
  const platformIcons = {
    tiktok: Music2,
    instagram: Camera,
    youtube: Clapperboard,
    facebook: Globe,
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Overview</h1>
          <p>Your creator partnerships, without the noise.</p>
        </div>
        <AsyncButton className="button" onClick={() => onNavigate('Analytics')}>
          Explore analytics <ArrowUpRight size={16} />
        </AsyncButton>
      </div>
      <div className="stats-grid overview-kpis">
        <div className="stat-card">
          <div>
            <span>Total tracked views</span>
            <Clapperboard size={16} />
          </div>
          <strong>{number(report.publicViews)}</strong>
          <small>
            Public observations · {report.observed}/{report.postCount} posts covered
          </small>
        </div>
        <div className="stat-card">
          <div>
            <span>Active creators</span>
            <Users size={16} />
          </div>
          <strong>{active}</strong>
          <small>Current active campaign assignments</small>
        </div>
        <div className="stat-card">
          <div>
            <span>Pending reviews</span>
            <ClipboardCheck size={16} />
          </div>
          <strong>{reviews}</strong>
          <small>
            {historical
              ? `Issue groups · ${historical} historical posts kept separately`
              : 'Account issue groups · eligibility or data quality'}
          </small>
          <AsyncButton className="text-button" onClick={() => onNavigate('Needs attention')}>
            Open review queue <ArrowUpRight size={14} />
          </AsyncButton>
        </div>
        <div className="stat-card">
          <div>
            <span>Approved payouts</span>
            <Wallet size={16} />
          </div>
          <strong>
            <Money cents={approved} />
          </strong>
          <small>Finalized statements awaiting payment</small>
          <AsyncButton className="text-button" onClick={() => onNavigate('Monthly payouts')}>
            View payouts <ArrowUpRight size={14} />
          </AsyncButton>
        </div>
      </div>
      {searchError && (
        <p className="form-error" role="alert">
          {searchError}
        </p>
      )}
      {remote && query && searched?.key !== searchKey && !searchError && (
        <p role="status">Searching publications…</p>
      )}
      <div className="overview-comparison">
        <section className="card overview-summary-card">
          <div className="section-heading">
            <div>
              <h2>Top creators</h2>
              <p>Latest tracked public views</p>
            </div>
          </div>
          {ranked.length ? (
            <div className="creator-leaders">
              {ranked.map((creator, index) => (
                <div className="creator-leader" key={creator.id}>
                  <span className="leader-rank">{index + 1}</span>
                  <Avatar name={creator.name} />
                  <div className="leader-name">
                    <strong>{creator.name}</strong>
                    <small>
                      {creator.posts} posts · {creator.observed} with observations
                    </small>
                  </div>
                  <div className="leader-views">
                    <strong>{number(creator.views)}</strong>
                    <small>tracked public views</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="overview-compact-empty">
              Creator rankings appear with public observations.
            </p>
          )}
        </section>
        <section className="card overview-summary-card">
          <div className="section-heading">
            <div>
              <h2>Performance by platform</h2>
              <p>Public views · not verified organic views</p>
            </div>
          </div>
          <div className="platform-summary">
            {platformRows.map((row) => {
              const Icon = platformIcons[row.platform];
              return (
                <div className="platform-summary-row" key={row.platform}>
                  <div className="platform-summary-label">
                    <Icon size={16} />
                    <span>{platformNames[row.platform]}</span>
                    <strong>{row.observed ? number(row.views) : '—'}</strong>
                  </div>
                  <div className="platform-summary-track" aria-hidden="true">
                    <span
                      style={{ width: `${platformTotal ? (row.views / platformTotal) * 100 : 0}%` }}
                    />
                  </div>
                  <small>
                    {row.observed}/{row.posts} posts have public observations
                  </small>
                </div>
              );
            })}
            {!platformRows.length && (
              <p className="overview-compact-empty">
                Platform performance appears with tracked posts.
              </p>
            )}
          </div>
        </section>
      </div>
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Recent posts</h2>
            <p>Latest creator publications.</p>
          </div>
          <AsyncButton className="text-button" onClick={() => onNavigate('Posts & performance')}>
            All posts <ArrowUpRight size={15} />
          </AsyncButton>
        </div>
        <PostGrid
          compact
          data={{ ...data, snapshots: summary.recentSnapshots }}
          posts={recent}
          now={now}
          onOpen={onOpenPost}
        />
      </section>
    </>
  );
}
