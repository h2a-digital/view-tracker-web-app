'use client';
import { OperationsHealth } from './OperationsHealth';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  formatTimestamp,
  instant,
  previousAccountingMonth,
  accountingTimezone,
} from '@/domain/time';
import { trackingState } from '@/domain/tracking';
import { calculateProvisional, isLocked } from '@/domain/compensation';
import { useState, type ReactNode } from 'react';
import {
  LayoutDashboard,
  Layers,
  Megaphone,
  Users,
  Link2,
  Clapperboard,
  Wallet,
  Settings2,
  TriangleAlert,
  Plus,
  ArrowUpRight,
  Search,
  ChevronDown,
  Download,
  RefreshCw,
  LogOut,
  Check,
  Menu,
  GitBranch,
  ExternalLink,
} from 'lucide-react';
import Papa from 'papaparse';
import type { DashboardData, Post, Statement, Snapshot } from '@/domain/model';
import { platforms } from '@/domain/model';
import { runCommand } from '@/domain/commands';
import {
  calculateStatement,
  fixedCents,
  publicationMonth,
  resolveRules,
} from '@/domain/compensation';
import type { Command } from '@/domain/validation';
import { Drawer, Badge, Empty, Money, number, date, Avatar } from './Primitives';
import { FormPanel, type Field } from './FormPanel';
import { RulesEditor } from './RulesEditor';
const nav = [
  ['Overview', LayoutDashboard],
  ['Apps & campaigns', Layers],
  ['Creators', Users],
  ['Social accounts', Link2],
  ['Posts & performance', Clapperboard],
  ['Compensation', Settings2],
  ['Monthly payouts', Wallet],
  ['Needs attention', TriangleAlert],
] as const;
const localTime = (value = new Date().toISOString()) => instant(value);
const iso = (value: string) => instant(value);
const option = (value: string, label: string) => ({ value, label });
const latest = (d: DashboardData, p: Post) =>
  d.snapshots
    .filter(
      (s) =>
        s.post_id === p.id &&
        s.metric !== 'paid_views' &&
        s.provenance?.kind !== 'daily' &&
        !s.provenance?.supporting
    )
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
function download(name: string, rows: Record<string, unknown>[]) {
  const url = URL.createObjectURL(
    new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export function Dashboard({
  initial,
  preview = false,
}: {
  initial: DashboardData;
  preview?: boolean;
}) {
  const router = useRouter();
  const [mountedAt, setMountedAt] = useState(() => new Date().getTime());
  const [data, setData] = useState(initial);
  const [view, setView] = useState<string>('Overview');
  const [appId, setAppId] = useState('all');
  const [query, setQuery] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [panel, setPanel] = useState<{ title: string; kind: string; id?: string } | null>(null);
  const [toast, setToast] = useState('');
  const [connectionUrl, setConnectionUrl] = useState('');
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const appName = (id: string | null) => data.apps.find((a) => a.id === id)?.name || 'Unassigned';
  const creatorName = (id: string) =>
    data.creators.find((c) => c.id === id)?.name || 'Unknown creator';
  const campaignName = (id: string | null) =>
    data.campaigns.find((c) => c.id === id)?.name || 'Needs assignment';
  const campaignOptions = data.campaigns
    .filter((c) => appId === 'all' || c.app_id === appId)
    .map((c) => option(c.id, `${appName(c.app_id)} · ${c.name}`));
  const creatorOptions = data.creators.map((c) => option(c.id, c.name));
  const appOptions = data.apps.map((a) => option(a.id, a.name));
  const accountOptions = data.accounts.map((a) =>
    option(a.id, `${creatorName(a.creator_id)} · ${a.platform} @${a.username}`)
  );
  const posts = data.posts.filter(
    (p) =>
      (appId === 'all' || p.app_id === appId) &&
      (view !== 'Posts & performance' ||
        campaignFilter === 'all' ||
        p.campaign_id === campaignFilter) &&
      (!query ||
        `${p.caption} ${p.platform} ${creatorName(p.creator_id)} ${p.platform_post_id}`
          .toLowerCase()
          .includes(query.toLowerCase()))
  );
  const campaigns = data.campaigns.filter((c) => appId === 'all' || c.app_id === appId);
  const creators = data.creators.filter(
    (c) =>
      (appId === 'all' ||
        data.memberships.some(
          (m) => m.creator_id === c.id && campaigns.some((x) => x.id === m.campaign_id)
        )) &&
      (!query || `${c.name} ${c.email}`.toLowerCase().includes(query.toLowerCase()))
  );
  const scopedCreators = new Set(creators.map((c) => c.id));
  const accounts = data.accounts.filter((a) => scopedCreators.has(a.creator_id));
  const statements = data.statements.filter((s) => appId === 'all' || s.app_id === appId);
  const held = posts.filter((p) => {
    const state = trackingState(data, p, new Date(mountedAt).toISOString());
    if (p.eligibility_status === 'accepted' && !p.review_evidence && !isLocked(data, p))
      return true;
    return (
      !['accepted', 'excluded'].includes(p.eligibility_status) &&
      (state.status !== 'active' ||
        state.issues.some((i) =>
          [
            'campaign_unassigned',
            'counter_missing',
            'provider_stale',
            'refresh_failed',
            'provider_policy_blocked',
            'shorts_classification_unverified',
            'not_a_short',
          ].includes(i)
        ))
    );
  });
  const problems = accounts.filter(
    (a) =>
      a.status !== 'connected' ||
      a.error ||
      !a.last_synced_at ||
      new Date(a.last_synced_at).getTime() < mountedAt - 86400000
  );
  const aggregateViews = (p: Post) =>
    data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked
      ? 0
      : (p.tracking?.lastViews ?? latest(data, p)?.views ?? 0);
  const publicViews = posts.reduce((sum, p) => sum + aggregateViews(p), 0);
  const eligibleViews = posts.reduce((sum, p) => sum + (p.eligible_views || 0), 0);
  const selectedApp = appId === 'all' ? data.apps[0]?.id : appId;
  async function execute(command: Command, close = true) {
    setError('');
    if (preview) {
      setData(runCommand(data, command, 'preview administrator'));
    } else {
      const r = await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error);
      setData(v.data);
    }
    if (close) setPanel(null);
    setToast('Changes saved');
  }
  async function action(command: Command) {
    try {
      await execute(command);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    }
  }
  async function connection(id: string, action: 'connect' | 'disconnect' | 'deletion-link') {
    if (preview) {
      setToast(
        'Connections are disabled in preview. Configure the relevant provider server credentials during setup.'
      );
      return;
    }
    try {
      const r = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id, action }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error);
      if (v.authUrl) {
        setConnectionUrl(v.authUrl);
        open('authorization', 'Authorize social account tracking', id);
        return;
      }
      await refresh();
      setPanel(null);
      setToast('Account disconnected');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
    }
  }
  async function refresh() {
    setMountedAt(new Date().getTime());
    if (preview) return;
    try {
      const r = await fetch('/api/dashboard', { cache: 'no-store' });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error);
      setData(v.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    }
  }
  async function sync(id: string) {
    if (preview) {
      setToast('Preview does not call external APIs.');
      return;
    }
    try {
      const r = await fetch('/api/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error);
      setToast('Sync queued. The background worker will collect new posts and metrics.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue sync.');
    }
  }
  const open = (kind: string, title: string, id?: string) => {
    setError('');
    setPanel({ kind, title, id });
  };
  const addButton = (kind: string, title: string, label: string) => (
    <button className="button primary" onClick={() => open(kind, title)}>
      <Plus size={16} />
      {label}
    </button>
  );
  const nameField = (label = 'Name'): Field => ({ name: 'name', label });
  const selectField = (
    name: string,
    label: string,
    options: { value: string; label: string }[]
  ): Field => ({ name, label, type: 'select', options });
  function form(fields: Field[], fn: (v: Record<string, string>) => Command, label?: string) {
    return <FormPanel fields={fields} submitLabel={label} onSubmit={async (v) => execute(fn(v))} />;
  }
  const postRow = (p: Post) => (
    <tr key={p.id} onClick={() => open('post', 'Post details', p.id)} className="clickable">
      <td>
        <div className="post-title">
          <span className={`platform-mark ${p.platform}`}>
            {p.platform.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{p.caption || `Post ${p.platform_post_id}`}</strong>
            <small>{campaignName(p.campaign_id)}</small>
          </div>
        </div>
      </td>
      <td>{creatorName(p.creator_id)}</td>
      <td>
        {number(p.tracking?.lastViews ?? latest(data, p)?.views ?? 0)}
        <small>public views</small>
      </td>
      <td>{p.eligible_views === null ? '—' : number(p.eligible_views)}</td>
      <td>
        <Badge
          tone={
            p.eligibility_status === 'accepted'
              ? 'green'
              : p.eligibility_status === 'excluded'
                ? 'neutral'
                : p.eligibility_status === 'review'
                  ? 'amber'
                  : 'purple'
          }
        >
          {p.eligibility_status === 'tracking' &&
          p.deadline &&
          p.deadline < new Date().toISOString()
            ? 'Review due'
            : p.eligibility_status}
        </Badge>
      </td>
      <td>{p.source_erased_at ? 'Source erased' : date(p.published_at)}</td>
      <td>
        <ArrowUpRight size={16} />
      </td>
    </tr>
  );
  function postTable(rows: Post[]) {
    return rows.length ? (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Post / campaign</th>
              <th>Creator</th>
              <th>Views</th>
              <th>Eligible views</th>
              <th>Status</th>
              <th>Published</th>
              <th />
            </tr>
          </thead>
          <tbody>{rows.map(postRow)}</tbody>
        </table>
      </div>
    ) : (
      <Empty
        title="Your next great post starts here"
        description="Connect a creator account or add an existing post to start tracking."
        action={addButton('addPost', 'Add a post', 'Add post')}
      />
    );
  }
  function overview() {
    return (
      <>
        <div className="welcome-line">
          <div>
            <span className="eyebrow">YOUR WORKSPACE AT A GLANCE</span>
            <h1>Every creator. Every opportunity.</h1>
            <p>A clear view of your creator partnerships and what comes next.</p>
          </div>
          <div className="period-chip">
            All tracked publications <ChevronDown size={14} />
          </div>
        </div>
        <div className="info-box">
          <p>
            Provisional planning estimate:{' '}
            <Money
              cents={statements
                .filter((s) => s.status === 'draft')
                .reduce(
                  (n, s) =>
                    n +
                    calculateProvisional(data, s.app_id, s.creator_id, s.month, s.policy)
                      .payableCents,
                  0
                )}
            />
            . Based only on observed in-window counts. Organic eligibility, exact cutoff evidence,
            bonus approval and final payout approval remain required.
          </p>
        </div>
        <div className="stats-grid">
          {[
            ['Public views', number(publicViews), 'Across your tracked posts', Clapperboard],
            [
              'Verified eligible views',
              number(eligibleViews),
              'Reviewed for organic eligibility',
              Check,
            ],
            [
              'Active creators',
              String(creators.length),
              `${accounts.length} registered social accounts`,
              Users,
            ],
            [
              'Awaiting payment',
              <Money
                key="money"
                cents={statements
                  .filter((s) => s.status === 'finalized')
                  .reduce((a, s) => a + s.payable_cents, 0)}
              />,
              'Finalized, ready for external payment',
              Wallet,
            ],
          ].map(([label, value, caption, Icon]) => {
            const I = Icon as typeof Wallet;
            return (
              <div className="stat-card" key={String(label)}>
                <div>
                  <span>{label as string}</span>
                  <I size={17} />
                </div>
                <strong>{value as ReactNode}</strong>
                <small>{caption as string}</small>
              </div>
            );
          })}
        </div>
        <div className="overview-grid">
          <section className="card performance-card">
            <div className="section-heading">
              <div>
                <h2>Performance by platform</h2>
                <p>
                  Totals are provisional. Policy-blocked YouTube accounts are omitted from aggregate
                  figures.
                </p>
              </div>
              <span className="subtle">{posts.length} posts</span>
            </div>
            <div className="platform-chart">
              {platforms.map((platform) => {
                const v = posts
                  .filter((p) => p.platform === platform)
                  .reduce((sum, p) => sum + aggregateViews(p), 0);
                return (
                  <div className="platform-bar-row" key={platform}>
                    <div>
                      <span className={`platform-mark ${platform}`}>
                        {platform.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="capitalize">{platform}</span>
                      <b>{number(v)}</b>
                    </div>
                    <div className="bar-track">
                      <span
                        style={{
                          width: `${publicViews ? Math.max(1, (v / publicViews) * 100) : 0}%`,
                        }}
                        className={platform}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card attention-card">
            <div className="section-heading">
              <h2>A little attention goes a long way</h2>
              <TriangleAlert size={19} />
            </div>
            <div className="attention-number">
              {held.length + problems.length}
              <span>items to review</span>
            </div>
            <p>Keep your data complete and your creator payouts accurate.</p>
            <button className="button soft" onClick={() => setView('Needs attention')}>
              Review your queue <ArrowUpRight size={16} />
            </button>
            <div className="attention-mini">
              <span>Posts awaiting review</span>
              <b>{held.length}</b>
            </div>
            <div className="attention-mini">
              <span>Accounts needing attention</span>
              <b>{problems.length}</b>
            </div>
          </section>
        </div>
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Recent posts</h2>
              <p>New content from your creator network.</p>
            </div>
            <button className="text-button" onClick={() => setView('Posts & performance')}>
              View all posts <ArrowUpRight size={15} />
            </button>
          </div>
          {postTable(
            [...posts].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 5)
          )}
        </section>
      </>
    );
  }
  function appsView() {
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Apps & campaigns</h1>
            <p>Build partnerships around each of your apps.</p>
          </div>
          <div className="button-group">
            {addButton('campaign', 'Create campaign', 'New campaign')}
            {addButton('app', 'Add an app', 'New app')}
          </div>
        </div>
        <div className="app-grid">
          {data.apps
            .filter((a) => appId === 'all' || a.id === appId)
            .map((a) => (
              <section className="card app-card" key={a.id}>
                <div className="app-card-heading">
                  <Avatar name={a.name} color={a.color} />
                  <div>
                    <h2>{a.name}</h2>
                    <small>{a.archived ? 'Archived' : 'Active app'}</small>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => open('editApp', 'Manage app', a.id)}
                  >
                    Manage
                  </button>
                </div>
                <div className="app-metrics">
                  <span>
                    <b>{data.campaigns.filter((c) => c.app_id === a.id).length}</b> campaigns
                  </span>
                  <span>
                    <b>{data.posts.filter((p) => p.app_id === a.id).length}</b> posts
                  </span>
                </div>
                {data.campaigns
                  .filter((c) => c.app_id === a.id)
                  .map((c) => (
                    <button
                      key={c.id}
                      className="campaign-row"
                      onClick={() => open('editCampaign', 'Manage campaign', c.id)}
                    >
                      <Megaphone size={16} />
                      <span>{c.name}</span>
                      <Badge tone={c.status === 'active' ? 'green' : 'neutral'}>{c.status}</Badge>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                <button
                  className="text-button"
                  onClick={() => {
                    setAppId(a.id);
                    open('campaign', 'Create campaign');
                  }}
                >
                  <Plus size={15} />
                  Add campaign
                </button>
              </section>
            ))}
        </div>
      </>
    );
  }
  function creatorsView() {
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Your creator network</h1>
            <p>People behind the content. Partnerships that grow.</p>
          </div>
          <div className="button-group">
            {addButton('assignment', 'Assign creator to campaign', 'Assign to campaign')}
            {addButton('creator', 'Add a creator', 'Add creator')}
          </div>
        </div>
        <section className="card">
          {creators.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Creator</th>
                    <th>Campaigns</th>
                    <th>Accounts</th>
                    <th>Posts</th>
                    <th>Eligible views</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {creators.map((c) => (
                    <tr
                      key={c.id}
                      className="clickable"
                      onClick={() => open('creatorDetail', c.name, c.id)}
                    >
                      <td>
                        <div className="person">
                          <Avatar name={c.name} />
                          <div>
                            <strong>{c.name}</strong>
                            <small>{c.email || 'No email added'}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {data.memberships
                          .filter((m) => m.creator_id === c.id)
                          .map((m) => campaignName(m.campaign_id))
                          .join(', ') || 'Unassigned'}
                      </td>
                      <td>{data.accounts.filter((a) => a.creator_id === c.id).length}</td>
                      <td>{posts.filter((p) => p.creator_id === c.id).length}</td>
                      <td>
                        {number(
                          posts
                            .filter((p) => p.creator_id === c.id)
                            .reduce((n, p) => n + (p.eligible_views || 0), 0)
                        )}
                      </td>
                      <td>
                        <ArrowUpRight size={17} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="Meet your first creator"
              description="Add a creator, assign a campaign, and connect their social accounts."
              action={addButton('creator', 'Add a creator', 'Add creator')}
            />
          )}
        </section>
      </>
    );
  }
  function accountView() {
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Social accounts</h1>
            <p>Connect once. Keep up with every new post.</p>
          </div>
          <div className="button-group">
            {addButton('mapping', 'Map account to campaign', 'Route posts')}
            {addButton('account', 'Register social account', 'Add account')}
          </div>
        </div>
        <div className="info-box">
          <Link2 size={19} />
          <p>
            TikTok uses Zernio’s two-account free allowance. YouTube, Instagram and Facebook use
            direct read-only APIs. Provider credentials, approval and a verified metrics pilot are
            required before production use.
          </p>
        </div>
        <div className="account-grid">
          {accounts.map((a) => (
            <section className="card account-card" key={a.id}>
              <div className="account-card-top">
                <span className={`platform-mark ${a.platform}`}>
                  {a.platform.slice(0, 2).toUpperCase()}
                </span>
                <Badge
                  tone={
                    a.status === 'connected'
                      ? 'green'
                      : a.status === 'attention'
                        ? 'amber'
                        : 'neutral'
                  }
                >
                  {a.status}
                </Badge>
              </div>
              <h2>@{a.username}</h2>
              <p>
                {creatorName(a.creator_id)} · <span className="capitalize">{a.platform}</span>
              </p>
              <dl>
                <div>
                  <dt>Managed by</dt>
                  <dd>
                    {a.provider === 'zernio'
                      ? 'Zernio'
                      : a.provider === 'direct'
                        ? 'Official API'
                        : 'Manual / CSV'}
                  </dd>
                </div>
                <div>
                  <dt>Last sync</dt>
                  <dd>{a.last_synced_at ? date(a.last_synced_at) : 'Not synced yet'}</dd>
                </div>
                <div>
                  <dt>Routing</dt>
                  <dd>
                    {data.mappings.filter((m) => m.account_id === a.id).length} campaign mapping(s)
                  </dd>
                </div>
              </dl>
              {a.error && <p className="form-error">{a.error}</p>}
              {a.provider === 'direct' && a.status !== 'disconnected' && (
                <button className="button soft" onClick={() => connection(a.id, 'deletion-link')}>
                  Creator deletion link
                </button>
              )}
              {a.provider === 'direct' && (
                <p className="subtle">
                  Disconnect deletes source data and revokes access. Other accounts sharing the
                  provider grant may also disconnect.
                </p>
              )}
              {a.integration?.payoutsBlocked && (
                <p className="form-error">
                  {a.integration.policyReason ||
                    'Provider policy approval required before compensation.'}
                </p>
              )}
              <div className="button-group">
                {a.provider !== 'manual' &&
                  (a.status === 'connected' ? (
                    <>
                      <button className="button soft" onClick={() => sync(a.id)}>
                        <RefreshCw size={14} />
                        Sync
                      </button>
                      <button
                        className="text-button"
                        onClick={() => open('disconnect', 'Disconnect account', a.id)}
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button className="button soft" onClick={() => connection(a.id, 'connect')}>
                      Connect {a.platform}
                      <ExternalLink size={14} />
                    </button>
                  ))}
                <button
                  className="text-button"
                  onClick={() => open('mapping', 'Map account to campaign', a.id)}
                >
                  Route posts
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </section>
          ))}
        </div>
        {!accounts.length && (
          <Empty
            title="Connect your creator’s world"
            description="Register an account to connect TikTok or start recording observations."
            action={addButton('account', 'Register social account', 'Add account')}
          />
        )}
      </>
    );
  }
  function compensationView() {
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Compensation, clearly defined</h1>
            <p>Flexible rules. Consistent calculations. No surprises.</p>
          </div>
          {addButton('rules', 'Configure compensation', 'Configure rules')}
        </div>
        <div className="info-box">
          <GitBranch size={19} />
          <p>
            App defaults → campaign overrides → creator/app → creator/campaign. Fixed payments and
            windows lock at publication. CPM, cap, and approval changes start next month, with one
            shared schedule per app and creator.
          </p>
        </div>
        <div className="app-grid">
          {data.apps
            .filter((a) => appId === 'all' || a.id === appId)
            .map((a) => {
              const r = resolveRules(
                data.ruleVersions,
                a.id,
                '',
                '',
                new Date().toISOString()
              ).rules;
              return (
                <section className="card rule-card" key={a.id}>
                  <div className="section-heading">
                    <h2>{a.name} defaults</h2>
                    <Badge tone="purple">{r.windowDays}-day window</Badge>
                  </div>
                  <h3>Fixed payments</h3>
                  {r.fixedPayments.map((p) => (
                    <p key={p.platform} className="rule-line">
                      <span className="capitalize">{p.platform}</span>
                      <b>
                        ${p.amount} <small>at {number(p.minimumViews)} views</small>
                      </b>
                    </p>
                  ))}
                  <h3>Performance bonus</h3>
                  {r.cpmMode === 'progressive' ? (
                    r.tiers.map((t, i) => (
                      <p className="rule-line" key={i}>
                        <span>
                          {i === 0 ? 'First' : `Above ${number(r.tiers[i - 1].upTo || 0)}`}{' '}
                          {t.upTo === null ? ' · unlimited' : number(t.upTo)}
                        </span>
                        <b>${t.cpm} CPM</b>
                      </p>
                    ))
                  ) : (
                    <p>{r.cpmMode === 'flat' ? `$${r.flatCpm} CPM` : 'Disabled'}</p>
                  )}
                  <div className="rule-footer">
                    <span>
                      Monthly cap <b>{r.monthlyCap ? `$${r.monthlyCap}` : 'Uncapped'}</b>
                    </span>
                    <Badge tone="amber">
                      {r.bonusApproval ? 'Bonus approval required' : 'Bonus automatic'}
                    </Badge>
                  </div>
                </section>
              );
            })}
        </div>
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Rule version history</h2>
              <p>Every version is retained. Existing posts keep their original rules.</p>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Scope</th>
                  <th>Applies to</th>
                  <th>Effective</th>
                  <th>Overrides</th>
                </tr>
              </thead>
              <tbody>
                {data.ruleVersions
                  .filter((r) => appId === 'all' || r.app_id === appId)
                  .sort((a, b) => b.effective_at.localeCompare(a.effective_at))
                  .map((r) => (
                    <tr key={r.id}>
                      <td>{appName(r.app_id)}</td>
                      <td className="capitalize">{r.scope.replaceAll('_', ' ')}</td>
                      <td>
                        {r.creator_id
                          ? creatorName(r.creator_id)
                          : r.campaign_id
                            ? campaignName(r.campaign_id)
                            : 'All creators'}
                      </td>
                      <td>{date(r.effective_at)}</td>
                      <td>{Object.keys(r.patch).join(', ') || 'Inherit all'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }
  function payoutsView() {
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Monthly payouts</h1>
            <p>From verified performance to confident payments.</p>
          </div>
          <div className="button-group">
            <button
              className="button"
              onClick={() =>
                download(
                  'creator-payouts.csv',
                  statements.map((s) => ({
                    id: s.id,
                    app: appName(s.app_id),
                    creator: creatorName(s.creator_id),
                    publication_month: s.month,
                    accounting_timezone: accountingTimezone,
                    status: s.status,
                    provisional_usd:
                      s.status === 'draft'
                        ? calculateProvisional(data, s.app_id, s.creator_id, s.month, s.policy)
                            .payableCents / 100
                        : null,
                    base_usd: s.base_cents / 100,
                    potential_bonus_usd: s.potential_bonus_cents / 100,
                    approved_bonus_usd: (s.approved_bonus_cents || 0) / 100,
                    payable_usd: s.payable_cents / 100,
                    payment_reference: s.payment_reference,
                  }))
                )
              }
            >
              <Download size={15} />
              Export CSV
            </button>
            {addButton('statement', 'Generate monthly statement', 'Generate statement')}
          </div>
        </div>
        <div className="info-box">
          <Wallet size={19} />
          <p>
            Statements use the post’s publication month in America/New_York. Finalize after
            month-end and all view windows close. Pay externally, then record the payment here.
            Unverified views stay out of payable totals.
            {data.accounts.some((a) => a.provider === 'direct' && a.platform === 'youtube') &&
              ' YouTube-based compensation is a company calculation, not approved or published by Google or YouTube.'}
          </p>
        </div>
        <section className="card">
          {statements.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Creator / app</th>
                    <th>Publication month</th>
                    <th>Base earned</th>
                    <th>Potential bonus</th>
                    <th>Payable</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {statements.map((s) => (
                    <tr
                      key={s.id}
                      className="clickable"
                      onClick={() => open('statementDetail', 'Monthly statement', s.id)}
                    >
                      <td>
                        <strong>{creatorName(s.creator_id)}</strong>
                        <small>{appName(s.app_id)}</small>
                      </td>
                      <td>{s.month}</td>
                      <td>
                        <Money cents={s.base_cents} />
                      </td>
                      <td>
                        <Money cents={s.potential_bonus_cents} />
                      </td>
                      <td>
                        <strong>
                          <Money cents={s.payable_cents} />
                        </strong>
                      </td>
                      <td>
                        <Badge
                          tone={
                            s.status === 'paid'
                              ? 'green'
                              : s.status === 'finalized'
                                ? 'purple'
                                : 'amber'
                          }
                        >
                          {s.status}
                        </Badge>
                      </td>
                      <td>
                        <ArrowUpRight size={17} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="A clear statement for every partnership"
              description="Once posts are attributed, generate a monthly statement to review earnings."
              action={addButton('statement', 'Generate monthly statement', 'Generate statement')}
            />
          )}
        </section>
      </>
    );
  }
  function attentionView() {
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Needs attention</h1>
            <p>Resolve missing data and keep your payouts on track.</p>
          </div>
          <button className="button" onClick={refresh}>
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
        <OperationsHealth preview={preview} />
        <section className="card">
          <div className="section-heading">
            <h2>Posts to review</h2>
            <Badge tone="amber">{held.length}</Badge>
          </div>
          <div className="padded subtle">
            {held.map((p) => (
              <p key={p.id}>
                {p.caption || p.platform_post_id}:{' '}
                {trackingState(data, p, new Date(mountedAt).toISOString())
                  .issues.join(', ')
                  .replaceAll('_', ' ')}
              </p>
            ))}
          </div>
          {postTable(held)}
        </section>
        <section className="card">
          <div className="section-heading">
            <h2>Accounts & sync health</h2>
          </div>
          {problems.map((a) => (
            <div className="health-row" key={a.id}>
              <TriangleAlert size={18} />
              <div>
                <strong>
                  @{a.username} · {a.platform}
                </strong>
                <p>
                  {a.error ||
                    (a.status === 'connected'
                      ? 'Metrics have not refreshed in the last 24 hours.'
                      : 'Account needs connection or uses manual imports.')}
                </p>
              </div>
              <button
                className="button"
                onClick={() => {
                  setView('Social accounts');
                }}
              >
                Manage
              </button>
            </div>
          ))}
          {!problems.length && (
            <p className="padded subtle">Your connected accounts are up to date.</p>
          )}
        </section>
        <section className="card">
          <div className="section-heading">
            <h2>Recent synchronization runs</h2>
          </div>
          {data.syncRuns.slice(0, 20).map((r) => (
            <div className="health-row" key={r.id}>
              <Badge tone={r.status === 'success' ? 'green' : 'amber'}>{r.status}</Badge>
              <div>
                <strong>{data.accounts.find((a) => a.id === r.account_id)?.username}</strong>
                <p>{r.message}</p>
                {r.diagnostics && (
                  <details>
                    <summary>Snapshot and freshness diagnostics</summary>
                    <pre className="diagnostics">{JSON.stringify(r.diagnostics, null, 2)}</pre>
                  </details>
                )}
                <small>{date(r.started_at)}</small>
              </div>
            </div>
          ))}
          {!data.syncRuns.length && (
            <p className="padded subtle">
              Sync runs appear after your first connected account is processed.
            </p>
          )}
        </section>
        <section className="card">
          <div className="section-heading">
            <h2>Activity log</h2>
          </div>
          {data.audit.slice(0, 15).map((a) => (
            <div className="activity-row" key={a.id}>
              <span className="activity-dot" />
              <div>
                <strong>{a.action.replace(/([A-Z])/g, ' $1')}</strong>
                <p>{a.detail}</p>
              </div>
              <small>{date(a.created_at)}</small>
            </div>
          ))}
        </section>
      </>
    );
  }
  function postDetail(p: Post) {
    const observations = data.snapshots
      .filter((s) => s.post_id === p.id)
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const locked = data.statements.some(
      (s) =>
        s.status !== 'draft' &&
        s.app_id === p.app_id &&
        s.creator_id === p.creator_id &&
        s.month === publicationMonth(p.published_at)
    );
    const max = Math.max(1, ...observations.map((s) => s.views));
    const tracking = trackingState(data, p, new Date(mountedAt).toISOString());
    return (
      <div className="detail-body">
        <div className="detail-hero">
          <span className={`platform-mark ${p.platform}`}>
            {p.platform.slice(0, 2).toUpperCase()}
          </span>
          <h2>{p.caption || p.platform_post_id}</h2>
          <p>
            {creatorName(p.creator_id)} ·{' '}
            {p.source_erased_at ? 'Source erased' : date(p.published_at)}
          </p>
          <a href={p.url} target="_blank" rel="noreferrer" className="text-button">
            Open original post
            <ExternalLink size={14} />
          </a>
        </div>
        <div className="detail-stats">
          <div>
            <small>Public views</small>
            <b>{number(p.tracking?.lastViews ?? latest(data, p)?.views ?? 0)}</b>
          </div>
          <div>
            <small>Eligible views</small>
            <b>{p.eligible_views === null ? 'Pending' : number(p.eligible_views)}</b>
          </div>
          <div>
            <small>Base earned</small>
            <b>
              <Money cents={fixedCents(p)} />
            </b>
          </div>
        </div>
        <div className="info-box">
          <TriangleAlert size={18} />
          <p>
            Public views include unverified traffic. Accept an evidence-backed organic total for the{' '}
            {p.rules?.windowDays || 'configured'}-day window; daily snapshots cannot prove an exact
            cutoff total.
          </p>
        </div>
        <dl className="detail-dl">
          <div>
            <dt>Campaign</dt>
            <dd>{campaignName(p.campaign_id)}</dd>
          </div>
          <div>
            <dt>Window closes</dt>
            <dd>{p.deadline ? formatTimestamp(p.deadline) : 'Assign campaign first'}</dd>
          </div>
          <div>
            <dt>Review</dt>
            <dd>{p.review_note || 'Awaiting evidence review'}</dd>
          </div>
          <div>
            <dt>Evidence reference</dt>
            <dd>{p.review_evidence?.reference || 'Not verified'}</dd>
          </div>
          <div>
            <dt>Post reference</dt>
            <dd className="mono">{p.id}</dd>
          </div>
        </dl>
        {observations.length > 1 && (
          <svg
            className="snapshot-chart"
            viewBox="0 0 420 130"
            role="img"
            aria-label="View counts over time"
          >
            <path
              d={`M ${observations.map((s, i) => `${(i / (observations.length - 1)) * 400 + 10},${120 - (s.views / max) * 100}`).join(' L ')}`}
              fill="none"
              stroke="#a99cf4"
              strokeWidth="3"
            />
            <line x1="10" y1="121" x2="410" y2="121" stroke="#323643" />
          </svg>
        )}
        <div className="button-group">
          <button
            className="button"
            onClick={() => open('snapshot', 'Add metric observation', p.id)}
          >
            Add observation
          </button>
          {!locked && (
            <>
              <button
                className="button"
                onClick={() => open('attribute', 'Assign post to campaign', p.id)}
              >
                Assign campaign
              </button>
              <button
                className="button primary"
                onClick={() => open('review', 'Review eligible views', p.id)}
              >
                Review eligibility
              </button>
            </>
          )}
        </div>
        <div className="info-box">
          <p>
            Collection: <b>{tracking.status}</b>. Provisional in-window public views:{' '}
            <b>{number(tracking.provisionalViews)}</b>. These are not verified organic or
            automatically payable.
            <br />
            Attention: {tracking.issues.map((i) => i.replaceAll('_', ' ')).join(', ') ||
              'None'}.{' '}
            {tracking.followupUntil && (
              <>Closing follow-up ends {formatTimestamp(tracking.followupUntil)}.</>
            )}
          </p>
        </div>
        <h3>Metric history · America/New_York</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Collected</th>
                <th>Count</th>
                <th>Metric</th>
                <th>Source / freshness</th>
              </tr>
            </thead>
            <tbody>
              {[...observations].reverse().map((s) => (
                <tr key={s.id}>
                  <td>
                    {formatTimestamp(s.observed_at)}
                    <small>{s.evidence}</small>
                  </td>
                  <td>{number(s.views)}</td>
                  <td>{s.metric.replaceAll('_', ' ')}</td>
                  <td>
                    {s.source}
                    <small>
                      {s.provenance && (
                        <span>
                          {s.provenance.metricName} · {s.provenance.scope} · {s.quality}
                          {s.provenance.periodStart
                            ? ` · ${formatTimestamp(s.provenance.periodStart)} – ${formatTimestamp(s.provenance.periodEnd!)}`
                            : ''}
                        </span>
                      )}
                      {s.provider_updated_at
                        ? `Provider: ${formatTimestamp(s.provider_updated_at)}`
                        : 'Provider freshness unknown'}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle">
          Snapshot history is append-only except for required provider source deletion/retention.{' '}
          {locked
            ? 'This publication month is locked. Corrections require a linked adjustment.'
            : ''}
        </p>
      </div>
    );
  }
  function statementDetail(s: Statement) {
    const provisional = calculateProvisional(data, s.app_id, s.creator_id, s.month, s.policy);
    const result = calculateStatement(
      data,
      s.app_id,
      s.creator_id,
      s.month,
      s.policy,
      s.approved_bonus_cents
    );
    return (
      <div className="detail-body">
        <div className="detail-hero">
          <Badge tone={s.status === 'paid' ? 'green' : 'purple'}>{s.status}</Badge>
          <h2>{creatorName(s.creator_id)}</h2>
          <p>
            {appName(s.app_id)} · Publication month {s.month}
          </p>
          {s.status === 'draft' && (
            <div className="info-box">
              <p>
                Provisional estimate from {number(provisional.eligibleViews)} in-window views:{' '}
                <Money cents={provisional.payableCents} />. Includes potential bonuses; unverified
                views are held and are not payable.
              </p>
            </div>
          )}
          <strong className="payout-total">
            <Money cents={s.payable_cents} />
          </strong>
          <small>Total payable after approvals and cap</small>
        </div>
        <dl className="detail-dl">
          <div>
            <dt>Fixed payments earned</dt>
            <dd>
              <Money cents={s.base_cents} />
            </dd>
          </div>
          <div>
            <dt>Potential performance bonus</dt>
            <dd>
              <Money cents={s.potential_bonus_cents} />
            </dd>
          </div>
          <div>
            <dt>Approved bonus</dt>
            <dd>
              {s.approved_bonus_cents === null ? (
                s.policy.bonusApproval ? (
                  'Awaiting approval'
                ) : (
                  'Automatic'
                )
              ) : (
                <Money cents={s.approved_bonus_cents} />
              )}
            </dd>
          </div>
          <div>
            <dt>Excluded by monthly cap</dt>
            <dd>
              <Money cents={s.capped_cents} />
            </dd>
          </div>
          <div>
            <dt>Unresolved posts</dt>
            <dd>{result.unresolved}</dd>
          </div>
          {s.payment_reference && (
            <div>
              <dt>Payment reference</dt>
              <dd>{s.payment_reference}</dd>
            </div>
          )}
        </dl>
        {s.source_redacted_at && (
          <p className="info-box">
            Provider source details were erased. Settled company payment amounts and status are
            preserved.
          </p>
        )}
        {s.bonus_note && <p className="info-box">{s.bonus_note}</p>}
        <div className="button-group">
          {s.status === 'draft' ? (
            <>
              <button
                className="button"
                onClick={() => open('bonus', 'Approve performance bonus', s.id)}
              >
                Approve / reject bonus
              </button>
              <button
                className="button primary"
                onClick={() => action({ type: 'finalizeStatement', statementId: s.id })}
              >
                Finalize statement
              </button>
            </>
          ) : s.status === 'finalized' ? (
            <button
              className="button primary"
              onClick={() => open('paid', 'Record external payment', s.id)}
            >
              Mark as paid
            </button>
          ) : null}
          {s.status !== 'draft' && !s.source_redacted_at && (
            <button
              className="button"
              onClick={() => open('adjustment', 'Record linked adjustment', s.id)}
            >
              Add correction
            </button>
          )}
          <button
            className="button"
            onClick={() =>
              download(
                `statement-${s.month}.csv`,
                s.lines.map((l) => ({
                  post_id: l.postId,
                  accounting_timezone: accountingTimezone,
                  publication_month: s.month,
                  campaign: campaignName(l.campaignId),
                  eligible_views: l.views,
                  base_usd: l.baseCents / 100,
                  bonus_usd: l.bonusCents / 100,
                }))
              )
            }
          >
            <Download size={15} />
            Export lines
          </button>
        </div>
        {data.adjustments
          .filter((a) => a.statement_id === s.id)
          .map((a) => (
            <div className="adjustment-card" key={a.id}>
              <div className="rule-line">
                <Badge tone={a.status === 'pending' ? 'amber' : 'purple'}>
                  {a.status} correction
                </Badge>
                <Money cents={a.proposed_cents} />
              </div>
              <p>{a.note}</p>
              <small>
                Corrected eligible views:{' '}
                {a.eligible_views === null ? 'Source erased' : number(a.eligible_views)}. Negative
                amounts are recoveries; the original publication-month cap still applies.
              </small>
              <div className="button-group">
                {a.status === 'pending' && (
                  <>
                    <button
                      className="button"
                      onClick={() =>
                        action({ type: 'approveAdjustment', adjustmentId: a.id, approve: true })
                      }
                    >
                      Approve correction
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        action({ type: 'approveAdjustment', adjustmentId: a.id, approve: false })
                      }
                    >
                      Reject
                    </button>
                  </>
                )}
                {a.status === 'approved' && (
                  <button
                    className="button"
                    onClick={() => open('payAdjustment', 'Record correction settlement', a.id)}
                  >
                    Record external settlement
                  </button>
                )}
              </div>
            </div>
          ))}
        <h3>Campaign allocation</h3>
        {[...new Set(s.lines.map((l) => l.campaignId))].map((c) => (
          <div className="rule-line" key={c}>
            <span>{campaignName(c)}</span>
            <b>
              <Money
                cents={s.lines
                  .filter((l) => l.campaignId === c)
                  .reduce((sum, l) => sum + l.baseCents + l.bonusCents, 0)}
              />
            </b>
          </div>
        ))}
        <h3>Post-level earnings</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Post</th>
                <th>Views</th>
                <th>Base</th>
                <th>Bonus</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.postId}>
                  <td>{data.posts.find((p) => p.id === l.postId)?.caption || l.postId}</td>
                  <td>{l.views === null ? 'Source erased' : number(l.views)}</td>
                  <td>
                    <Money cents={l.baseCents} />
                  </td>
                  <td>
                    <Money cents={l.bonusCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  function renderPanel() {
    if (!panel) return null;
    const id = panel.id;
    const p = data.posts.find((p) => p.id === id);
    const s = data.statements.find((s) => s.id === id);
    const creator = data.creators.find((c) => c.id === id);
    switch (panel.kind) {
      case 'app':
        return form(
          [
            nameField('App name'),
            { name: 'color', label: 'App color', type: 'color', value: '#a78bfa' },
          ],
          (v) => ({ type: 'createApp', name: v.name, color: v.color })
        );
      case 'campaign':
        return form(
          [
            { ...selectField('appId', 'App', appOptions), value: selectedApp },
            nameField('Campaign name'),
          ],
          (v) => ({
            type: 'createCampaign',
            appId: v.appId,
            name: v.name,
          })
        );
      case 'creator':
        return form(
          [
            nameField('Creator name'),
            { name: 'email', label: 'Email', type: 'email', required: false },
            { name: 'notes', label: 'Notes', type: 'textarea', required: false },
          ],
          (v) => ({ type: 'createCreator', name: v.name, email: v.email, notes: v.notes })
        );
      case 'editApp': {
        const a = data.apps.find((a) => a.id === id)!;
        return form(
          [
            { ...nameField('App name'), value: a.name },
            {
              ...selectField('status', 'Status', [
                option('active', 'Active'),
                option('archived', 'Archived'),
              ]),
              value: a.archived ? 'archived' : 'active',
            },
          ],
          (v) => ({
            type: 'updateEntity',
            entity: 'app',
            id: a.id,
            name: v.name,
            status: v.status as 'active' | 'archived',
          })
        );
      }
      case 'editCampaign': {
        const c = data.campaigns.find((c) => c.id === id)!;
        return form(
          [
            { ...nameField('Campaign name'), value: c.name },
            {
              ...selectField(
                'status',
                'Status',
                ['active', 'paused', 'archived'].map((v) => option(v, v))
              ),
              value: c.status,
            },
          ],
          (v) => ({
            type: 'updateEntity',
            entity: 'campaign',
            id: c.id,
            name: v.name,
            status: v.status as 'active' | 'paused' | 'archived',
          })
        );
      }
      case 'creatorDetail':
        return (
          creator && (
            <>
              <div className="detail-body">
                <h3>Campaign assignments</h3>
                {data.memberships
                  .filter((m) => m.creator_id === id)
                  .map((m) => (
                    <div className="rule-line" key={m.id}>
                      <span>{campaignName(m.campaign_id)}</span>
                      <small>
                        {date(m.starts_at)} → {m.ends_at ? date(m.ends_at) : 'Ongoing'}
                      </small>
                    </div>
                  ))}
                <button
                  className="text-button"
                  onClick={() => open('assignment', 'Assign creator to campaign', id)}
                >
                  <Plus size={15} />
                  Add assignment
                </button>
              </div>
              {form(
                [
                  { ...nameField('Creator name'), value: creator.name },
                  {
                    name: 'email',
                    label: 'Email',
                    type: 'email',
                    value: creator.email,
                    required: false,
                  },
                  {
                    name: 'notes',
                    label: 'Notes',
                    type: 'textarea',
                    value: creator.notes,
                    required: false,
                  },
                ],
                (v) => ({
                  type: 'updateEntity',
                  entity: 'creator',
                  id: creator.id,
                  name: v.name,
                  email: v.email,
                  notes: v.notes,
                })
              )}
            </>
          )
        );
      case 'assignment':
        return form(
          [
            { ...selectField('creatorId', 'Creator', creatorOptions), value: id },
            selectField('campaignId', 'Campaign', campaignOptions),
            {
              name: 'startsAt',
              label: 'Start date and time',
              type: 'text',
              value: localTime(),
            },
            { name: 'endsAt', label: 'End date and time', type: 'text', required: false },
          ],
          (v) => ({
            type: 'assignCreator',
            creatorId: v.creatorId,
            campaignId: v.campaignId,
            startsAt: iso(v.startsAt),
            endsAt: v.endsAt ? iso(v.endsAt) : null,
          })
        );
      case 'account':
        return form(
          [
            selectField('creatorId', 'Creator', creatorOptions),
            selectField(
              'platform',
              'Platform',
              platforms.map((p) => option(p, p))
            ),
            { name: 'username', label: 'Username, YouTube channel ID or Facebook numeric Page ID' },
            selectField('ownership', 'Account owner', [
              option('creator', 'Creator-owned'),
              option('company', 'Company-owned'),
            ]),
            selectField('provider', 'Tracking provider', [
              option('zernio', 'Zernio (TikTok pilot)'),
              option('manual', 'Manual / CSV'),
              option('direct', 'Official API · YouTube / Instagram / Facebook'),
            ]),
          ],
          (v) => ({
            type: 'registerAccount',
            creatorId: v.creatorId,
            platform: v.platform as Post['platform'],
            username: v.username,
            ownership: v.ownership as 'creator' | 'company',
            provider: v.provider as 'zernio' | 'manual' | 'direct',
          })
        );
      case 'mapping':
        return form(
          [
            { ...selectField('accountId', 'Social account', accountOptions), value: id },
            selectField(
              'membershipId',
              'Creator campaign assignment',
              data.memberships.map((m) =>
                option(m.id, `${creatorName(m.creator_id)} · ${campaignName(m.campaign_id)}`)
              )
            ),
            {
              name: 'startsAt',
              label: 'Effective from',
              type: 'text',
              value: localTime(),
            },
            {
              name: 'endsAt',
              label: 'Effective until (optional)',
              type: 'text',
              required: false,
            },
          ],
          (v) => ({
            type: 'mapAccount',
            accountId: v.accountId,
            membershipId: v.membershipId,
            startsAt: iso(v.startsAt),
            endsAt: v.endsAt ? iso(v.endsAt) : null,
          })
        );
      case 'addPost':
        return form(
          [
            selectField('accountId', 'Account', accountOptions),
            { name: 'platformPostId', label: 'Native platform video ID' },
            { name: 'url', label: 'Public post URL' },
            { name: 'caption', label: 'Caption / internal title', required: false },
            {
              name: 'publishedAt',
              label: 'Published at',
              type: 'text',
              value: localTime(),
            },
            selectField('campaignId', 'Campaign', [
              option('', 'Use automatic account routing'),
              ...campaignOptions,
            ]),
          ],
          (v) => ({
            type: 'addPost',
            input: {
              accountId: v.accountId,
              platformPostId: v.platformPostId,
              url: v.url,
              caption: v.caption,
              publishedAt: iso(v.publishedAt),
              campaignId: v.campaignId || null,
            },
          })
        );
      case 'snapshot':
        return (
          p &&
          form(
            [
              { name: 'views', label: 'Cumulative view count', type: 'number', min: '0' },
              selectField('metric', 'Metric', [
                option('public_views', 'Public views (unverified)'),
                option('organic_views', 'Organic views (evidence required)'),
                option('paid_views', 'Paid views (never eligible)'),
                option('uncertain_views', 'Uncertain views'),
              ]),
              {
                name: 'observedAt',
                label: 'Observed at',
                type: 'text',
                value: localTime(),
              },
              {
                name: 'evidence',
                label: 'Evidence URL / notes',
                type: 'textarea',
                help: 'Record the original analytics or export source and its reporting cutoff.',
              },
            ],
            (v) => ({
              type: 'addSnapshot',
              input: {
                postId: p.id,
                views: Number(v.views),
                metric: v.metric as Snapshot['metric'],
                observedAt: iso(v.observedAt),
                providerUpdatedAt: null,
                evidence: v.evidence,
                source: 'manual',
              },
            })
          )
        );
      case 'attribute':
        return (
          p &&
          form([selectField('campaignId', 'Campaign', campaignOptions)], (v) => ({
            type: 'attributePost',
            postId: p.id,
            campaignId: v.campaignId,
          }))
        );
      case 'review':
        return (
          p && (
            <>
              <div className="info-box">
                <TriangleAlert size={18} />
                <p>
                  Review paid/boosted traffic, suspicious traffic, and the exact window cutoff. A
                  public lifetime counter alone does not verify eligible organic views. Recording
                  this decision creates an audit entry.
                </p>
              </div>
              {form(
                [
                  ...(p.tracking?.contentType === 'shorts_candidate'
                    ? [
                        selectField(
                          'shortsConfirmed',
                          'Evidence confirms this is a YouTube Short',
                          [option('no', 'Not confirmed'), option('yes', 'Confirmed by evidence')]
                        ),
                      ]
                    : []),
                  selectField('decision', 'Decision', [
                    option('accepted', 'Accept verified eligible views'),
                    option('excluded', 'Exclude post'),
                  ]),
                  {
                    name: 'eligibleViews',
                    label: 'Verified organic views inside the window',
                    type: 'number',
                    min: '0',
                    value: String(p.eligible_views || 0),
                  },
                  {
                    name: 'evidenceReference',
                    label: 'Analytics export / evidence reference',
                    type: 'textarea',
                    required: false,
                    help: 'Provide an auditable source that verifies organic views and the exact publication-to-deadline window.',
                  },
                  {
                    name: 'windowStart',
                    label: 'Evidence window start',
                    value: p.published_at,
                    type: 'text',
                    required: false,
                  },
                  {
                    name: 'windowEnd',
                    label: 'Evidence window end',
                    value: p.deadline || '',
                    type: 'text',
                    required: false,
                  },
                  selectField('organicConfirmed', 'Does the evidence verify organic attribution?', [
                    option('no', 'Not verified'),
                    option('yes', 'Yes, verified from the cited evidence'),
                  ]),
                  selectField(
                    'cutoffConfirmed',
                    'Does the evidence verify the exact eligibility window?',
                    [
                      option('no', 'Not verified'),
                      option('yes', 'Yes, verified from the cited evidence'),
                    ]
                  ),
                  {
                    name: 'note',
                    label: 'Evidence and decision rationale',
                    type: 'textarea',
                    help: 'Include evidence for the cutoff and organic eligibility. At least 5 characters.',
                  },
                ],
                (v) => ({
                  type: 'reviewPost',
                  postId: p.id,
                  decision: v.decision as 'accepted' | 'excluded',
                  eligibleViews: Number(v.eligibleViews),
                  note: v.note,
                  ...(v.decision === 'accepted'
                    ? {
                        evidence: {
                          reference: v.evidenceReference,
                          windowStart: iso(v.windowStart),
                          windowEnd: iso(v.windowEnd),
                          shortsConfirmed: v.shortsConfirmed === 'yes',
                          organicConfirmed: v.organicConfirmed === 'yes',
                          cutoffConfirmed: v.cutoffConfirmed === 'yes',
                        },
                      }
                    : {}),
                }),
                'Save eligibility decision'
              )}
            </>
          )
        );
      case 'post':
        return p && postDetail(p);
      case 'rules':
        return <RulesEditor data={data} defaultAppId={selectedApp || ''} onSave={execute} />;
      case 'statement':
        return form(
          [
            { ...selectField('appId', 'App', appOptions), value: selectedApp },
            selectField('creatorId', 'Creator', creatorOptions),
            {
              name: 'month',
              label: 'Publication month',
              type: 'month',
              value: previousAccountingMonth(),
            },
          ],
          (v) => ({
            type: 'generateStatement',
            appId: v.appId,
            creatorId: v.creatorId,
            month: v.month,
          }),
          'Generate statement'
        );
      case 'statementDetail':
        return s && statementDetail(s);
      case 'bonus':
        return (
          s &&
          form(
            [
              {
                name: 'amount',
                label: 'Approved bonus (USD)',
                type: 'number',
                min: '0',
                step: '0.01',
                value: String(s.potential_bonus_cents / 100),
                help: 'Enter 0 to reject. Partial approval is supported.',
              },
              {
                name: 'note',
                label: 'Approval / rejection rationale',
                type: 'textarea',
                required: false,
              },
            ],
            (v) => ({
              type: 'approveBonus',
              statementId: s.id,
              amountCents: Math.round(Number(v.amount) * 100),
              note: v.note,
            }),
            'Save bonus decision'
          )
        );
      case 'paid':
        return (
          s &&
          form(
            [
              {
                name: 'amount',
                label: 'Payment amount (USD)',
                type: 'number',
                min: '0',
                step: '0.01',
                value: String(s.payable_cents / 100),
              },
              {
                name: 'paidAt',
                label: 'Payment date and time',
                type: 'text',
                value: localTime(),
              },
              { name: 'reference', label: 'External payment reference' },
            ],
            (v) => ({
              type: 'markPaid',
              statementId: s.id,
              amountCents: Math.round(Number(v.amount) * 100),
              paidAt: iso(v.paidAt),
              reference: v.reference,
            }),
            'Record payment'
          )
        );
      case 'adjustment':
        return (
          s &&
          form(
            [
              selectField(
                'postId',
                'Original post',
                data.posts
                  .filter(
                    (p) =>
                      p.app_id === s.app_id &&
                      p.creator_id === s.creator_id &&
                      publicationMonth(p.published_at) === s.month
                  )
                  .map((p) => option(p.id, p.caption || p.platform_post_id))
              ),
              {
                name: 'eligibleViews',
                label: 'Corrected eligible view total',
                type: 'number',
                min: '0',
              },
              { name: 'note', label: 'Evidence and reason for correction', type: 'textarea' },
              {
                name: 'evidenceReference',
                label: 'Auditable analytics evidence reference',
                type: 'textarea',
              },
              selectField('organicConfirmed', 'Organic attribution verified?', [
                option('no', 'Not verified'),
                option('yes', 'Yes, verified'),
              ]),
              selectField('cutoffConfirmed', 'Exact window verified?', [
                option('no', 'Not verified'),
                option('yes', 'Yes, verified'),
              ]),
            ],
            (v) => ({
              type: 'adjustment',
              statementId: s.id,
              postId: v.postId,
              eligibleViews: Number(v.eligibleViews),
              note: v.note,
              evidence: {
                reference: v.evidenceReference,
                windowStart: data.posts.find((p) => p.id === v.postId)!.published_at,
                windowEnd: data.posts.find((p) => p.id === v.postId)!.deadline!,
                organicConfirmed: v.organicConfirmed === 'yes',
                cutoffConfirmed: v.cutoffConfirmed === 'yes',
              },
            }),
            'Record correction'
          )
        );
      case 'payAdjustment':
        return form(
          [
            { name: 'reference', label: 'External payment / recovery reference' },
            { name: 'paidAt', label: 'Settled at', type: 'text', value: localTime() },
          ],
          (v) => ({
            type: 'payAdjustment',
            adjustmentId: id!,
            reference: v.reference,
            paidAt: iso(v.paidAt),
          }),
          'Record settlement'
        );
      case 'authorization':
        return (
          <div className="detail-body">
            <div className="info-box">
              <Link2 size={18} />
              <p>
                Send this one-use authorization link to the creator. They connect their registered
                social account through Zernio without receiving administrator access. The dashboard
                ticket expires after 30 minutes.
              </p>
            </div>
            <label className="field">
              Creator authorization link
              <input readOnly value={connectionUrl} onFocus={(e) => e.target.select()} />
            </label>
            <div className="button-group">
              <button
                className="button primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(connectionUrl);
                    setToast('Creator connection link copied');
                  } catch {
                    setToast('Select and copy the link above.');
                  }
                }}
              >
                Copy link
              </button>
              <a className="button" target="_blank" rel="noreferrer" href={connectionUrl}>
                Open authorization
                <ExternalLink size={14} />
              </a>
            </div>
            <p className="subtle">
              After authorization, refresh Social accounts to see the connection. Treat this link as
              private.
            </p>
          </div>
        );
      case 'disconnect':
        return (
          <div className="detail-body">
            <p>
              Disconnecting stops future syncs. Local posts, snapshots, and statements are retained.
              Zernio documents a one-hour grace period before permanent deletion of its account
              data. Reconnect before that expires to restore its link.
            </p>
            <button className="button danger" onClick={() => connection(id!, 'disconnect')}>
              Disconnect account
            </button>
          </div>
        );
      case 'import':
        return <ImportPanel data={data} onImport={async (c) => execute(c)} />;
      default:
        return null;
    }
  }
  return (
    <div className="dashboard-shell">
      <aside className={`sidebar ${menu ? 'is-open' : ''}`}>
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Layers size={21} />
          </span>
          Creator<span>Ledger</span>
        </Link>
        <div className="workspace-label">PRIVATE WORKSPACE</div>
        <label className="app-switcher">
          <Layers size={17} />
          <select
            aria-label="Switch app"
            value={appId}
            onChange={(e) => {
              setAppId(e.target.value);
              setCampaignFilter('all');
            }}
          >
            <option value="all">All apps</option>
            {data.apps
              .filter((a) => !a.archived)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <div className="nav-label">MANAGE</div>
        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              className={view === label ? 'active' : ''}
              onClick={() => {
                setView(label);
                setQuery('');
                setMenu(false);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {label === 'Needs attention' && held.length > 0 && <em>{held.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-note">
            <span className="online-dot" />
            <span>{preview ? 'LOCAL PREVIEW' : 'PRIVATE WORKSPACE'}</span>
            <small>{preview ? 'Sample data · no connections' : 'Single administrator · USD'}</small>
          </div>
          <div className="admin-profile">
            <Avatar name="Admin" />
            <div>
              <strong>Workspace admin</strong>
              <small>Creator operations</small>
            </div>
            {!preview && (
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={async () => {
                  await fetch('/api/auth', { method: 'DELETE' });
                  router.push('/');
                  router.refresh();
                }}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong>{view}</strong>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={16} />
              <input
                aria-label="Search creators or posts"
                placeholder="Search creators or posts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>⌕</kbd>
            </label>
            <button className="icon-button" aria-label="Refresh data" onClick={refresh}>
              <RefreshCw size={17} />
            </button>
            <Avatar name="Admin" />
          </div>
        </header>
        {preview && (
          <div className="preview-banner">
            <span>
              <b>Local preview</b> · Sample data. Changes last until refresh. No external
              connections.
            </span>
            <Link href="/">
              Setup guide <ArrowUpRight size={13} />
            </Link>
          </div>
        )}
        <main className="main-content">
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {toast && (
            <div className="toast-message" role="status">
              <Check size={16} />
              {toast}
              <button onClick={() => setToast('')} aria-label="Dismiss notification">
                ×
              </button>
            </div>
          )}
          {view === 'Overview' ? (
            overview()
          ) : view === 'Apps & campaigns' ? (
            appsView()
          ) : view === 'Creators' ? (
            creatorsView()
          ) : view === 'Social accounts' ? (
            accountView()
          ) : view === 'Compensation' ? (
            compensationView()
          ) : view === 'Monthly payouts' ? (
            payoutsView()
          ) : view === 'Needs attention' ? (
            attentionView()
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>Posts & performance</h1>
                  <p>Every published post, with a history you can trust.</p>
                </div>
                <div className="button-group">
                  <button
                    className="button"
                    onClick={() => open('import', 'Import posts or observations')}
                  >
                    <Download size={15} />
                    Import CSV
                  </button>
                  {addButton('addPost', 'Add a post', 'Add post')}
                </div>
              </div>
              <div className="info-box">
                <Clapperboard size={18} />
                <p>
                  {number(publicViews)} public views · {number(eligibleViews)} verified eligible
                  views · {posts.length} posts. Click a post to see history, campaign attribution,
                  and eligibility evidence.
                </p>
              </div>
              <section className="card">
                <div className="section-heading">
                  <h2>Tracked posts</h2>
                  <select
                    className="filter-select"
                    aria-label="Filter campaign"
                    value={campaignFilter}
                    onChange={(e) => setCampaignFilter(e.target.value)}
                  >
                    <option value="all">All campaigns</option>
                    {campaignOptions.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                {postTable(posts)}
              </section>
            </>
          )}
        </main>
        <footer className="dashboard-footer">
          <span>Creator Ledger</span>
          <span>Private workspace · Accounting and display timezone: America/New_York · USD</span>
        </footer>
      </div>
      {panel && (
        <Drawer title={panel.title} onClose={() => setPanel(null)}>
          {error && (
            <p className="form-error padded" role="alert">
              {error}
            </p>
          )}
          {renderPanel()}
        </Drawer>
      )}
    </div>
  );
}
function ImportPanel({
  data,
  onImport,
}: {
  data: DashboardData;
  onImport: (command: Command) => Promise<void>;
}) {
  const [kind, setKind] = useState('posts');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const headers =
    kind === 'posts'
      ? ['account_id', 'platform_post_id', 'url', 'published_at', 'caption', 'campaign_id']
      : ['post_id', 'views', 'metric', 'observed_at', 'evidence'];
  return (
    <div className="detail-body">
      <div className="info-box">
        <Download size={18} />
        <p>
          Imports are validated atomically and never automatically treated as organic. Dates must
          use ISO 8601 with a timezone. Export a template to get started.
        </p>
      </div>
      <label className="field">
        Import type
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setRows([]);
            setError('');
          }}
        >
          <option value="posts">Posts</option>
          <option value="snapshots">Metric observations</option>
        </select>
      </label>
      <button
        className="text-button"
        onClick={() =>
          download(`ugc-${kind}-template.csv`, [Object.fromEntries(headers.map((h) => [h, '']))])
        }
      >
        <Download size={15} />
        Download template
      </button>
      <p className="subtle">{kind === 'posts' ? 'Account references:' : 'Post references:'}</p>
      <div className="reference-list">
        {(kind === 'posts'
          ? data.accounts.map((a) => ({ id: a.id, label: `${a.platform} @${a.username}` }))
          : data.posts.map((p) => ({ id: p.id, label: p.caption || p.platform_post_id }))
        ).map((x) => (
          <div key={x.id}>
            <strong>{x.label}</strong>
            <code>{x.id}</code>
          </div>
        ))}
      </div>
      <label className="field">
        CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            setError('');
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 2000000) {
              setError('Maximum file size is 2 MB.');
              return;
            }
            Papa.parse<Record<string, string>>(f, {
              header: true,
              skipEmptyLines: 'greedy',
              complete: (r) => {
                if (r.errors.length) {
                  setError(r.errors[0].message);
                  return;
                }
                if (
                  headers
                    .filter((h) => !['caption', 'campaign_id', 'evidence'].includes(h))
                    .some((h) => !r.meta.fields?.includes(h))
                ) {
                  setError('Required CSV columns are missing. Use the template.');
                  return;
                }
                setRows(r.data);
              },
            });
          }}
        />
      </label>
      {rows.length > 0 && (
        <>
          <p>{rows.length} row(s) ready for validation</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {headers.map((h) => (
                      <td key={h}>{r[h]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onImport({
                  type: 'importRows',
                  posts:
                    kind === 'posts'
                      ? rows.map((r) => ({
                          accountId: r.account_id,
                          platformPostId: r.platform_post_id,
                          url: r.url,
                          publishedAt: r.published_at,
                          caption: r.caption || '',
                          campaignId: r.campaign_id || null,
                        }))
                      : [],
                  snapshots:
                    kind === 'snapshots'
                      ? rows.map((r) => ({
                          postId: r.post_id,
                          views: Number(r.views),
                          metric: r.metric as Snapshot['metric'],
                          observedAt: r.observed_at,
                          providerUpdatedAt: null,
                          evidence: r.evidence || '',
                          source: 'csv',
                        }))
                      : [],
                });
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Import failed.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Importing…' : 'Validate and import'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
