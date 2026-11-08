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
import { DirectAccess, durationSeconds, pacificDayBounds, safeCounter } from './base';
import { youtubePolicyApproved } from '@/services/oauth/config';
const videos = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        channelId: z.string(),
        title: z.string(),
        publishedAt: instantSchema,
        liveBroadcastContent: z.string().optional(),
      }),
      statistics: z.object({ viewCount: z.union([z.string(), z.number()]).optional() }).optional(),
      contentDetails: z.object({ duration: z.string() }),
      status: z.object({ privacyStatus: z.string() }),
    })
  ),
});
const dataOrigin = 'https://www.googleapis.com/youtube/v3';
const reportingDate = (instant: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
const analyticsPage = z.object({
  columnHeaders: z.array(z.object({ name: z.string() })).optional(),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
});
export class YouTubeProvider implements TrackingProvider {
  readonly name = 'youtube_official';
  private errors: string[] = [];
  private videoCache = new Map<string, z.infer<typeof videos>['items'][number]>();
  diagnosticErrors() {
    return this.errors;
  }
  private access: DirectAccess;
  constructor(
    private account: SocialAccount,
    deadline = Date.now() + 45000
  ) {
    this.access = new DirectAccess(account, deadline);
  }
  capabilities() {
    return {
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['youtube'] as ['youtube'],
    };
  }
  accountPatch() {
    return {
      ...this.access.patch,
      payoutsBlocked: !youtubePolicyApproved(),
      policyReason: youtubePolicyApproved()
        ? undefined
        : 'YouTube analytics policy approval required before compensation.',
    };
  }
  private async list(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !this.videoCache.has(id));
    for (let start = 0; start < missing.length; start += 50) {
      const query = new URLSearchParams({
        part: 'snippet,statistics,contentDetails,status',
        id: missing.slice(start, start + 50).join(','),
      });
      for (const video of videos.parse(await this.access.request(`${dataOrigin}/videos?${query}`))
        .items)
        this.videoCache.set(video.id, video);
    }
    return [...new Set(ids)].flatMap((id) =>
      this.videoCache.has(id) ? [this.videoCache.get(id)!] : []
    );
  }
  async discoverPosts(accountId: string, fromDate?: string): Promise<DiscoveredPost[]> {
    const channel = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string() }) }),
          })
        ),
      })
      .parse(
        await this.access.request(
          `${dataOrigin}/channels?part=contentDetails&id=${encodeURIComponent(accountId)}`
        )
      );
    const uploads = channel.items.find((c) => c.id === accountId)?.contentDetails.relatedPlaylists
      .uploads;
    if (!uploads) throw new Error('YouTube channel no longer exists or is inaccessible.');
    let pageToken: string | undefined;
    const ids: string[] = [];
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        part: 'contentDetails',
        playlistId: uploads,
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      });
      const result = z
        .object({
          items: z.array(
            z.object({
              contentDetails: z.object({
                videoId: z.string(),
                videoPublishedAt: instantSchema.optional(),
              }),
            })
          ),
          nextPageToken: z.string().optional(),
        })
        .parse(await this.access.request(`${dataOrigin}/playlistItems?${query}`));
      for (const item of result.items)
        if (
          !fromDate ||
          !item.contentDetails.videoPublishedAt ||
          item.contentDetails.videoPublishedAt >= fromDate
        )
          ids.push(item.contentDetails.videoId);
      if (
        !result.nextPageToken ||
        result.items.some(
          (i) =>
            !!i.contentDetails.videoPublishedAt &&
            !!fromDate &&
            i.contentDetails.videoPublishedAt < fromDate
        )
      )
        break;
      if (page === 9)
        throw new Error('YouTube history exceeds this sync budget. Narrow the discovery interval.');
      pageToken = result.nextPageToken;
    }
    return (await this.list(ids))
      .filter(
        (v) =>
          v.snippet.channelId === accountId &&
          v.status.privacyStatus === 'public' &&
          (!v.snippet.liveBroadcastContent || v.snippet.liveBroadcastContent === 'none') &&
          durationSeconds(v.contentDetails.duration) <= 180
      )
      .map((v) => ({
        platformPostId: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        caption: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        contentType: 'shorts_candidate',
      }));
  }
  async fetchMetrics(
    accountId: string,
    fromDate?: string,
    targets: MetricTarget[] = []
  ): Promise<MetricObservation[]> {
    const metrics: MetricObservation[] = [];
    for (const video of await this.list(targets.map((t) => t.platformPostId))) {
      if (video.snippet.channelId !== accountId || video.status.privacyStatus !== 'public')
        continue;
      const count = safeCounter(video.statistics?.viewCount);
      if (count !== null)
        metrics.push({
          platformPostId: video.id,
          views: count,
          metric: 'public_views',
          providerUpdatedAt: null,
          organicVerified: false,
          provenance: {
            kind: 'cumulative',
            metricName: 'statistics.viewCount',
            scope: 'public_lifetime_includes_replays_may_include_advertising',
            apiVersion: 'v3',
          },
        });
    }
    const last = this.account.integration?.lastAnalyticsAt;
    if (last && Date.now() - Date.parse(last) < 24 * 3600000) return metrics;
    // One authorized report per due video per day; supported traffic-source report,
    // with separate Shorts classification and Pacific reporting-day provenance.
    for (const target of targets) {
      try {
        const query = new URLSearchParams({
          ids: 'channel==MINE',
          startDate: reportingDate(target.publishedAt),
          endDate: reportingDate(
            new Date(
              Math.min(Date.now(), target.deadline ? Date.parse(target.deadline) : Date.now())
            ).toISOString()
          ),
          metrics: 'views',
          dimensions: 'day,insightTrafficSourceType,creatorContentType',
          filters: `video==${target.platformPostId}`,
          maxResults: '200',
          sort: 'day',
        });
        const result: z.infer<typeof analyticsPage> = { rows: [] };
        for (let page = 0; page < 5; page++) {
          query.set('startIndex', String(page * 200 + 1));
          const batch = analyticsPage.parse(
            await this.access.request(`https://youtubeanalytics.googleapis.com/v2/reports?${query}`)
          );
          if (page && JSON.stringify(batch.columnHeaders) !== JSON.stringify(result.columnHeaders))
            throw new Error('YouTube Analytics columns changed during pagination.');
          result.columnHeaders = batch.columnHeaders;
          result.rows!.push(...(batch.rows || []));
          if ((batch.rows?.length ?? 0) < 200) break;
          if (page === 4) throw new Error('YouTube Analytics report exceeds this sync budget.');
        }
        const headers = result.columnHeaders?.map((c) => c.name) || [];
        if (
          result.rows?.length &&
          ['day', 'insightTrafficSourceType', 'creatorContentType', 'views'].some(
            (h) => !headers.includes(h)
          )
        )
          throw new Error('Unexpected YouTube Analytics report columns.');
        const groups = new Map<
          string,
          { views: number; paid: boolean; day: string; type: string }
        >();
        for (const row of result.rows || []) {
          const get = (key: string) => row[headers.indexOf(key)],
            day = String(get('day')),
            type = String(get('creatorContentType')),
            paid = get('insightTrafficSourceType') === 'ADVERTISING',
            views = safeCounter(get('views'));
          if (views === null) throw new Error('Invalid YouTube Analytics counter.');
          const key = `${day}:${paid}:${type}`,
            previous = groups.get(key);
          groups.set(key, { views: (previous?.views ?? 0) + views, paid, day, type });
        }
        for (const group of groups.values()) {
          const bounds = pacificDayBounds(group.day);
          if (bounds.periodEnd > new Date().toISOString()) continue;
          metrics.push({
            platformPostId: target.platformPostId,
            views: group.views,
            metric: group.paid ? 'paid_views' : 'organic_views',
            providerUpdatedAt: null,
            organicVerified: false,
            provenance: {
              kind: 'daily',
              metricName: group.paid
                ? 'analytics.views.ADVERTISING'
                : 'analytics.views.non_advertising',
              ...bounds,
              timezone: 'America/Los_Angeles',
              scope: group.paid
                ? 'reported_advertising_traffic'
                : 'non_advertising_traffic_not_fraud_verification',
              apiVersion: 'v2',
              contentType:
                group.type === 'SHORTS'
                  ? 'shorts'
                  : group.type === 'UNSPECIFIED'
                    ? 'shorts_candidate'
                    : 'other',
            },
          });
        }
      } catch (error) {
        this.errors.push(error instanceof Error ? error.message : 'Analytics request failed.');
        break;
      }
    }
    if (targets.length && !this.errors.length)
      this.access.patch.lastAnalyticsAt = new Date().toISOString();
    return metrics;
  }
}
