import 'server-only';
import { instantSchema } from '@/domain/time';
import { z } from 'zod';
import { configuration } from '@/lib/server/config';
import type {
  DiscoveredPost,
  MetricObservation,
  MetricTarget,
  ThumbnailObservation,
  TrackingProvider,
} from './provider';
const accountSchema = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  platform: z.string(),
  username: z.string().default(''),
  displayName: z.string().nullish(),
  profilePicture: z.string().nullish(),
  isActive: z.boolean().optional(),
  profileId: z
    .union([z.string(), z.object({ _id: z.string().optional(), id: z.string().optional() })])
    .optional(),
});
export const zernioInstagramEnabled = () => process.env.ZERNIO_INSTAGRAM_ENABLED === 'true';
export type ZernioPlatform = 'tiktok' | 'instagram';
export type RemoteAccount = z.infer<typeof accountSchema>;
export function remoteId(a: RemoteAccount) {
  const id = a._id || a.id;
  if (!id) throw new Error('Provider returned an account without an ID.');
  return id;
}
const analytics = z
  .object({ views: z.number().int().nonnegative().nullish(), lastUpdated: instantSchema.nullish() })
  .passthrough();
const platformEntry = z.object({
  platform: z.string(),
  accountId: z.string().nullish(),
  platformPostId: z.string().nullish(),
  platformPostUrl: z.string().nullish(),
  analytics: analytics.nullish(),
});
const postImages = {
  thumbnailUrl: z.string().nullish().catch(undefined),
  mediaItems: z
    .array(z.object({ type: z.string().optional(), thumbnail: z.string().nullish() }))
    .nullish()
    .catch(undefined),
};
const listPost = z.object({
  ...postImages,
  platform: z.string().nullish(),
  platformPostId: z.string().nullish(),
  platformPostUrl: z.string().nullish(),
  publishedAt: instantSchema.nullish(),
  content: z.string().nullish(),
  analytics: analytics.nullish(),
  platforms: z.array(platformEntry).optional(),
  mediaType: z.string().nullish(),
  mediaProductType: z.string().nullish(),
  isAd: z.boolean().nullish(),
});
const listSchema = z.object({
  posts: z.array(listPost),
  pagination: z
    .object({ page: z.number().int(), pages: z.number().int(), total: z.number().int().optional() })
    .optional(),
});
const discoverySchema = z.object({
  ...postImages,
  platformPostId: z.string(),
  platformPostUrl: z.string().optional(),
  publishedAt: instantSchema,
  content: z.string().optional(),
  mediaType: z.string().nullish(),
  mediaProductType: z.string().nullish(),
  isAd: z.boolean().nullish(),
});
type Counter = {
  thumbnailUrl?: string | null;
  platformPostId: string;
  url: string;
  caption: string;
  publishedAt: string | null;
  views: number | null;
  updatedAt: string | null;
  isAd: boolean | null;
};
/** Zernio holds creator OAuth tokens; this adapter only sees our server API key. */
export class ZernioProvider implements TrackingProvider {
  readonly name = 'zernio';
  private baseline = new Map<string, Counter[]>();
  private budgetEnds: number;
  constructor(
    budgetEnds = Date.now() + 45000,
    readonly platform: ZernioPlatform = 'tiktok'
  ) {
    this.budgetEnds = Math.min(budgetEnds, Date.now() + 45000);
  }
  capabilities() {
    return {
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: [this.platform],
    };
  }
  private assertEnabled() {
    if (this.platform === 'instagram' && !zernioInstagramEnabled())
      throw new Error('Instagram/Zernio is disabled. Enable ZERNIO_INSTAGRAM_ENABLED for testing.');
  }
  private isVideo(p: {
    mediaType?: string | null;
    mediaProductType?: string | null;
    platformPostUrl?: string | null;
  }) {
    if (this.platform === 'tiktok') return p.mediaType !== 'image' && p.mediaType !== 'carousel';
    // A generic VIDEO may be a Story or feed video. Require positive Reel evidence.
    if (p.mediaType === 'image' || p.mediaType === 'carousel') return false;
    if (p.mediaProductType) return p.mediaProductType.toUpperCase() === 'REELS';
    try {
      const url = new URL(p.platformPostUrl || '');
      return (
        ['instagram.com', 'www.instagram.com'].includes(url.hostname) &&
        /^\/reels?\/[^/]+/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }
  async request(path: string, init: RequestInit = {}, deadline = this.budgetEnds) {
    const key = configuration().zernioKey;
    if (!key) throw new Error('ZERNIO_API_KEY is not configured.');
    const left = Math.min(this.budgetEnds, deadline) - Date.now();
    if (left < 1000)
      throw new Error(
        'Provider sync exceeded its time budget; retry or narrow the account history.'
      );
    const response = await fetch(`https://zernio.com/api/v1${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.min(12000, left)),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (response.status === 404 && init.method === 'DELETE') return {};
    if (!response.ok) {
      if ([401, 403, 409].includes(response.status))
        throw new Error(
          'Zernio authorization needs attention. Check the API key and reconnect the account.'
        );
      if (response.status === 402)
        throw new Error(
          'Zernio returned a billing gate. No paid action was attempted. Check your free allowance.'
        );
      if (response.status === 429)
        throw new Error(
          `Zernio rate limit. Retry after ${response.headers.get('retry-after') || '60'} seconds.`
        );
      throw new Error(`Zernio request failed (${response.status}). Try again later.`);
    }
    if (response.status === 202)
      throw new Error('Zernio analytics are still syncing. The worker will retry.');
    if (response.status === 204) return {};
    const body = await response.json();
    return body.data ?? body;
  }
  async listAccounts(): Promise<RemoteAccount[]> {
    const body = await this.request('/accounts');
    return z.array(accountSchema).parse(body.accounts ?? body);
  }
  async createProfile(name: string): Promise<string> {
    const body = await this.request('/profiles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const id = body.profile?._id ?? body.profile?.id ?? body._id ?? body.id;
    if (typeof id !== 'string') throw new Error('Zernio did not return a profile ID.');
    return id;
  }
  async connectUrl(
    profileId: string,
    redirectUrl: string,
    username: string,
    reconnectId?: string
  ): Promise<string> {
    this.assertEnabled();
    const body = await this.request(
      `/connect/${this.platform}?${new URLSearchParams({ profileId, redirect_url: redirectUrl, scopes: 'analytics', expectedUsername: username, ...(this.platform === 'instagram' ? { loginMethod: 'instagram_login' } : {}), ...(reconnectId ? { reconnectAccountId: reconnectId } : {}) })}`
    );
    const url = z.url().parse(body.authUrl);
    if (new URL(url).protocol !== 'https:')
      throw new Error('Provider returned an insecure authorization URL.');
    return url;
  }
  async disconnect(accountId: string) {
    await this.request(`/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  }
  private async counters(accountId: string, since?: string) {
    const cached = this.baseline.get(accountId + ':' + (since ?? ''));
    if (cached) return cached;
    const result: Counter[] = [];
    const fromDate = since ?? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    for (let page = 1; page <= 40; page++) {
      if (page > 1) await new Promise((resolve) => setTimeout(resolve, 210));
      const body = listSchema.parse(
        await this.request(
          `/analytics?${new URLSearchParams({ accountId, platform: this.platform, source: 'all', limit: '100', page: String(page), fromDate })}`
        )
      );
      for (const p of body.posts) {
        // The documented list schema has native IDs in platforms[], not in Zernio's _id.
        const entries = p.platforms?.length
          ? p.platforms
          : p.platform
            ? [
                {
                  platform: p.platform,
                  platformPostId: p.platformPostId,
                  platformPostUrl: p.platformPostUrl,
                  analytics: p.analytics,
                },
              ]
            : [];
        for (const e of entries) {
          if (
            e.platform !== this.platform ||
            ('accountId' in e && e.accountId && e.accountId !== accountId)
          )
            continue;
          const url = e.platformPostUrl || p.platformPostUrl || '';
          if (!this.isVideo({ ...p, platformPostUrl: url })) continue;
          const id =
            e.platformPostId ||
            (this.platform === 'tiktok' ? url.match(/\/video\/(\d+)/)?.[1] : undefined);
          if (!id)
            throw new Error(
              'A platform analytics row has no native video ID. Provider mapping needs review.'
            );
          const metrics = e.analytics ?? p.analytics;
          result.push({
            platformPostId: id,
            url,
            caption: p.content || '',
            thumbnailUrl: p.thumbnailUrl || p.mediaItems?.find((m) => m.thumbnail)?.thumbnail,
            publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
            views: metrics?.views ?? null,
            isAd: p.isAd ?? null,
            updatedAt: metrics?.lastUpdated ? new Date(metrics.lastUpdated).toISOString() : null,
          });
        }
      }
      if (body.pagination ? page >= body.pagination.pages : body.posts.length < 100) break;
      if (page === 40)
        throw new Error(
          'Provider history exceeded the 4,000-post safety budget. Narrow the history before retrying.'
        );
    }
    this.baseline.set(accountId + ':' + (since ?? ''), result);
    return result;
  }
  async discoverPosts(accountId: string, fromDate?: string): Promise<DiscoveredPost[]> {
    this.assertEnabled();
    const body = await this.request('/posts/sync-external', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    });
    const recent = z
      .array(discoverySchema)
      .parse(body.posts ?? (body.post ? [body.post] : []))
      .filter((p) => this.isVideo(p))
      .map((p) => ({
        platformPostId: p.platformPostId,
        url: p.platformPostUrl || '',
        caption: p.content || '',
        thumbnailUrl: p.thumbnailUrl || p.mediaItems?.find((m) => m.thumbnail)?.thumbnail,
        publishedAt: new Date(p.publishedAt).toISOString(),
        isAd: p.isAd ?? null,
        ...(this.platform === 'instagram' ? { contentType: 'reel' as const } : {}),
      }));
    // A paginated baseline catches videos missed by the "recent posts" discovery endpoint during outages.
    const history = (await this.counters(accountId, fromDate))
      .filter((p) => p.publishedAt && p.url)
      .map((p) => ({
        platformPostId: p.platformPostId,
        url: p.url,
        caption: p.caption,
        thumbnailUrl: p.thumbnailUrl,
        publishedAt: p.publishedAt!,
        isAd: p.isAd,
        ...(this.platform === 'instagram' ? { contentType: 'reel' as const } : {}),
      }));
    const merged = new Map(history.map((p) => [p.platformPostId, p]));
    for (const post of recent)
      merged.set(post.platformPostId, {
        ...post,
        thumbnailUrl: post.thumbnailUrl || merged.get(post.platformPostId)?.thumbnailUrl,
        isAd: merged.get(post.platformPostId)?.isAd ?? post.isAd,
      });
    return [...merged.values()];
  }
  /** Read-only, bounded media lookup. Never discover/import extra posts or return payable counters. */
  async fetchThumbnails(
    accountId: string,
    targets: MetricTarget[]
  ): Promise<ThumbnailObservation[] | null> {
    this.assertEnabled();
    if (!targets.length) return [];
    if (this.budgetEnds - Date.now() < 2500) return null;
    const wanted = new Set(targets.map((t) => t.platformPostId));
    const found = new Map<string, ThumbnailObservation>();
    // Reuse already fetched pages before making any historical media request.
    for (const [key, rows] of this.baseline)
      if (key.startsWith(`${accountId}:`))
        for (const row of rows)
          if (wanted.has(row.platformPostId)) found.set(row.platformPostId, row);
    if (found.size === wanted.size) return [...found.values()];
    const dates = targets
      .filter((t) => !found.has(t.platformPostId))
      .map((t) => t.publishedAt.slice(0, 10))
      .sort();
    const floor = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const fromDate = dates[0] < floor ? floor : dates[0];
    const toDate = dates.at(-1)!;
    if (toDate < floor) return targets.map((t) => ({ platformPostId: t.platformPostId }));
    const deadline = Math.min(this.budgetEnds, Date.now() + 6000);
    for (let page = 1; page <= 2; page++) {
      const body = listSchema.parse(
        await this.request(
          `/analytics?${new URLSearchParams({ accountId, platform: this.platform, source: 'all', fromDate, toDate, limit: '100', page: String(page), order: 'asc' })}`,
          {},
          deadline
        )
      );
      for (const post of body.posts) {
        const entries = post.platforms?.length
          ? post.platforms
          : [
              {
                platform: post.platform,
                platformPostId: post.platformPostId,
                accountId,
                platformPostUrl: post.platformPostUrl,
              },
            ];
        for (const entry of entries) {
          if (
            entry.platform !== this.platform ||
            (entry.accountId && entry.accountId !== accountId) ||
            !entry.platformPostId ||
            !wanted.has(entry.platformPostId)
          )
            continue;
          if (
            !this.isVideo({
              ...post,
              platformPostUrl: entry.platformPostUrl || post.platformPostUrl,
            })
          )
            continue;
          const thumbnailUrl =
            post.thumbnailUrl || post.mediaItems?.find((m) => m.thumbnail)?.thumbnail;
          found.set(entry.platformPostId, { platformPostId: entry.platformPostId, thumbnailUrl });
        }
      }
      if (
        found.size === wanted.size ||
        (body.pagination ? page >= body.pagination.pages : body.posts.length < 100)
      )
        break;
      if (deadline - Date.now() < 1500) break;
    }
    // An absent optional preview is retried later, never fabricated from a video ID.
    return targets.map((t) => found.get(t.platformPostId) || { platformPostId: t.platformPostId });
  }
  async fetchMetrics(accountId: string, fromDate?: string): Promise<MetricObservation[]> {
    this.assertEnabled();
    return (await this.counters(accountId, fromDate))
      .filter((p) => p.views !== null)
      .map((p) => ({
        platformPostId: p.platformPostId,
        thumbnailUrl: p.thumbnailUrl,
        views: p.views!,
        metric: 'public_views',
        providerUpdatedAt: p.updatedAt,
        organicVerified: false,
        isAd: p.isAd,
      }));
  }
}
