import 'server-only';
import { z } from 'zod';
import { instantSchema } from '@/domain/time';
import type { SocialAccount } from '@/domain/model';
import type {
  DiscoveredPost,
  MetricObservation,
  MetricTarget,
  TrackingProvider,
} from '../provider';
import { oauthConfig, instagramAuthMode, metaGraphOrigin } from '@/services/oauth/config';
import { DirectAccess, safeCounter } from './base';
// Graph commonly returns explicit compact UTC offsets (+0000). Normalize only
// that unambiguous suffix; timezone-less/invalid dates still fail instantSchema.
const graphInstant = z
  .string()
  .transform((value) => value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  .pipe(instantSchema);
const media = z.object({
  id: z.string(),
  caption: z.string().optional(),
  description: z.string().optional(),
  timestamp: graphInstant.optional(),
  created_time: graphInstant.optional(),
  permalink: z.url().optional(),
  permalink_url: z.url().optional(),
  media_product_type: z.string().optional(),
});
export class MetaProvider implements TrackingProvider {
  readonly name: string;
  private errors: string[] = [];
  diagnosticErrors() {
    return this.errors;
  }
  private access: DirectAccess;
  private origin: string;
  constructor(
    private account: SocialAccount,
    deadline = Date.now() + 45000
  ) {
    this.name = account.platform === 'instagram' ? 'instagram_official' : 'facebook_official';
    this.access = new DirectAccess(account, deadline);
    this.origin = metaGraphOrigin(account);
  }
  capabilities() {
    return {
      discovery: true,
      publicViews: false,
      organicViews: false,
      platforms: [this.account.platform],
    };
  }
  accountPatch() {
    return this.access.patch;
  }
  async discoverPosts(accountId: string, fromDate?: string): Promise<DiscoveredPost[]> {
    const instagram = this.account.platform === 'instagram',
      posts: DiscoveredPost[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        fields: instagram
          ? 'id,caption,timestamp,permalink,media_product_type'
          : 'id,description,created_time,permalink_url',
        limit: '100',
        ...(after ? { after } : {}),
        ...(!instagram && fromDate ? { since: fromDate } : {}),
      });
      const result = z
        .object({
          data: z.array(media),
          paging: z
            .object({
              next: z.string().optional(),
              cursors: z.object({ after: z.string().optional() }).optional(),
            })
            .optional(),
        })
        .parse(
          await this.access.request(
            `${this.origin}/${encodeURIComponent(accountId)}/${instagram ? 'media' : 'video_reels'}?${query}`
          )
        );
      for (const item of result.data) {
        if (instagram && item.media_product_type !== 'REELS') continue;
        const publishedAt = item.timestamp || item.created_time,
          url = item.permalink || item.permalink_url;
        if (!publishedAt || !url)
          throw new Error(
            'Meta media is missing its original publication timestamp or canonical URL.'
          );
        if (!fromDate || publishedAt >= fromDate)
          posts.push({
            platformPostId: item.id,
            publishedAt,
            url,
            caption: item.caption || item.description || '',
            contentType: 'reel',
          });
      }
      // Instagram does not promise ordering; do not stop at the first older row.
      after = result.paging?.cursors?.after;
      if (!result.paging?.next || !after) break;
      if (page === 9)
        throw new Error('Meta history exceeds this sync budget. Narrow the account backfill.');
    }
    return posts;
  }
  async fetchMetrics(
    _accountId: string,
    _fromDate?: string,
    targets: MetricTarget[] = []
  ): Promise<MetricObservation[]> {
    const instagram = this.account.platform === 'instagram';
    const primary = instagram
      ? 'views'
      : process.env.FACEBOOK_REEL_VIEW_METRIC || 'fb_reels_total_plays';
    const organic = instagram ? '' : process.env.FACEBOOK_REEL_ORGANIC_METRIC || '',
      paid = instagram ? '' : process.env.FACEBOOK_REEL_PAID_METRIC || '';
    const requested = [primary, organic, paid].filter(Boolean);
    if (
      requested.some((m) => !/^\w{1,100}$/.test(m)) ||
      new Set(requested).size !== requested.length
    )
      throw new Error('Configure distinct supported Meta metric names.');
    const metrics: MetricObservation[] = [];
    for (const target of targets) {
      // Query individually: an unsupported optional metric must not hide a supported
      // primary counter or silently turn missing analytics into zero.
      for (const name of requested) {
        try {
          const query = new URLSearchParams({ metric: name, period: 'lifetime' });
          const body = z
            .object({
              data: z.array(
                z.object({
                  name: z.string(),
                  values: z.array(z.object({ value: z.unknown() })).optional(),
                  total_value: z.object({ value: z.unknown() }).optional(),
                })
              ),
            })
            .parse(
              await this.access.request(
                `${this.origin}/${encodeURIComponent(target.platformPostId)}/${instagram ? 'insights' : 'video_insights'}?${query}`
              )
            );
          const found = body.data.find((d) => d.name === name);
          if (!found) continue;
          const count = safeCounter(found.total_value?.value ?? found.values?.at(-1)?.value);
          if (count === null) throw new Error('Meta returned a missing or invalid metric value.');
          const confirmedOrganic =
            (instagram && process.env.INSTAGRAM_ORGANIC_VIEWS_VERIFIED === 'true') ||
            (!instagram &&
              name === organic &&
              process.env.FACEBOOK_ORGANIC_VIEWS_VERIFIED === 'true');
          metrics.push({
            platformPostId: target.platformPostId,
            views: count,
            metric:
              name === paid
                ? 'paid_views'
                : name === organic || confirmedOrganic
                  ? 'organic_views'
                  : 'uncertain_views',
            providerUpdatedAt: null,
            organicVerified: confirmedOrganic,
            provenance: {
              kind: 'cumulative',
              supporting: name !== primary,
              metricName: name,
              scope:
                name === paid
                  ? 'reported_paid_views'
                  : confirmedOrganic
                    ? 'provider_definition_verified_organic'
                    : 'organic_definition_unverified',
              apiVersion: oauthConfig(
                this.account.platform as 'instagram' | 'facebook',
                instagram ? instagramAuthMode(this.account) : 'facebook_login'
              ).version,
              contentType: 'reel',
            },
          });
        } catch (error) {
          this.errors.push(error instanceof Error ? error.message : 'Meta metric request failed.');
          if (
            Date.now() >= this.access.deadline - 1000 ||
            /authorization|rate limit/i.test(this.errors.at(-1)!)
          )
            return metrics;
        }
      }
    }
    return metrics;
  }
}
