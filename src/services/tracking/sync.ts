import 'server-only';
import { cacheThumbnail, usableThumbnail, thumbnailBackfillDue } from '@/domain/post-media';
import { appendObservation, runCommand } from '@/domain/commands';
import { publicationMonth, refreshDrafts } from '@/domain/compensation';
import {
  trackingState,
  metricSamplingDecision,
  needsMetricPolling,
  freshnessHours,
} from '@/domain/tracking';
import { instant } from '@/domain/time';
import type { DashboardData, SyncDiagnostics } from '@/domain/model';
import type { TrackingProvider } from './provider';
export async function synchronizeAccount(
  initial: DashboardData,
  accountId: string,
  provider: TrackingProvider
): Promise<DashboardData> {
  let data = structuredClone(initial);
  const account = data.accounts.find((a) => a.id === accountId);
  if (!account?.provider_account_id || account.status !== 'connected')
    throw new Error('Connect this account before synchronization.');
  const startedAt = new Date().toISOString(),
    runId = crypto.randomUUID();
  const diagnostics: SyncDiagnostics = {
    postsFetched: 0,
    newPosts: 0,
    countersFetched: 0,
    matchedCounters: 0,
    snapshotsSaved: 0,
    updatedCounters: 0,
    freshCounters: 0,
    staleCounters: 0,
    missingCounters: 0,
    skipped: {},
    errors: [],
    observations: [],
  };
  data.syncRuns.unshift({
    id: runId,
    account_id: accountId,
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    message: 'Collecting posts and metrics.',
    diagnostics: null,
  });
  const skip = (reason: string) =>
    (diagnostics.skipped[reason] = (diagnostics.skipped[reason] ?? 0) + 1);
  const event = (
    postId: string,
    outcome: string,
    views: number | null,
    providerAt: string | null
  ) => {
    if (diagnostics.observations.length < 200)
      diagnostics.observations.push({ postId, outcome, views, providerAt });
  };
  const open = data.posts.filter(
    (p) =>
      !p.source_erased_at &&
      p.account_id === accountId &&
      needsMetricPolling(trackingState(data, p, startedAt))
  );
  const overlap = account.last_synced_at
    ? new Date(new Date(account.last_synced_at).getTime() - 2 * 86400000).toISOString()
    : new Date(Date.now() - (account.provider === 'direct' ? 30 : 365) * 86400000).toISOString();
  const earliest = [overlap, ...open.map((p) => p.published_at)].sort()[0];
  const fromDate = (
    earliest < new Date(Date.now() - 365 * 86400000).toISOString()
      ? new Date(Date.now() - 365 * 86400000).toISOString()
      : earliest
  ).slice(0, 10);
  try {
    const discovered = await provider.discoverPosts(account.provider_account_id, fromDate);
    diagnostics.postsFetched = discovered.length;
    for (const post of discovered) {
      try {
        if (!post.url) {
          skip('missing_post_url');
          diagnostics.errors.push(`Post ${post.platformPostId}: missing canonical URL.`);
          continue;
        }
        const existing = data.posts.find(
          (p) => p.account_id === accountId && p.platform_post_id === post.platformPostId
        );
        if (existing && 'isAd' in post)
          existing.tracking = {
            ...trackingState(data, existing, startedAt),
            isAd: post.isAd ?? null,
          };
        if (existing) {
          if (post.thumbnailUrl) {
            existing.tracking ??= trackingState(data, existing, startedAt);
            cacheThumbnail(existing, post.thumbnailUrl, startedAt);
          }
          skip('already_discovered');
          continue;
        }
        const count = data.posts.length;
        data = runCommand(
          data,
          {
            type: 'addPost',
            input: {
              accountId,
              platformPostId: post.platformPostId,
              url: post.url,
              caption: post.caption,
              publishedAt: instant(post.publishedAt),
              campaignId: null,
            },
          },
          'tracking worker'
        );
        diagnostics.newPosts += data.posts.length - count;
        const created = data.posts.find(
          (p) => p.account_id === accountId && p.platform_post_id === post.platformPostId
        );
        if (created && (post.contentType || 'isAd' in post))
          created.tracking = {
            ...trackingState(data, created, startedAt),
            contentType: post.contentType,
            ...('isAd' in post ? { isAd: post.isAd ?? null } : {}),
          };
        if (created && post.thumbnailUrl) {
          created.tracking ??= trackingState(data, created, startedAt);
          cacheThumbnail(created, post.thumbnailUrl, startedAt);
        }
      } catch (error) {
        diagnostics.errors.push(
          `Post ${post.platformPostId}: ${error instanceof Error ? error.message : 'Invalid metadata.'}`
        );
      }
    }
  } catch (error) {
    diagnostics.errors.push(
      `Discovery: ${error instanceof Error ? error.message : 'Request failed.'}`
    );
  }
  const seen = new Set<string>();
  const requested = new Set<string>();
  try {
    // Discovery can reveal a video older than the normal overlap but still inside
    // its eligibility/closing window. Include it immediately, before this job exits.
    const metricNow = new Date().toISOString();
    const metricFloor = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const oldestMetricDate = [
      fromDate,
      ...data.posts
        .filter(
          (p) =>
            !p.source_erased_at &&
            p.account_id === accountId &&
            needsMetricPolling(trackingState(data, p, metricNow))
        )
        .map((p) => p.published_at.slice(0, 10)),
    ].sort()[0];
    const metricFromDate = oldestMetricDate < metricFloor ? metricFloor : oldestMetricDate;
    const targets = data.posts
      .filter((p) => p.account_id === accountId && !p.source_erased_at)
      .filter((p) => {
        const history = data.snapshots
          .filter(
            (s) =>
              s.post_id === p.id &&
              s.source === 'api' &&
              s.provenance?.kind !== 'daily' &&
              s.metric !== 'paid_views' &&
              !s.provenance?.supporting
          )
          .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
        const previous = history.at(-1);
        const polling = needsMetricPolling(trackingState(data, p, metricNow));
        // Attempt a historical initial counter once; missing counters must not
        // keep a closed-window video in hourly metric requests indefinitely.
        if (!previous) return polling || !p.tracking?.lastAttemptAt;
        if (!polling) return false;
        const age = Date.parse(metricNow) - Date.parse(previous.observed_at);
        return (
          age >= 86400000 ||
          (!!p.deadline &&
            Date.parse(p.deadline) - Date.parse(metricNow) <= 6 * 3600000 &&
            age >=
              (Date.parse(metricNow) - Date.parse(p.deadline) > 24 * 3600000 ? 6 : 1) * 3600000)
        );
      })
      .map((p) => ({
        platformPostId: p.platform_post_id,
        publishedAt: p.published_at,
        deadline: p.deadline,
      }));
    for (const target of targets) requested.add(target.platformPostId);
    const observations = await provider.fetchMetrics(
      account.provider_account_id,
      metricFromDate,
      targets
    );
    diagnostics.countersFetched = observations.length;
    const unique = new Map<string, (typeof observations)[number]>();
    for (const o of observations) {
      const key = `${o.platformPostId}:${o.metric}:${o.provenance?.metricName ?? ''}:${o.provenance?.periodStart ?? ''}`;
      const prior = unique.get(key);
      if (
        !prior ||
        (o.providerUpdatedAt &&
          (!prior.providerUpdatedAt ||
            Date.parse(o.providerUpdatedAt) >= Date.parse(prior.providerUpdatedAt)))
      )
        unique.set(key, o);
    }
    for (let duplicate = observations.length - unique.size; duplicate > 0; duplicate--)
      skip('duplicate_counter');
    for (const observation of unique.values()) {
      const post = data.posts.find(
        (p) => p.account_id === accountId && p.platform_post_id === observation.platformPostId
      );
      if (!post) {
        skip('post_not_found');
        continue;
      }
      if (observation.thumbnailUrl) {
        post.tracking ??= trackingState(data, post, new Date().toISOString());
        cacheThumbnail(post, observation.thumbnailUrl, new Date().toISOString());
      }
      if ('isAd' in observation)
        post.tracking = {
          ...trackingState(data, post, new Date().toISOString()),
          isAd: observation.isAd ?? null,
        };
      const supporting =
        observation.metric === 'paid_views' ||
        observation.provenance?.kind === 'daily' ||
        observation.provenance?.supporting;
      if (
        observation.provenance?.contentType &&
        observation.provenance.contentType !== 'shorts_candidate'
      )
        post.tracking = {
          ...trackingState(data, post, new Date().toISOString()),
          contentType: observation.provenance.contentType,
        };
      if (supporting) {
        const prior = data.snapshots
          .filter(
            (s) =>
              s.post_id === post.id &&
              s.provider === provider.name &&
              s.metric === observation.metric &&
              s.provenance?.metricName === observation.provenance?.metricName &&
              s.provenance?.periodStart === observation.provenance?.periodStart
          )
          .at(-1);
        if (prior?.views === observation.views) {
          skip('unchanged_supporting_metric');
          continue;
        }
        const observedAt = new Date().toISOString();
        if (!Number.isSafeInteger(observation.views) || observation.views < 0) {
          skip('invalid_counter');
          diagnostics.errors.push('Supporting metric has an invalid counter.');
          continue;
        }
        if (observation.provenance?.periodEnd && observation.provenance.periodEnd > observedAt) {
          skip('incomplete_reporting_period');
          continue;
        }
        appendObservation(
          data,
          post,
          {
            id: crypto.randomUUID(),
            post_id: post.id,
            views: observation.views,
            metric: observation.metric,
            source: 'api',
            provider: provider.name,
            observed_at: observedAt,
            provider_updated_at: null,
            evidence: null,
            quality: 'uncertain',
            provenance: observation.provenance,
          },
          observedAt
        );
        diagnostics.snapshotsSaved++;
        event(post.id, 'saved_supporting_metric', observation.views, null);
        continue;
      }
      if (seen.has(post.id)) {
        skip('duplicate_counter');
        continue;
      }
      seen.add(post.id);
      diagnostics.matchedCounters++;
      const now = new Date().toISOString();
      post.tracking = trackingState(data, post, now);
      try {
        const timestamp = observation.providerUpdatedAt
          ? instant(observation.providerUpdatedAt)
          : null;
        if (timestamp && (timestamp > now || timestamp < post.published_at))
          throw new Error('Metric timestamp is outside publication-to-now bounds.');
        const changed =
          timestamp !== post.tracking.lastProviderAt ||
          observation.views !== post.tracking.lastViews;
        if (changed) diagnostics.updatedCounters++;
        const fresh =
          !!timestamp &&
          new Date(now).getTime() - new Date(timestamp).getTime() <= freshnessHours * 3600000 &&
          (!post.deadline || now < post.deadline || timestamp >= post.deadline);
        if (fresh) diagnostics.freshCounters++;
        else diagnostics.staleCounters++;
        const reason = metricSamplingDecision(data, post, now, timestamp, observation.views);
        if (reason) {
          skip(reason);
          event(post.id, reason, observation.views, timestamp);
        } else {
          const before = data.snapshots.length;
          appendObservation(
            data,
            post,
            {
              id: crypto.randomUUID(),
              post_id: post.id,
              views: observation.views,
              metric: observation.metric,
              source: 'api',
              provider: provider.name,
              observed_at: now,
              provider_updated_at: timestamp,
              evidence: null,
              quality: observation.organicVerified ? 'reported' : 'uncertain',
              provenance: observation.provenance ?? null,
            },
            now
          );
          diagnostics.snapshotsSaved += data.snapshots.length - before;
          event(post.id, fresh ? 'saved_fresh' : 'saved_stale', observation.views, timestamp);
        }
        post.tracking = {
          ...post.tracking,
          lastAttemptAt: now,
          lastCounterAt: now,
          lastProviderAt: timestamp,
          lastViews: observation.views,
          lastError: null,
        };
        if (
          post.deadline &&
          now <= post.deadline &&
          timestamp &&
          timestamp <= post.deadline &&
          (!post.tracking.latestInWindow || timestamp >= post.tracking.latestInWindow.providerAt)
        )
          post.tracking.latestInWindow = {
            views: observation.views,
            providerAt: timestamp,
            observedAt: now,
          };
        post.tracking = trackingState(data, post, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid counter.';
        diagnostics.errors.push(`Counter ${post.platform_post_id}: ${message}`);
        post.tracking.lastError = message;
        skip('invalid_counter');
        event(post.id, 'invalid_counter', observation.views, null);
      }
    }
  } catch (error) {
    diagnostics.errors.push(
      `Metrics: ${error instanceof Error ? error.message : 'Request failed.'}`
    );
  }
  const now = new Date().toISOString();
  for (const p of data.posts.filter((p) => p.account_id === accountId && !p.source_erased_at)) {
    p.tracking = trackingState(data, p, now);
    if (account.provider !== 'direct' || requested.has(p.platform_post_id))
      p.tracking.lastAttemptAt = now;
    if (
      !seen.has(p.id) &&
      needsMetricPolling(p.tracking) &&
      (account.provider !== 'direct' || requested.has(p.platform_post_id))
    ) {
      diagnostics.missingCounters++;
      p.tracking.lastError = diagnostics.errors.length
        ? 'Refresh failed; retry pending.'
        : 'Provider did not return a counter.';
      if (!p.tracking.issues.includes('counter_missing')) p.tracking.issues.push('counter_missing');
      event(p.id, 'counter_missing', null, null);
    }
    if (p.deadline && p.deadline <= now && p.eligibility_status === 'tracking')
      p.eligibility_status = 'review';
  }
  // Media-only maintenance comes after metric collection and never alters its lookback or targets.
  if (provider.fetchThumbnails) {
    const pending = data.posts
      .filter((p) => p.account_id === accountId && thumbnailBackfillDue(p, Date.parse(now)))
      .sort((a, b) => a.published_at.localeCompare(b.published_at))
      .slice(0, 50);
    if (pending.length)
      try {
        const media = await provider.fetchThumbnails(
          account.provider_account_id,
          pending.map((p) => ({
            platformPostId: p.platform_post_id,
            publishedAt: p.published_at,
            deadline: p.deadline,
          }))
        );
        if (media === null) skip('thumbnail_backfill_deferred');
        else
          for (const p of pending) {
            p.tracking ??= trackingState(data, p, now);
            p.tracking.thumbnailCheckedAt = now;
            const image = media.find((m) => m.platformPostId === p.platform_post_id);
            cacheThumbnail(p, image?.thumbnailUrl, now);
            skip(
              usableThumbnail(p.tracking.thumbnail, Date.parse(now))
                ? 'thumbnail_backfilled'
                : 'thumbnail_unavailable'
            );
          }
      } catch {
        // Optional presentation failures must never fail a successful metric synchronization.
        skip('thumbnail_backfill_failed');
      }
  }
  // Create publication-month drafts automatically; payable totals remain based only on reviewed eligibility.
  const pools = new Map(
    data.posts
      .filter((p) => p.account_id === accountId && p.app_id && p.campaign_id && p.rules)
      .map((p) => [`${p.app_id}:${p.creator_id}:${publicationMonth(p.published_at)}`, p])
  );
  for (const post of pools.values())
    try {
      if (
        !data.statements.some(
          (s) =>
            s.app_id === post.app_id &&
            s.creator_id === post.creator_id &&
            s.month === publicationMonth(post.published_at)
        )
      )
        data = runCommand(
          data,
          {
            type: 'generateStatement',
            appId: post.app_id!,
            creatorId: post.creator_id,
            month: publicationMonth(post.published_at),
          },
          'tracking worker'
        );
    } catch (error) {
      diagnostics.errors.push(
        `Statement: ${error instanceof Error ? error.message : 'Calculation failed.'}`
      );
    }
  refreshDrafts(data);
  const a = data.accounts.find((a) => a.id === accountId)!;
  if (provider.diagnosticErrors) diagnostics.errors.push(...provider.diagnosticErrors());
  a.last_synced_at = now;
  if (provider.accountPatch) a.integration = { ...a.integration, ...provider.accountPatch() };
  a.error = diagnostics.errors.length ? diagnostics.errors.join(' ').slice(0, 2000) : null;
  if (
    a.error?.includes('authorization needs attention') ||
    a.error?.includes('API approval is missing')
  )
    a.status = 'attention';
  const run = data.syncRuns.find((r) => r.id === runId)!;
  run.status = diagnostics.errors.length ? 'failed' : 'success';
  run.finished_at = now;
  run.diagnostics = diagnostics;
  run.message = `Fetched ${diagnostics.postsFetched} posts (${diagnostics.newPosts} new), ${diagnostics.countersFetched} counters; saved ${diagnostics.snapshotsSaved} snapshots. ${diagnostics.freshCounters} fresh, ${diagnostics.staleCounters} stale, ${diagnostics.missingCounters} missing. ${diagnostics.errors.length} error(s).`;
  return data;
}
