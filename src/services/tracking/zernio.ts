import 'server-only';
import { instantSchema } from '@/domain/time';
import { z } from 'zod';
import { configuration } from '@/lib/server/config';
import type { DiscoveredPost, MetricObservation, TrackingProvider } from './provider';
const accountSchema = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  platform: z.string(),
  username: z.string().default(''),
  isActive: z.boolean().optional(),
  profileId: z
    .union([z.string(), z.object({ _id: z.string().optional(), id: z.string().optional() })])
    .optional(),
});
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
const listPost = z.object({
  platform: z.string().nullish(),
  platformPostId: z.string().nullish(),
  platformPostUrl: z.string().nullish(),
  publishedAt: instantSchema.nullish(),
  content: z.string().nullish(),
  analytics: analytics.nullish(),
  platforms: z.array(platformEntry).optional(),
  mediaType: z.string().optional(),
});
const listSchema = z.object({
  posts: z.array(listPost),
  pagination: z
    .object({ page: z.number().int(), pages: z.number().int(), total: z.number().int().optional() })
    .optional(),
});
const discoverySchema = z.object({
  platformPostId: z.string(),
  platformPostUrl: z.string().optional(),
  publishedAt: instantSchema,
  content: z.string().optional(),
  mediaType: z.string().optional(),
});
type Counter = {
  platformPostId: string;
  url: string;
  caption: string;
  publishedAt: string | null;
  views: number | null;
  updatedAt: string | null;
};
/** Zernio holds creator OAuth tokens; this adapter only sees our server API key. */
export class ZernioProvider implements TrackingProvider {
  readonly name = 'zernio';
  private baseline = new Map<string, Counter[]>();
  private budgetEnds: number;
  constructor(budgetEnds = Date.now() + 45000) {
    this.budgetEnds = Math.min(budgetEnds, Date.now() + 45000);
  }
  capabilities() {
    return {
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['tiktok'] as ['tiktok'],
    };
  }
  async request(path: string, init: RequestInit = {}) {
    const key = configuration().zernioKey;
    if (!key) throw new Error('ZERNIO_API_KEY is not configured.');
    const left = this.budgetEnds - Date.now();
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
    const body = await this.request(
      `/connect/tiktok?${new URLSearchParams({ profileId, redirect_url: redirectUrl, scopes: 'analytics', expectedUsername: username, ...(reconnectId ? { reconnectAccountId: reconnectId } : {}) })}`
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
          `/analytics?${new URLSearchParams({ accountId, platform: 'tiktok', source: 'all', limit: '100', page: String(page), fromDate })}`
        )
      );
      for (const p of body.posts) {
        if (p.mediaType === 'image' || p.mediaType === 'carousel') continue;
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
            e.platform !== 'tiktok' ||
            ('accountId' in e && e.accountId && e.accountId !== accountId)
          )
            continue;
          const url = e.platformPostUrl || p.platformPostUrl || '';
          const id = e.platformPostId || url.match(/\/video\/(\d+)/)?.[1];
          if (!id)
            throw new Error(
              'A TikTok analytics row has no native video ID. Provider mapping needs review.'
            );
          const metrics = e.analytics ?? p.analytics;
          result.push({
            platformPostId: id,
            url,
            caption: p.content || '',
            publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
            views: metrics?.views ?? null,
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
    const body = await this.request('/posts/sync-external', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    });
    const recent = z
      .array(discoverySchema)
      .parse(body.posts ?? (body.post ? [body.post] : []))
      .filter((p) => p.mediaType !== 'image' && p.mediaType !== 'carousel')
      .map((p) => ({
        platformPostId: p.platformPostId,
        url: p.platformPostUrl || '',
        caption: p.content || '',
        publishedAt: new Date(p.publishedAt).toISOString(),
      }));
    // A paginated baseline catches videos missed by the "recent posts" discovery endpoint during outages.
    const history = (await this.counters(accountId, fromDate))
      .filter((p) => p.publishedAt && p.url)
      .map((p) => ({
        platformPostId: p.platformPostId,
        url: p.url,
        caption: p.caption,
        publishedAt: p.publishedAt!,
      }));
    return [...new Map([...history, ...recent].map((p) => [p.platformPostId, p])).values()];
  }
  async fetchMetrics(accountId: string, fromDate?: string): Promise<MetricObservation[]> {
    return (await this.counters(accountId, fromDate))
      .filter((p) => p.views !== null)
      .map((p) => ({
        platformPostId: p.platformPostId,
        views: p.views!,
        metric: 'public_views',
        providerUpdatedAt: p.updatedAt,
        organicVerified: false,
      }));
  }
}
