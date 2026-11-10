'use client';
import { useState } from 'react';
import {
  performanceReport,
  financialReport,
  observationTrend,
  type AnalyticsFilters,
} from '@/domain/analytics';
import type { DashboardData } from '@/domain/model';
import { platforms } from '@/domain/model';
import { Select, Input, Tooltip } from '@/components/ui/controls';
import { Money, number, Empty, Badge } from './Primitives';
import { ArrowDownUp, Info } from 'lucide-react';
export function Analytics({ data, appId }: { data: DashboardData; appId: string }) {
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const [sort, setSort] = useState<'public' | 'posts' | 'eligible'>('public');
  const applied = { ...filters, app: appId };
  const report = performanceReport(data, applied);
  const financial = financialReport(data, applied);
  const options = (items: { id: string; name: string }[], all: string) => (
    <>
      <option value="all">{all}</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </>
  );
  const set = (key: keyof AnalyticsFilters, value: string) =>
    setFilters((p) => ({ ...p, [key]: value }));
  const group = (by: 'creator' | 'platform') =>
    [...new Set(report.rows.map((r) => (by === 'creator' ? r.post.creator_id : r.post.platform)))]
      .map((id) => {
        const rows = report.rows.filter(
          (r) => (by === 'creator' ? r.post.creator_id : r.post.platform) === id
        );
        return {
          id,
          name:
            by === 'creator'
              ? data.creators.find((c) => c.id === id)?.name || 'Unknown creator'
              : id,
          posts: rows.length,
          public: rows.reduce((n, r) => n + (r.publicViews ?? 0), 0),
          eligible: rows.reduce((n, r) => n + (r.eligibleViews ?? 0), 0),
          observed: rows.filter((r) => r.publicViews !== null).length,
        };
      })
      .sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name));
  const days = observationTrend(data, applied);
  const x = (day: string) =>
    days.length < 2
      ? 175
      : 10 +
        ((Date.parse(day) - Date.parse(days[0].day)) /
          Math.max(1, Date.parse(days.at(-1)!.day) - Date.parse(days[0].day))) *
          330;
  const max = Math.max(1, ...days.map((d) => d.views));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Analytics</h1>
          <p>Creator performance and finalized compensation, with clear data coverage.</p>
        </div>
      </div>
      <section className="card analytics-filters" aria-label="Analytics filters">
        <label className="field">
          <span>Campaign</span>
          <Select
            aria-label="Analytics campaign"
            value={filters.campaign || 'all'}
            onChange={(e) => set('campaign', e.target.value)}
          >
            {options(
              data.campaigns.filter((c) => appId === 'all' || c.app_id === appId),
              'All campaigns'
            )}
          </Select>
        </label>
        <label className="field">
          <span>Creator</span>
          <Select
            aria-label="Analytics creator"
            value={filters.creator || 'all'}
            onChange={(e) => set('creator', e.target.value)}
          >
            {options(data.creators, 'All creators')}
          </Select>
        </label>
        <label className="field">
          <span>Platform</span>
          <Select
            aria-label="Analytics platform"
            value={filters.platform || 'all'}
            onChange={(e) => set('platform', e.target.value)}
          >
            <option value="all">All platforms</option>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span>Published from · New York</span>
          <Input
            type="date"
            value={filters.start || ''}
            onChange={(e) => set('start', e.target.value)}
          />
        </label>
        <label className="field">
          <span>Through · New York</span>
          <Input
            type="date"
            min={filters.start}
            value={filters.end || ''}
            onChange={(e) => set('end', e.target.value)}
          />
        </label>
      </section>
      {filters.start && filters.end && filters.start > filters.end && (
        <p className="form-error" role="alert">
          Choose an end date on or after the start date.
        </p>
      )}
      <div className="stats-grid">
        {[
          [
            'Public views observed',
            number(report.publicViews),
            `${report.observed}/${report.rows.length} posts have public observations`,
          ],
          [
            'Verified eligible views',
            number(report.eligibleViews),
            `${report.verified} posts reviewed and accepted`,
          ],
          ['Posts published', report.rows.length, 'Unique publications in selected scope'],
          [
            'Average public views',
            report.observed ? number(report.publicViews / report.observed) : '—',
            'Per post with a public observation',
          ],
        ].map(([label, value, caption]) => (
          <div className="stat-card" key={label}>
            <div>{label}</div>
            <strong>{value}</strong>
            <small>{caption}</small>
          </div>
        ))}
      </div>
      <p className="analytics-note">
        Public views use each post’s latest cumulative public observation available by the selected
        end date; they may extend beyond its eligibility window. Missing observations are not
        measured zeroes. Verified totals require review and may be incomplete. Policy-blocked
        accounts are omitted from view totals.
        {report.conflicts > 0 &&
          ` ${report.conflicts} publications with conflicting attribution omitted.`}
      </p>
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Observed public views over time</h2>
            <p>
              Latest reading per selected post, carried forward between observations; not daily view
              growth.
            </p>
          </div>
          <Tooltip label="One latest reading per video at each observation date. Coverage changes as posts are discovered; cached readings are carried forward. Gaps and provider delays prevent reconstruction of actual daily gains.">
            <button className="icon-button" aria-label="About observation coverage">
              <Info size={16} />
            </button>
          </Tooltip>
        </div>
        {days.length ? (
          <div className="cohort-chart">
            <svg
              viewBox="0 0 350 140"
              preserveAspectRatio="none"
              role="img"
              aria-label="Observed cumulative public views over time, with changing coverage"
            >
              <title>Latest observed public totals for the selected posts</title>
              <polyline
                fill="none"
                stroke="#91b4e4"
                strokeWidth="2"
                points={days.map((d) => `${x(d.day)},${120 - (d.views / max) * 110}`).join(' ')}
              />
              {days.map((d) => (
                <circle key={d.day} cx={x(d.day)} cy={120 - (d.views / max) * 110} r="3">
                  <title>
                    {d.day}: {d.views} observed views, {d.observed} posts covered
                  </title>
                </circle>
              ))}
            </svg>
            <div className="chart-axis">
              <span>{days[0].day}</span>
              <span>{days.at(-1)!.day}</span>
            </div>
            <details className="advanced-details">
              <summary>Accessible chart data</summary>
              {days.map((d) => (
                <p key={d.day}>
                  {d.day}: {number(d.views)} observed public views · {d.observed} posts covered
                </p>
              ))}
            </details>
          </div>
        ) : (
          <Empty
            title={report.rows.length ? 'No public observations yet' : 'No publications yet'}
            description="The chart appears after public observations are collected for posts in this date range."
          />
        )}
      </section>
      <div className="analytics-table-heading">
        <h2>Performance breakdown</h2>
        <label className="inline-control">
          <ArrowDownUp size={14} />
          <Select
            aria-label="Sort performance"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="public">Public views ↓</option>
            <option value="posts">Posts ↓</option>
            <option value="eligible">Verified views ↓</option>
          </Select>
        </label>
      </div>
      <div className="analytics-breakdowns">
        {(['creator', 'platform'] as const).map((by) => (
          <section className="card" key={by}>
            <div className="section-heading">
              <h2>By {by}</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{by === 'creator' ? 'Creator' : 'Platform'}</th>
                    <th aria-sort={sort === 'posts' ? 'descending' : 'none'}>
                      <button type="button" className="table-sort" onClick={() => setSort('posts')}>
                        Posts ↕
                      </button>
                    </th>
                    <th aria-sort={sort === 'public' ? 'descending' : 'none'}>
                      <button
                        type="button"
                        className="table-sort"
                        onClick={() => setSort('public')}
                      >
                        Public views ↕
                      </button>
                    </th>
                    <th aria-sort={sort === 'eligible' ? 'descending' : 'none'}>
                      <button
                        type="button"
                        className="table-sort"
                        onClick={() => setSort('eligible')}
                      >
                        Verified views ↕
                      </button>
                    </th>
                    <th>Avg. public / post</th>
                  </tr>
                </thead>
                <tbody>
                  {group(by).map((r) => (
                    <tr key={r.id}>
                      <td className="capitalize">{r.name}</td>
                      <td>{r.posts}</td>
                      <td>
                        {r.observed ? number(r.public) : '—'}{' '}
                        <small>
                          ({r.observed}/{r.posts})
                        </small>
                      </td>
                      <td>{number(r.eligible)}</td>
                      <td>{r.observed ? number(r.public / r.observed) : '—'}</td>
                    </tr>
                  ))}
                  {!report.rows.length && (
                    <tr>
                      <td colSpan={5}>No matching publications.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Finalized creator compensation</h2>
            <p>
              Complete publication months only. Full app/creator statements include caps, fixed
              payments and approved corrections. Campaign or platform filters hide financial totals
              because allocations are not reliable.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Creator / app</th>
                <th>Month</th>
                <th>Status</th>
                <th>Eligible payout</th>
                <th>Effective CPM</th>
              </tr>
            </thead>
            <tbody>
              {financial.map((r) => (
                <tr key={r.statement.id}>
                  <td>
                    {data.creators.find((c) => c.id === r.statement.creator_id)?.name ||
                      'Archived creator'}
                    <small className="block">
                      {data.apps.find((a) => a.id === r.statement.app_id)?.name}
                    </small>
                  </td>
                  <td>{r.statement.month}</td>
                  <td>
                    <Badge>{r.statement.status}</Badge>
                  </td>
                  <td>
                    <Money cents={r.cents} />
                  </td>
                  <td>
                    {r.effectiveCpm !== null ? `$${r.effectiveCpm.toFixed(2)}` : 'Unavailable'}
                  </td>
                </tr>
              ))}
              {!financial.length && (
                <tr>
                  <td colSpan={5}>No finalized statements for complete months in this scope.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="analytics-note">
          Effective CPM = finalized eligible payout ÷ statement eligible views × 1,000. It includes
          fixed payments; it is not the bonus tier rate. Corrections, redacted evidence or
          unavailable denominators show “Unavailable”. Draft estimates remain in Monthly payouts.
        </p>
      </section>
    </>
  );
}
