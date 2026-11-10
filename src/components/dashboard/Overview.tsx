'use client';
import type { DashboardData, Post } from '@/domain/model';
import { performanceReport } from '@/domain/analytics';
import { postReview } from '@/domain/post-review';
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
  const report = performanceReport(data, { app: appId });
  const nowIso = new Date(now).toISOString();
  const scope = data.posts.filter((p) => appId === 'all' || p.app_id === appId);
  const reviews = scope.filter((p) => postReview(data, p, nowIso).stage === 'review');
  const historical = scope.filter((p) => postReview(data, p, nowIso).stage === 'historical');
  const active = data.creators.filter(
    (c) =>
      !c.archived &&
      data.memberships.some(
        (m) =>
          m.creator_id === c.id &&
          Date.parse(m.starts_at) <= now &&
          (!m.ends_at || Date.parse(m.ends_at) > now) &&
          data.campaigns.some(
            (campaign) =>
              campaign.id === m.campaign_id &&
              campaign.status === 'active' &&
              (appId === 'all' || campaign.app_id === appId) &&
              !data.apps.find((a) => a.id === campaign.app_id)?.archived
          )
      )
  );
  const statements = data.statements.filter((s) => appId === 'all' || s.app_id === appId);
  const approved = statements
    .filter((s) => s.status === 'finalized')
    .reduce((n, s) => n + s.payable_cents, 0);
  const visibleRows = report.rows.filter(
    (r) =>
      !query ||
      `${r.post.caption} ${r.post.platform} ${r.post.platform_post_id} ${data.creators.find((c) => c.id === r.post.creator_id)?.name || ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
  );
  const ranked = [...new Set(visibleRows.map((r) => r.post.creator_id))]
    .map((id) => {
      const rows = visibleRows.filter((r) => r.post.creator_id === id);
      return {
        id,
        name: data.creators.find((c) => c.id === id)?.name || 'Unknown creator',
        views: rows.reduce((n, r) => n + (r.publicViews ?? 0), 0),
        observed: rows.filter((r) => r.publicViews !== null).length,
        posts: rows.length,
      };
    })
    .filter((c) => c.observed > 0)
    .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name))
    .slice(0, 3);
  const platformRows = [...new Set(visibleRows.map((r) => r.post.platform))]
    .map((platform) => {
      const rows = visibleRows.filter((r) => r.post.platform === platform);
      return {
        platform,
        views: rows.reduce((total, row) => total + (row.publicViews ?? 0), 0),
        observed: rows.filter((r) => r.publicViews !== null).length,
        posts: rows.length,
      };
    })
    .sort((a, b) => b.views - a.views || a.platform.localeCompare(b.platform));
  const platformTotal = platformRows.reduce((sum, row) => sum + row.views, 0);
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
  const recent = [...visibleRows]
    .sort((a, b) => b.post.published_at.localeCompare(a.post.published_at))
    .slice(0, 3)
    .map((r) => r.post);
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
            Public observations · {report.observed}/{report.rows.length} posts covered
          </small>
        </div>
        <div className="stat-card">
          <div>
            <span>Active creators</span>
            <Users size={16} />
          </div>
          <strong>{active.length}</strong>
          <small>Current active campaign assignments</small>
        </div>
        <div className="stat-card">
          <div>
            <span>Pending reviews</span>
            <ClipboardCheck size={16} />
          </div>
          <strong>{reviews.length}</strong>
          <small>
            {historical.length
              ? `${historical.length} historical posts kept separately`
              : 'Unresolved eligibility or data quality'}
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
        <PostGrid compact data={data} posts={recent} now={now} onOpen={onOpenPost} />
      </section>
    </>
  );
}
