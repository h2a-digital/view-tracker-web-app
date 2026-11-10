'use client';
import { usableThumbnail } from '@/domain/post-media';
import {
  withThumbnailOverrides,
  workspaceDisplayTime,
  type ThumbnailOverride,
} from '@/domain/thumbnail-overrides';
import { Input, Select, DropdownMenu, DropdownItem, Tooltip } from '@/components/ui/controls';
import { PostGrid, postPublicViews } from './PostGrid';
import { Overview } from './Overview';
import { postReview } from '@/domain/post-review';
import { auditDescription, ruleDescription, ruleScopeLabels } from '@/domain/presentation';
import { Analytics } from './Analytics';
import { AsyncButton } from './AsyncButton';
import { requestJson } from '@/lib/client/request';
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
import { useState, useRef, useEffect } from 'react';
import {
  LayoutDashboard,
  Layers,
  Megaphone,
  Users,
  Link2,
  Clapperboard,
  Grid2X2,
  Table2,
  Wallet,
  Settings2,
  TriangleAlert,
  Plus,
  ArrowUpRight,
  Search,
  Download,
  RefreshCw,
  LogOut,
  Check,
  Menu,
  GitBranch,
  ExternalLink,
  MoreHorizontal,
  Archive,
  Trash2,
  Camera,
  Globe,
  Music2,
} from 'lucide-react';
import Papa from 'papaparse';
import type { DashboardData, Post, Statement, Snapshot, SocialAccount } from '@/domain/model';
import { platforms } from '@/domain/model';
import { runCommand } from '@/domain/commands';
import {
  calculateStatement,
  fixedCents,
  publicationMonth,
  resolveRules,
} from '@/domain/compensation';
import type { Command } from '@/domain/validation';
import {
  Drawer,
  ConfirmationActions,
  Badge,
  Empty,
  Money,
  number,
  date,
  Avatar,
  AccountAvatar,
} from './Primitives';
import { FormPanel, type Field } from './FormPanel';
import { RulesEditor } from './RulesEditor';
const nav = [
  ['Overview', LayoutDashboard],
  ['Analytics', GitBranch],
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
  thumbnailPreviewOnly = false,
  initialAsOf,
}: {
  initial: DashboardData;
  preview?: boolean;
  thumbnailPreviewOnly?: boolean;
  initialAsOf?: string;
}) {
  const router = useRouter();
  const [mountedAt, setMountedAt] = useState(() =>
    workspaceDisplayTime(0, new Date().getTime(), initialAsOf)
  );
  const [storedData, setStoredData] = useState(initial);
  const [thumbnailOverrides, setThumbnailOverrides] = useState<ThumbnailOverride[]>([]);
  const data = withThumbnailOverrides(storedData, thumbnailOverrides, mountedAt);
  function applyWorkspace(next: DashboardData, asOf?: string) {
    setStoredData(next);
    setMountedAt((previous) => workspaceDisplayTime(previous, Date.now(), asOf));
  }
  const [view, setView] = useState<string>('Overview');
  const [postView, setPostView] = useState<'grid' | 'table'>('grid');
  const [appId, setAppId] = useState('all');
  const [query, setQuery] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [panel, setPanel] = useState<{ title: string; kind: string; id?: string } | null>(null);
  const [toast, setToast] = useState('');
  const [connectionUrl, setConnectionUrl] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const mutation = useRef(false);
  const [disconnectImpact, setDisconnectImpact] = useState<
    { id: string; platform: string; username: string }[]
  >([]);
  const [sharedConfirmed, setSharedConfirmed] = useState(false);
  const [queued, setQueued] = useState<Record<string, number>>({});
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  const [menu, setMenu] = useState(false);
  const appName = (id: string | null) => data.apps.find((a) => a.id === id)?.name || 'Unassigned';
  const creatorName = (id: string) =>
    data.creators.find((c) => c.id === id)?.name || 'Unknown creator';
  const campaignName = (id: string | null) =>
    data.campaigns.find((c) => c.id === id)?.name || 'Needs assignment';
  const campaignOptions = data.campaigns
    .filter((c) => appId === 'all' || c.app_id === appId)
    .filter((c) => c.status !== 'archived' && !data.apps.find((a) => a.id === c.app_id)?.archived)
    .map((c) => option(c.id, `${appName(c.app_id)} · ${c.name}`));
  const creatorOptions = data.creators.filter((c) => !c.archived).map((c) => option(c.id, c.name));
  const appOptions = data.apps.filter((a) => !a.archived).map((a) => option(a.id, a.name));
  const accountOptions = data.accounts
    .filter((a) => !a.archived)
    .map((a) => option(a.id, `${creatorName(a.creator_id)} · ${a.platform} ${accountTitle(a)}`));
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
      (showArchived || !c.archived) &&
      (appId === 'all' ||
        data.memberships.some(
          (m) => m.creator_id === c.id && campaigns.some((x) => x.id === m.campaign_id)
        )) &&
      (!query || `${c.name} ${c.email}`.toLowerCase().includes(query.toLowerCase()))
  );
  const scopedCreators = new Set(
    data.creators
      .filter(
        (c) =>
          (showArchived || !c.archived) &&
          (appId === 'all' ||
            data.memberships.some(
              (m) =>
                m.creator_id === c.id && campaigns.some((campaign) => campaign.id === m.campaign_id)
            ))
      )
      .map((c) => c.id)
  );
  const accounts = data.accounts.filter(
    (a) =>
      scopedCreators.has(a.creator_id) &&
      (showArchived || !a.archived) &&
      (!query ||
        `${accountTitle(a)} ${a.username} ${creatorName(a.creator_id)}`
          .toLowerCase()
          .includes(query.toLowerCase()))
  );
  function accountProfile(a: SocialAccount) {
    const channel = a.platform === 'youtube' ? a.integration?.channelIdentity : undefined;
    return channel
      ? {
          name: channel.title,
          username: channel.handle?.replace(/^@/, ''),
          avatarUrl: channel.avatarUrl,
          refreshedAt: channel.refreshedAt,
        }
      : a.integration?.profileMetadata;
  }
  function accountTitle(a: SocialAccount) {
    return (
      accountProfile(a)?.name ||
      (a.platform === 'youtube'
        ? 'YouTube channel'
        : `@${accountProfile(a)?.username || a.username}`)
    );
  }
  function recordMenu(
    entity: 'app' | 'campaign' | 'creator' | 'account',
    id: string,
    archived = false
  ) {
    return (
      <DropdownMenu
        trigger={
          <button type="button" className="icon-button" aria-label={`Manage ${entity}`}>
            <MoreHorizontal size={18} />
          </button>
        }
      >
        {entity === 'creator' && (
          <DropdownItem onSelect={() => open('creatorDetail', 'Edit creator', id)}>
            <Settings2 size={15} />
            Edit creator
          </DropdownItem>
        )}
        <DropdownItem
          onSelect={() =>
            open(
              `manage-${archived ? 'restore' : 'archive'}-${entity}`,
              archived ? 'Restore record' : 'Archive record',
              id
            )
          }
        >
          <Archive size={15} />
          {archived ? 'Restore' : 'Archive'}
        </DropdownItem>
        <DropdownItem
          destructive
          onSelect={() => open(`manage-remove-${entity}`, 'Remove unused record', id)}
        >
          <Trash2 size={15} />
          Remove unused {entity}
        </DropdownItem>
      </DropdownMenu>
    );
  }

  async function manage(entity: string, id: string, operation: string) {
    if (preview) {
      setToast('Record removal and archival are disabled in local preview.');
      return;
    }
    if (mutation.current) return;
    mutation.current = true;
    setError('');
    setToast('');
    try {
      const result = await requestJson<{ data: DashboardData }>('/api/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity, id, operation }),
      });
      applyWorkspace(result.data);
      setPanel(null);
      setToast(
        operation === 'remove'
          ? 'Unused record removed'
          : operation === 'restore'
            ? 'Record restored'
            : 'Record archived; history retained'
      );
      if (entity === 'app' && operation === 'remove' && id === appId) setAppId('all');
    } finally {
      mutation.current = false;
    }
  }
  async function prepareDisconnect(a: SocialAccount) {
    setSharedConfirmed(false);
    setDisconnectImpact([]);
    if (a.provider === 'direct' && !preview) {
      const result = await requestJson<{ accounts: typeof disconnectImpact }>(
        `/api/manage?accountId=${encodeURIComponent(a.id)}`
      );
      setDisconnectImpact(result.accounts);
    }
    open('disconnect', 'Disconnect account', a.id);
  }
  useEffect(() => {
    if (preview || !Object.keys(queued).length) return;
    const timer = setInterval(() => {
      void refresh(true);
    }, 30000);
    return () => clearInterval(timer);
    // Poll only while an administrator-requested sync is pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, preview]);
  const statements = data.statements.filter((s) => appId === 'all' || s.app_id === appId);
  const reviewFor = (p: Post) => postReview(data, p, new Date(mountedAt).toISOString());
  const held = posts.filter((p) => reviewFor(p).stage === 'review');
  const historical = posts.filter((p) => reviewFor(p).stage === 'historical');
  const excludableHistorical = historical.filter((p) => !isLocked(data, p));
  const problems = accounts.filter(
    (a) =>
      a.status === 'attention' ||
      a.error ||
      (a.status === 'connected' &&
        a.last_synced_at &&
        Date.parse(a.last_synced_at) < mountedAt - 26 * 3600000)
  );
  const aggregateViews = (p: Post) => postPublicViews(data, p) ?? 0;
  const publicViews = posts.reduce((sum, p) => sum + aggregateViews(p), 0);
  const eligibleViews = posts.reduce((sum, p) => sum + (p.eligible_views || 0), 0);
  const selectedApp = appId === 'all' ? data.apps[0]?.id : appId;
  async function execute(command: Command, close = true) {
    if (mutation.current) throw new Error('Another change is still saving. Please wait.');
    mutation.current = true;
    setError('');
    setToast('');
    try {
      let notice: string | undefined;
      if (preview) {
        applyWorkspace(runCommand(data, command, 'preview administrator'));
      } else {
        const v = await requestJson<{ data: DashboardData; notice?: string }>('/api/dashboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        });
        applyWorkspace(v.data, 'asOf' in v ? (v.asOf as string) : undefined);
        notice = v.notice;
      }
      if (close) setPanel(null);
      setToast(notice || 'Changes saved');
    } finally {
      mutation.current = false;
    }
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
    setError('');
    setToast('');
    try {
      const v = await requestJson<{ authUrl?: string }>('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id, action, confirmShared: sharedConfirmed }),
      });
      if (v.authUrl) {
        setConnectionUrl(v.authUrl);
        open(
          action === 'deletion-link' ? 'deletionLink' : 'authorization',
          action === 'deletion-link'
            ? 'Private source-deletion link'
            : 'Authorize social account tracking',
          id
        );
        return;
      }
      setPanel(null);
      setToast('Account disconnected');
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.');
    }
  }
  async function refresh(silent = false) {
    if (preview) return;
    if (!silent) setRefreshing(true);
    try {
      const v = await requestJson<{ data: DashboardData; asOf?: string }>('/api/dashboard', {
        cache: 'no-store',
      });
      applyWorkspace(v.data, 'asOf' in v ? (v.asOf as string) : undefined);
      setError('');
      const completed = Object.keys(queued).filter(
        (id) =>
          Date.parse(v.data.accounts.find((a) => a.id === id)?.last_synced_at || '') >= queued[id]
      );
      const expired = Object.keys(queued).filter((id) => Date.now() - queued[id] > 5 * 60000);
      if (completed.length || expired.length) {
        setQueued((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([id]) => !completed.includes(id) && !expired.includes(id)
            )
          )
        );
        setToast(
          completed.length
            ? 'Synchronization finished. Check diagnostics for errors and metric freshness.'
            : 'Sync has not been confirmed yet. Check Automation health before retrying.'
        );
      } else if (!silent) setToast('Workspace refreshed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }
  async function refreshProfileDetails(accountId: string) {
    if (preview) {
      setToast('Preview does not call profile APIs.');
      return;
    }
    setError('');
    setToast('');
    const result = await requestJson<{ data: DashboardData; result: { status: string } }>(
      '/api/accounts/profile',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      }
    );
    applyWorkspace(result.data);
    if (result.result.status === 'updated') setToast('Profile details updated');
    else if (result.result.status === 'cached')
      setToast('Profile was checked recently or is already refreshing. Please wait a minute.');
    else
      setError(
        'Profile refresh is temporarily unavailable. Cached details were retained; automatic retries continue.'
      );
  }
  async function loadPreviews(accountId: string) {
    if (preview) {
      setToast('Preview does not call external APIs.');
      return;
    }
    setError('');
    setToast('');
    const response = await requestJson<{
      data: DashboardData;
      asOf: string;
      overrides: ThumbnailOverride[];
      result: {
        mode: 'session' | 'database';
        available: number;
        requested: number;
        unavailable: number;
        deferred: boolean;
      };
    }>('/api/accounts/thumbnails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    if (response.result.mode === 'session')
      setThumbnailOverrides((current) => [
        ...current.filter(
          (value) => !response.overrides.some((incoming) => incoming.postId === value.postId)
        ),
        ...response.overrides,
      ]);
    applyWorkspace(response.data, response.asOf);
    if (response.result.available)
      setToast(
        `${response.result.available} previews loaded${response.result.mode === 'session' ? ' for this page only; shared Supabase was not changed' : ' and saved'}.${response.result.unavailable ? ` ${response.result.unavailable} remain unavailable.` : ''}`
      );
    else if (!response.result.requested) setToast('All available previews are already cached.');
    else
      setError(
        response.result.deferred
          ? 'Preview refresh was deferred. Try again shortly.'
          : 'The provider did not supply usable previews. Existing images were preserved.'
      );
  }
  async function sync(id: string) {
    if (preview) {
      setToast('Preview does not call external APIs.');
      return;
    }
    setError('');
    setToast('');
    const requestedAt = Date.now();
    try {
      await requestJson('/api/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id }),
      });
      setQueued((current) => ({ ...current, [id]: requestedAt }));
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
    <AsyncButton className="button primary" onClick={() => open(kind, title)}>
      <Plus size={16} />
      {label}
    </AsyncButton>
  );
  const nameField = (label = 'Name'): Field => ({ name: 'name', label });
  const selectField = (
    name: string,
    label: string,
    options: { value: string; label: string }[]
  ): Field => ({
    name,
    label,
    type: 'select',
    options,
    required: !options.some((o) => o.value === ''),
  });
  function form(fields: Field[], fn: (v: Record<string, string>) => Command, label?: string) {
    return <FormPanel fields={fields} submitLabel={label} onSubmit={async (v) => execute(fn(v))} />;
  }
  const publicCount = (p: Post) => {
    const views = postPublicViews(data, p);
    return views === null ? '—' : number(views);
  };
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
        {publicCount(p)}
        <small>public views</small>
      </td>
      <td>{p.eligible_views === null ? '—' : number(p.eligible_views)}</td>
      <td>
        <Badge
          tone={
            reviewFor(p).stage === 'ready'
              ? 'green'
              : reviewFor(p).stage === 'review'
                ? 'amber'
                : 'neutral'
          }
        >
          {reviewFor(p).label}
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
      <Overview
        data={data}
        appId={appId}
        query={query}
        now={mountedAt}
        onNavigate={setView}
        onOpenPost={(post) => open('post', 'Post details', post.id)}
      />
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
            .filter((a) => (showArchived || !a.archived) && (appId === 'all' || a.id === appId))
            .map((a) => (
              <section className="card app-card" key={a.id}>
                <div className="app-card-heading">
                  <Avatar name={a.name} color={a.color} />
                  <div>
                    <h2>{a.name}</h2>
                    <small>{a.archived ? 'Archived' : 'Active app'}</small>
                  </div>
                  <AsyncButton
                    className="text-button"
                    onClick={() => open('editApp', 'Manage app', a.id)}
                  >
                    Manage
                  </AsyncButton>
                  {recordMenu('app', a.id, a.archived)}
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
                    <div key={c.id} className="campaign-row">
                      <AsyncButton
                        className="campaign-open"
                        onClick={() => open('editCampaign', 'Manage campaign', c.id)}
                      >
                        <Megaphone size={16} />
                        <span>{c.name}</span>
                        <Badge tone={c.status === 'active' ? 'green' : 'neutral'}>{c.status}</Badge>
                        <ArrowUpRight size={15} />
                      </AsyncButton>
                      {recordMenu('campaign', c.id, c.status === 'archived')}
                    </div>
                  ))}
                <AsyncButton
                  className="text-button"
                  onClick={() => {
                    setAppId(a.id);
                    open('campaign', 'Create campaign');
                  }}
                >
                  <Plus size={15} />
                  Add campaign
                </AsyncButton>
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
                      onClick={() => open('creatorDetail', `Edit ${c.name}`, c.id)}
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
                        <div onClick={(e) => e.stopPropagation()}>
                          {recordMenu('creator', c.id, !!c.archived)}
                        </div>
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
            <span className="eyebrow">CREATOR CONNECTIONS</span>
            <h1>Social accounts</h1>
            <p>Account health, campaign routing and tracking in one place.</p>
          </div>
          <div className="button-group">
            {addButton('mapping', 'Map account to campaign', 'Route posts')}
            {addButton('account', 'Register social account', 'Add account')}
          </div>
        </div>
        <div className="account-summary">
          <span>
            <b>{accounts.length}</b> accounts
          </span>
          <span className="status-good">
            <b>{accounts.filter((a) => a.status === 'connected' && !a.error).length}</b> connected
          </span>
          <span>
            <b>{accounts.filter((a) => a.error || a.status === 'attention').length}</b> need
            attention
          </span>
          <span>Automatic discovery · Daily snapshots</span>
        </div>
        <div className="account-grid">
          {accounts.map((a) => {
            const identity = accountProfile(a);
            const Icon = {
              youtube: Clapperboard,
              instagram: Camera,
              tiktok: Music2,
              facebook: Globe,
            }[a.platform];
            const routes = data.mappings.filter(
              (m) =>
                m.account_id === a.id &&
                m.starts_at <= new Date(mountedAt).toISOString() &&
                (!m.ends_at || Date.parse(m.ends_at) > mountedAt)
            );
            return (
              <section
                className={`card account-card ${a.archived ? 'is-archived' : ''}`}
                key={a.id}
              >
                <div className="account-card-top">
                  <span className={`platform-label ${a.platform}`}>
                    <Icon size={15} />
                    {a.platform === 'youtube'
                      ? 'YouTube'
                      : a.platform === 'tiktok'
                        ? 'TikTok'
                        : a.platform === 'instagram'
                          ? 'Instagram'
                          : 'Facebook'}
                  </span>
                  <div className="button-group">
                    <Badge
                      tone={
                        a.archived
                          ? 'neutral'
                          : a.status === 'connected'
                            ? 'green'
                            : a.status === 'attention'
                              ? 'amber'
                              : 'neutral'
                      }
                    >
                      {a.archived ? 'archived' : a.status}
                    </Badge>
                    {recordMenu('account', a.id, !!a.archived)}
                  </div>
                </div>
                <div className="account-identity">
                  <AccountAvatar
                    key={`${identity?.avatarUrl}:${identity?.refreshedAt}`}
                    name={accountTitle(a)}
                    src={identity?.avatarUrl || undefined}
                    platform={a.platform}
                  />
                  <div>
                    <AsyncButton
                      className="account-name"
                      onClick={() => open('accountDetail', 'Account details', a.id)}
                    >
                      {accountTitle(a)}
                    </AsyncButton>
                    <p>
                      {identity?.username ? `@${identity.username}` : creatorName(a.creator_id)}
                      {identity?.username ? ` · ${creatorName(a.creator_id)}` : ''}
                    </p>
                  </div>
                </div>
                <dl className="account-facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>
                      {a.provider === 'zernio'
                        ? 'Zernio'
                        : a.provider === 'direct'
                          ? 'Official API'
                          : 'Manual / CSV'}
                    </dd>
                  </div>
                  <div>
                    <dt>Last synchronization</dt>
                    <dd>
                      {a.last_synced_at
                        ? formatTimestamp(a.last_synced_at)
                        : 'Not synchronized yet'}
                    </dd>
                  </div>
                </dl>
                <div className="account-routing">
                  <GitBranch size={14} />
                  <span>
                    {routes
                      .map((m) =>
                        campaignName(
                          data.memberships.find((x) => x.id === m.membership_id)?.campaign_id ||
                            null
                        )
                      )
                      .join(', ') || 'No active campaign mapping'}
                  </span>
                </div>
                {a.error && <p className="form-error account-alert">{a.error}</p>}
                {a.integration?.payoutsBlocked && (
                  <p className="account-alert subtle">
                    {a.integration.policyReason || 'Compensation policy approval required.'}
                  </p>
                )}
                {queued[a.id] && (
                  <p className="sync-status" role="status">
                    Sync queued · Waiting for the background worker. This page checks for
                    completion.
                  </p>
                )}
                {!a.archived && (
                  <div className="account-actions">
                    {a.provider !== 'manual' &&
                      (a.status === 'connected' ? (
                        <>
                          <AsyncButton
                            className="button soft"
                            disabled={!!queued[a.id]}
                            onClick={() => sync(a.id)}
                          >
                            <RefreshCw size={14} />
                            {queued[a.id] ? 'Queued' : 'Sync'}
                          </AsyncButton>
                          <AsyncButton className="text-button" onClick={() => prepareDisconnect(a)}>
                            Disconnect
                          </AsyncButton>
                        </>
                      ) : (
                        <AsyncButton
                          className="button primary"
                          onClick={() => connection(a.id, 'connect')}
                        >
                          <Link2 size={14} />
                          Connect
                        </AsyncButton>
                      ))}
                    <AsyncButton
                      className="text-button"
                      onClick={() => open('accountDetail', 'Account details', a.id)}
                    >
                      Details
                      <ArrowUpRight size={14} />
                    </AsyncButton>
                  </div>
                )}
              </section>
            );
          })}
        </div>
        {!accounts.length && (
          <Empty
            title="No accounts to show"
            description="Register an account, or include archived records using the toolbar."
            action={addButton('account', 'Register social account', 'Add account')}
          />
        )}
        <details className="connection-help">
          <summary>Account requirements and data handling</summary>
          <p>
            TikTok and Instagram can use Zernio’s two-account free allowance. Instagram needs a
            Professional Creator or Business account. Existing Meta and YouTube integrations stay
            available. Connection permission does not grant dashboard access. Disconnecting direct
            providers erases API source data and may affect shared grants; review the confirmation
            first.
          </p>
        </details>
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
          <details className="history-panel">
            <summary>Rule version history</summary>
            <p className="history-note">
              Every version is retained. Published posts keep their original rules.
            </p>
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
                        <td className="capitalize">
                          {ruleScopeLabels[r.scope] || 'Compensation override'}
                        </td>
                        <td>
                          {r.creator_id
                            ? creatorName(r.creator_id)
                            : r.campaign_id
                              ? campaignName(r.campaign_id)
                              : 'All creators'}
                        </td>
                        <td>{formatTimestamp(r.effective_at)}</td>
                        <td className="rule-change-summary">{ruleDescription(r.patch)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
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
            <AsyncButton
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
            </AsyncButton>
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
          <AsyncButton className="button" onClick={() => refresh()}>
            <RefreshCw size={16} />
            Refresh
          </AsyncButton>
        </div>
        <OperationsHealth preview={preview} />
        <section className="card">
          <div className="section-heading">
            <h2>Posts to review</h2>
            <Badge tone="amber">{held.length}</Badge>
          </div>
          <div className="review-list">
            {held.map((p) => (
              <article className="review-item" key={p.id}>
                <div>
                  <h3>{p.caption || 'Untitled post'}</h3>
                  <p>{reviewFor(p).reason}</p>
                  <small>{reviewFor(p).action}</small>
                </div>
                <AsyncButton className="button" onClick={() => open('post', 'Post details', p.id)}>
                  Review post <ArrowUpRight size={15} />
                </AsyncButton>
              </article>
            ))}
            {!held.length && (
              <p className="subtle">
                No unresolved operational reviews. Automatic tracking and retries continue.
              </p>
            )}
          </div>
        </section>
        {historical.length > 0 && (
          <section className="card">
            <details className="history-panel">
              <summary>
                Historical posts · {historical.length} · separate from operational reviews
              </summary>
              <p className="history-note">
                These publications were first discovered after their tracking window. They are not
                automatically payable and still hold the related payout draft until reviewed or
                explicitly excluded. This does not identify them as test content automatically.
              </p>
              <div className="historical-toolbar">
                {excludableHistorical.length > 0 && (
                  <AsyncButton
                    className="button"
                    onClick={() => open('excludeHistorical', 'Exclude historical posts?')}
                  >
                    Exclude historical posts ({Math.min(100, excludableHistorical.length)})
                  </AsyncButton>
                )}
              </div>
              <div className="review-list">
                {historical.map((p) => (
                  <article className="review-item" key={p.id}>
                    <div>
                      <h3>{p.caption || 'Untitled post'}</h3>
                      <p>{reviewFor(p).reason}</p>
                      <small>
                        {isLocked(data, p)
                          ? 'This month is finalized. Use a linked correction; exclusion is blocked.'
                          : reviewFor(p).action}
                      </small>
                    </div>
                    <AsyncButton
                      className="button"
                      onClick={() => open('post', 'Post details', p.id)}
                    >
                      View post
                    </AsyncButton>
                  </article>
                ))}
              </div>
            </details>
          </section>
        )}
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
              <AsyncButton
                className="button"
                onClick={() => {
                  setView('Social accounts');
                }}
              >
                Manage
              </AsyncButton>
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
          <details className="history-panel">
            <summary>Workspace history</summary>
            {data.audit.slice(0, 15).map((a) => (
              <div className="activity-row" key={a.id}>
                <span className="activity-dot" />
                <div>
                  <strong>{auditDescription(a, data)}</strong>
                  {['reviewPost', 'approveBonus', 'excludeHistoricalPosts'].includes(a.action) && (
                    <p>{a.detail}</p>
                  )}
                </div>
                <small>{date(a.created_at)}</small>
              </div>
            ))}
          </details>
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
    const chartObservations = observations.filter(
      (s) =>
        s.metric === 'public_views' && s.provenance?.kind !== 'daily' && !s.provenance?.supporting
    );
    const max = Math.max(1, ...chartObservations.map((s) => s.views));
    const tracking = trackingState(data, p, new Date(mountedAt).toISOString());
    const review = reviewFor(p);
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
            <b>{publicCount(p)}</b>
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
          <div>
            <strong>{review.label}</strong>
            <p>{review.reason}</p>
            <p>{review.action}</p>
          </div>
        </div>
        {review.stage === 'historical' && !locked && (
          <AsyncButton
            className="button"
            onClick={() => open('excludeHistorical', 'Exclude historical post?', p.id)}
          >
            Exclude historical post
          </AsyncButton>
        )}
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
        </dl>
        {chartObservations.length > 1 && (
          <svg
            className="snapshot-chart"
            viewBox="0 0 420 130"
            role="img"
            aria-label="Observed cumulative public views over time"
          >
            <path
              d={`M ${chartObservations.map((s, i) => `${(i / (chartObservations.length - 1)) * 400 + 10},${120 - (s.views / max) * 100}`).join(' L ')}`}
              fill="none"
              stroke="#91b4e4"
              strokeWidth="3"
            />
            <line x1="10" y1="121" x2="410" y2="121" stroke="#323643" />
          </svg>
        )}
        <div className="button-group">
          <AsyncButton
            className="button"
            onClick={() => open('snapshot', 'Add metric observation', p.id)}
          >
            Add observation
          </AsyncButton>
          {!locked && (
            <>
              <AsyncButton
                className="button"
                onClick={() => open('attribute', 'Assign post to campaign', p.id)}
              >
                Assign campaign
              </AsyncButton>
              <AsyncButton
                className="button primary"
                onClick={() => open('review', 'Review eligible views', p.id)}
              >
                Review eligibility
              </AsyncButton>
            </>
          )}
        </div>
        <details className="advanced-details">
          <summary>Advanced details · metric history</summary>
          <p className="subtle">
            Post reference: <span className="mono">{p.id}</span>
          </p>
          <div className="info-box">
            <p>
              Collection: <b>{tracking.status}</b>. Provisional in-window public views:{' '}
              <b>{number(tracking.provisionalViews)}</b>. These are not verified organic or
              automatically payable.
              <br />
              Ad detection:{' '}
              {tracking.isAd === true
                ? 'suspected paid promotion'
                : tracking.isAd === false
                  ? 'not flagged (not organic proof)'
                  : 'unknown (not organic proof)'}
              .<br />
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
        </details>
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
              <AsyncButton
                className="button"
                onClick={() => open('bonus', 'Approve performance bonus', s.id)}
              >
                Approve / reject bonus
              </AsyncButton>
              <AsyncButton
                className="button primary"
                onClick={() => open('finalize', 'Finalize payout statement', s.id)}
              >
                Finalize statement
              </AsyncButton>
            </>
          ) : s.status === 'finalized' ? (
            <AsyncButton
              className="button primary"
              onClick={() => open('paid', 'Record external payment', s.id)}
            >
              Mark as paid
            </AsyncButton>
          ) : null}
          {s.status !== 'draft' && !s.source_redacted_at && (
            <AsyncButton
              className="button"
              onClick={() => open('adjustment', 'Record linked adjustment', s.id)}
            >
              Add correction
            </AsyncButton>
          )}
          <AsyncButton
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
          </AsyncButton>
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
                    <AsyncButton
                      className="button"
                      onClick={() =>
                        action({ type: 'approveAdjustment', adjustmentId: a.id, approve: true })
                      }
                    >
                      Approve correction
                    </AsyncButton>
                    <AsyncButton
                      className="text-button"
                      onClick={() =>
                        action({ type: 'approveAdjustment', adjustmentId: a.id, approve: false })
                      }
                    >
                      Reject
                    </AsyncButton>
                  </>
                )}
                {a.status === 'approved' && (
                  <AsyncButton
                    className="button"
                    onClick={() => open('payAdjustment', 'Record correction settlement', a.id)}
                  >
                    Record external settlement
                  </AsyncButton>
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
    if (panel.kind.startsWith('recordOptions-')) {
      const entity = panel.kind.split('-')[1];
      const archived = data.creators.find((c) => c.id === id)?.archived;
      return (
        <div className="detail-body">
          <AsyncButton
            className="button"
            onClick={() =>
              open(
                `manage-${archived ? 'restore' : 'archive'}-${entity}`,
                archived ? 'Restore creator' : 'Archive creator',
                id
              )
            }
          >
            <Archive size={16} />
            {archived ? 'Restore' : 'Archive'}
          </AsyncButton>
          <AsyncButton
            className="button danger"
            onClick={() => open(`manage-remove-${entity}`, 'Remove unused creator', id)}
          >
            <Trash2 size={16} />
            Remove unused creator
          </AsyncButton>
        </div>
      );
    }
    if (panel.kind.startsWith('manage-')) {
      const [, operation, entity] = panel.kind.split('-');
      return (
        <div className="detail-body">
          <p>
            {operation === 'remove'
              ? 'Permanent removal is allowed only without posts or financial history. Related unused configuration may be removed. Connected accounts must be disconnected first. The server will refuse unsafe deletion.'
              : operation === 'archive'
                ? 'History and financial records stay intact. Current campaign routing ends now. Associated accounts must be disconnected first for creator/account archival. Future-dated assignments must be resolved first. Restoring does not reopen ended routing or reconnect accounts.'
                : 'This makes the record available again. Review campaign assignments and reconnect accounts separately.'}
          </p>
          <ConfirmationActions
            onCancel={() => setPanel(null)}
            destructive={operation === 'remove'}
            label={
              operation === 'remove' ? 'Remove' : operation === 'archive' ? 'Archive' : 'Restore'
            }
            onConfirm={() => manage(entity, id!, operation)}
          />
          {/* Existing server guards remain the authority for safe management. */}
        </div>
      );
    }
    if (panel.kind === 'accountDetail') {
      const account = data.accounts.find((a) => a.id === id);
      if (!account) return null;
      return (
        <div className="detail-body">
          <h2>{accountTitle(account)}</h2>
          {account.provider === 'zernio' &&
            ['tiktok', 'instagram'].includes(account.platform) &&
            account.status === 'connected' &&
            !account.archived &&
            !account.integration?.sourceErasedAt &&
            data.posts.some(
              (p) =>
                p.account_id === account.id &&
                !p.deleted &&
                !p.source_erased_at &&
                !usableThumbnail(p.tracking?.thumbnail, mountedAt)
            ) && (
              <div className="preview-refresh-control">
                <AsyncButton className="button" onClick={() => loadPreviews(account.id)}>
                  <RefreshCw size={15} />
                  Load missing previews
                </AsyncButton>
                <small>
                  {thumbnailPreviewOnly
                    ? 'Loads previews for this open page, including workspace refreshes. Your remote Supabase project is not changed; reloading the page clears these local previews.'
                    : 'Fetches and saves only missing preview metadata. View snapshots, attribution and compensation stay unchanged.'}
                </small>
              </div>
            )}
          <dl className="detail-facts">
            <dt>Creator</dt>
            <dd>{creatorName(account.creator_id)}</dd>
            <dt>Last synchronization</dt>
            <dd>
              {account.last_synced_at
                ? formatTimestamp(account.last_synced_at)
                : 'Not yet synchronized'}
            </dd>
          </dl>
          {account.platform === 'youtube' && !account.integration?.channelIdentity && (
            <p className="subtle">
              Use Refresh profile details below; no new OAuth connection is required.
            </p>
          )}
          {['youtube', 'tiktok', 'instagram'].includes(account.platform) &&
            (account.platform === 'youtube' || account.status === 'connected') &&
            !account.archived &&
            !account.integration?.sourceErasedAt && (
              <>
                <AsyncButton className="button" onClick={() => refreshProfileDetails(account.id)}>
                  <RefreshCw size={15} />
                  Refresh profile details
                </AsyncButton>
                {(account.integration?.profileMetadataStatus ||
                  account.integration?.channelIdentityLookup) && (
                  <p className="subtle">
                    Last profile attempt:{' '}
                    {formatTimestamp(
                      (account.integration.profileMetadataStatus ||
                        account.integration.channelIdentityLookup)!.checkedAt
                    )}{' '}
                    ·{' '}
                    {(account.integration.profileMetadataStatus ||
                      account.integration.channelIdentityLookup)!.status.replaceAll('_', ' ')}
                  </p>
                )}
              </>
            )}
          {account.provider === 'direct' && !account.archived && (
            <AsyncButton className="button" onClick={() => connection(account.id, 'deletion-link')}>
              Create private deletion link
            </AsyncButton>
          )}
          <details className="advanced-details">
            <summary>Advanced details</summary>
            <dl className="detail-facts">
              <dt>Registered identity</dt>
              <dd className="technical-id">{account.username}</dd>
              <dt>Platform account ID</dt>
              <dd className="technical-id">{account.provider_account_id || 'Not connected'}</dd>
            </dl>
            <h3>Recent synchronization</h3>
            {data.syncRuns
              .filter((r) => r.account_id === id)
              .slice(0, 3)
              .map((r) => (
                <p key={r.id}>
                  <Badge tone={r.status === 'failed' ? 'red' : 'neutral'}>{r.status}</Badge>{' '}
                  {r.message}
                </p>
              ))}
          </details>
          {recordMenu('account', account.id, !!account.archived)}
        </div>
      );
    }
    switch (panel.kind) {
      case 'excludeHistorical': {
        const selection = (id ? data.posts.filter((p) => p.id === id) : excludableHistorical)
          .filter((p) => reviewFor(p).stage === 'historical' && !isLocked(data, p))
          .slice(0, 100);
        return (
          <div className="detail-body">
            <p>
              Exclude {selection.length} historical {selection.length === 1 ? 'post' : 'posts'} from
              this compensation program? Posts, view observations and campaign mappings are
              retained. Existing rules will recalculate draft totals. Finalized financial records
              remain protected.
            </p>
            <p className="subtle">
              This is an explicit administrative decision. No organic-view evidence is needed to
              exclude content. You can review a post later if reliable evidence becomes available
              and its month remains editable.
            </p>
            <ConfirmationActions
              onCancel={() => setPanel(null)}
              label="Exclude from compensation"
              destructive
              disabled={!selection.length}
              onConfirm={() =>
                execute({
                  type: 'excludeHistoricalPosts',
                  postIds: selection.map((p) => p.id),
                  note: 'Historical content discovered after its eligibility window; excluded from this compensation program by administrator.',
                })
              }
            />
          </div>
        );
      }
      case 'finalize':
        return (
          s && (
            <div className="detail-body">
              <p>
                Finalization locks its calculation inputs and approved amount. Later changes require
                a linked correction. This does not send money.
              </p>
              <ConfirmationActions
                onCancel={() => setPanel(null)}
                label="Finalize"
                onConfirm={() => action({ type: 'finalizeStatement', statementId: s.id })}
              />
            </div>
          )
        );
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
        return form([{ ...nameField('App name'), value: a.name }], (v) => ({
          type: 'updateEntity',
          entity: 'app',
          id: a.id,
          name: v.name,
        }));
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
                (c.status === 'archived' ? ['archived'] : ['active', 'paused']).map((v) =>
                  option(v, v)
                )
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
                <AsyncButton
                  className="text-button"
                  onClick={() => open('assignment', 'Assign creator to campaign', id)}
                >
                  <Plus size={15} />
                  Add assignment
                </AsyncButton>
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
              option('zernio', 'Zernio (TikTok / Instagram pilot)'),
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
            {
              ...selectField(
                'appId',
                'App',
                data.apps.map((a) => option(a.id, `${a.name}${a.archived ? ' (archived)' : ''}`))
              ),
              value: selectedApp,
            },
            selectField(
              'creatorId',
              'Creator',
              data.creators.map((c) => option(c.id, `${c.name}${c.archived ? ' (archived)' : ''}`))
            ),
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
      case 'deletionLink':
      case 'authorization':
        return (
          <div className="detail-body">
            <div className="info-box">
              <Link2 size={18} />
              <p>
                {panel.kind === 'deletionLink'
                  ? 'This private link lets the creator request connection and API source-data deletion. It expires after 90 days. Sharing it permits a destructive operation; send it only to the account owner.'
                  : `Send this expiring authorization link to the creator. They connect their registered account through ${data.accounts.find((a) => a.id === id)?.provider === 'zernio' ? 'Zernio' : 'the official platform'} without receiving dashboard access. The invitation expires after 30 minutes.`}
              </p>
            </div>
            <label className="field">
              {panel.kind === 'deletionLink'
                ? 'Private deletion link'
                : 'Creator authorization link'}
              <Input readOnly value={connectionUrl} onFocus={(e) => e.target.select()} />
            </label>
            <div className="button-group">
              <AsyncButton
                className="button primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(connectionUrl);
                    setToast(
                      panel.kind === 'deletionLink'
                        ? 'Private deletion link copied'
                        : 'Creator connection link copied'
                    );
                  } catch {
                    setToast('Select and copy the link above.');
                  }
                }}
              >
                Copy link
              </AsyncButton>
              <a className="button" target="_blank" rel="noreferrer" href={connectionUrl}>
                {panel.kind === 'deletionLink' ? 'Open deletion request' : 'Open authorization'}
                <ExternalLink size={14} />
              </a>
            </div>
            <p className="subtle">
              After authorization, refresh Social accounts to see the connection. Treat this link as
              private.
            </p>
          </div>
        );
      case 'disconnect': {
        const account = data.accounts.find((a) => a.id === id)!;
        return (
          <div className="detail-body">
            <p>
              {account.provider === 'direct'
                ? 'Stops synchronization, erases API-derived source data and queues provider revocation. Finalized monetary records are retained with source data redacted. This source-data deletion cannot be undone by reconnecting.'
                : 'Stops synchronization and disconnects the Zernio account. Local history remains. Zernio has a one-hour restoration grace period; verify its workspace usage before assuming the free slot is available.'}
            </p>
            {disconnectImpact.length > 0 && (
              <div className="form-error">
                <b>The following accounts share this grant and will also be disconnected:</b>
                <ul>
                  {disconnectImpact.map((a) => (
                    <li key={a.id}>
                      {a.platform} · @{a.username}
                    </li>
                  ))}
                </ul>
                <label>
                  <Input
                    type="checkbox"
                    checked={sharedConfirmed}
                    onChange={(e) => setSharedConfirmed(e.target.checked)}
                  />{' '}
                  I confirm disconnection and source deletion for these accounts too.
                </label>
              </div>
            )}
            {account.platform === 'youtube' && (
              <p className="subtle">
                Google revocation can invalidate other tokens under the same Google application
                grant.
              </p>
            )}
            <ConfirmationActions
              onCancel={() => setPanel(null)}
              destructive
              disabled={disconnectImpact.length > 0 && !sharedConfirmed}
              label={
                account.provider === 'direct' ? 'Disconnect and delete source data' : 'Disconnect'
              }
              onConfirm={() => connection(id!, 'disconnect')}
            />
          </div>
        );
      }
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
          H2A <span>Creator Hub</span>
        </Link>
        <div className="workspace-label">PRIVATE WORKSPACE</div>
        <label className="app-switcher">
          <Layers size={17} />
          <Select
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
          </Select>
        </label>
        <div className="nav-label">MANAGE</div>
        <nav>
          {nav.map(([label, Icon]) => (
            <AsyncButton
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
            </AsyncButton>
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
              <AsyncButton
                className="icon-button"
                aria-label="Sign out"
                onClick={async () => {
                  await requestJson('/api/auth', { method: 'DELETE' });
                  router.push('/');
                  router.refresh();
                }}
              >
                <LogOut size={16} />
              </AsyncButton>
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <AsyncButton
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={21} />
          </AsyncButton>
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong>{view}</strong>
          </div>
          <div className="topbar-actions">
            <label className="archive-toggle">
              <Input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            <label className="search-box">
              <Search size={16} />
              <Input
                aria-label="Search workspace"
                placeholder="Search names, accounts, or posts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>⌕</kbd>
            </label>
            <Tooltip label="Refresh workspace">
              <AsyncButton
                className="icon-button"
                aria-label="Refresh data"
                busy={refreshing}
                onClick={() => refresh()}
              >
                <RefreshCw size={17} />
              </AsyncButton>
            </Tooltip>
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
        <main className="main-content" key={view}>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <AsyncButton onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </AsyncButton>
            </div>
          )}
          {toast && (
            <div className="toast-message" role="status">
              <Check size={16} />
              {toast}
              <AsyncButton onClick={() => setToast('')} aria-label="Dismiss notification">
                ×
              </AsyncButton>
            </div>
          )}
          {view === 'Overview' ? (
            overview()
          ) : view === 'Analytics' ? (
            <Analytics key={appId} data={data} appId={appId} />
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
                  <AsyncButton
                    className="button"
                    onClick={() => open('import', 'Import posts or observations')}
                  >
                    <Download size={15} />
                    Import CSV
                  </AsyncButton>
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
                  <div className="posts-toolbar">
                    <div className="view-toggle" role="group" aria-label="Post display">
                      <AsyncButton
                        type="button"
                        aria-pressed={postView === 'grid'}
                        onClick={() => setPostView('grid')}
                      >
                        <Grid2X2 size={16} />
                        Grid
                      </AsyncButton>
                      <AsyncButton
                        type="button"
                        aria-pressed={postView === 'table'}
                        onClick={() => setPostView('table')}
                      >
                        <Table2 size={16} />
                        Table
                      </AsyncButton>
                    </div>
                    <Select
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
                    </Select>
                  </div>
                </div>
                {postView === 'grid' ? (
                  <PostGrid
                    data={data}
                    posts={posts}
                    now={mountedAt}
                    onOpen={(post) => open('post', 'Post details', post.id)}
                  />
                ) : (
                  postTable(posts)
                )}
              </section>
            </>
          )}
        </main>
        <footer className="dashboard-footer">
          <span>H2A Creator Hub</span>
          <span>Private workspace · Accounting and display timezone: America/New_York · USD</span>
        </footer>
      </div>
      {panel && (
        <Drawer
          compact={
            panel.kind.startsWith('manage-') ||
            ['finalize', 'disconnect', 'recordOptions-creator', 'excludeHistorical'].includes(
              panel.kind
            )
          }
          title={
            panel.kind.startsWith('manage-')
              ? `${panel.kind.split('-')[1][0].toUpperCase()}${panel.kind.split('-')[1].slice(1)} ${panel.kind.split('-')[2] === 'account' ? 'social account' : panel.kind.split('-')[2]}?`
              : panel.kind === 'disconnect'
                ? `Disconnect ${accountTitle(data.accounts.find((a) => a.id === panel.id)!)}?`
                : panel.kind === 'finalize'
                  ? 'Finalize statement?'
                  : panel.title
          }
          description={
            panel.kind.startsWith('manage-') ||
            ['disconnect', 'finalize', 'excludeHistorical'].includes(panel.kind)
              ? 'Review the consequences before confirming.'
              : undefined
          }
          onClose={() => {
            if (!mutation.current) setPanel(null);
          }}
        >
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
  const [reading, setReading] = useState(false);
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
        <Select
          value={kind}
          disabled={reading || busy}
          onChange={(e) => {
            setKind(e.target.value);
            setRows([]);
            setError('');
          }}
        >
          <option value="posts">Posts</option>
          <option value="snapshots">Metric observations</option>
        </Select>
      </label>
      <AsyncButton
        className="text-button"
        onClick={() =>
          download(`ugc-${kind}-template.csv`, [Object.fromEntries(headers.map((h) => [h, '']))])
        }
      >
        <Download size={15} />
        Download template
      </AsyncButton>
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
        <Input
          type="file"
          accept=".csv,text/csv"
          disabled={reading || busy}
          onChange={async (e) => {
            setError('');
            setRows([]);
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 2000000) {
              setError('Maximum file size is 2 MB.');
              return;
            }
            setReading(true);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const text = await Promise.race([
                file.text(),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error('Reading the CSV timed out. Select the file again.')),
                    20000
                  );
                }),
              ]);
              const result = Papa.parse<Record<string, string>>(text, {
                header: true,
                skipEmptyLines: 'greedy',
              });
              if (result.errors.length) throw new Error(result.errors[0].message);
              if (
                headers
                  .filter((h) => !['caption', 'campaign_id', 'evidence'].includes(h))
                  .some((h) => !result.meta.fields?.includes(h))
              )
                throw new Error('Required CSV columns are missing. Use the template.');
              setRows(result.data);
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Could not read the CSV.');
            } finally {
              clearTimeout(timeout);
              setReading(false);
            }
          }}
        />
      </label>
      {reading && (
        <p role="status" className="sync-status">
          Reading and validating CSV…
        </p>
      )}
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
          <AsyncButton
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
            Validate and import
          </AsyncButton>
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
