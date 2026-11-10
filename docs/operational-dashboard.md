# Operational dashboard and historical media backfill

**Local testing follow-up:** [Local preview refresh](local-preview-refresh.md) explains the queue-only Sync behavior, post-mount rendering clock fix and safe immediate per-account action. Localhost does not run production Cron.

## Verified diagnosis (read-only)

Read-only inspection found five stored TikTok posts dated September 5, September 9, and October 3, 2026. Each was first tracked on November 8, after its eligibility and follow-up window, and none had cached thumbnail JSON. The connected account had synchronized on November 10, but its normal overlapping discovery range no longer included September/October publications.

A read-only Zernio analytics list returned a matching native post/account entry for all five records. Each had `thumbnailUrl` and `mediaItems[].thumbnail` on `media.zernio.com`. A representative image returned HTTP 200 / image/jpeg. The existing image allowlist already accepts this host; no URL fabrication or security relaxation was needed. Signed URLs, account IDs, provider response bodies and credentials were not logged or committed.

Direct table reads were correctly denied; stored data was inspected through the verified read-only `read_dashboard` RPC. No production rows, migrations, settings or provider connections were modified. Provider probing used GET requests only, not sync-external.

The documented endpoint and media fields are in [Zernio analytics](https://docs.zernio.com/core/analytics). Real responses—not just mock contracts—confirmed that this workspace can retrieve the five previews. Browser rendering of all five still requires local validation.

## Automatic backfill

Zernio implements the tracking provider's optional `fetchThumbnails` capability. The worker requests media only after ordinary discovery/view collection, for up to 50 existing, non-erased/non-deleted posts with missing or expired previews. The normal discovery interval, metric targets, snapshot timing and campaign mapping logic remain unchanged.

- Existing per-execution analytics pages are reused, including pages that already prove the thumbnail is missing. Valid cached thumbnails are preserved rather than overwritten.
- If necessary, a read-only analytics query covers the selected publications' date range. It is bounded to two pages, 200 rows and a six-second budget within the existing provider deadline. Platform, native post ID and account matching constrain returned metadata. The query imports no new posts and consumes no counter readings for compensation.
- Missing images have a per-post 24-hour retry interval. Temporary API failures retry through normal account synchronization; insufficient remaining time defers backfill without marking an attempt. Failed optional media requests do not make otherwise successful tracking fail.
- Diagnostics expose `thumbnail_backfilled`, `thumbnail_unavailable`, `thumbnail_backfill_deferred` or `thumbnail_backfill_failed` under skipped outcomes. Snapshot counters do not pretend that metadata-only requests refreshed views.
- Existing Supabase Cron and account polling perform this unattended after deployment. For local validation, use the immediate per-account preview action documented in the follow-up. A normal Sync only queues work and requires a separately invoked local worker; it does not run localhost code automatically. No worker invocation or sync was performed against production during implementation.
- Zernio's 366-day analytics range and bounded pagination can limit large/very old backfills. Unknown or inaccessible images retain placeholders. Expiring signatures are rejected where an expiry is explicit, and browser load failures retain fallbacks. Client-side load failures without an expiry hint are not proof that a cached URL is invalid on the server.

There is no new paid endpoint, scope, dependency, scheduled job or background image download. A historical backfill may add one or two analytics GETs when needed; it is not claimed to require zero additional calls.

## Overview and history

Overview has four compact KPI cards: tracked public views, creators with current active campaign assignments, pending operational reviews, and finalized statements awaiting payment. Creator rankings use one latest public observation per unique publication and show observation coverage, not organic or eligible totals. Recent publications reuse compact Post cards; detailed filters and breakdowns remain in Analytics.

Technical activity is removed from Overview. The underlying audit data remains untouched and the existing Needs attention section retains a collapsible human-readable workspace history. Compensation version history remains available in a collapsed panel with readable scope/settings descriptions and full effective timestamps. Published rules, inheritance and monetary calculations are unchanged.

## Tracking and review states

The shared `postReview` presentation function is used by cards, the comparison table, post details and operational queues. It never approves a view total or rewrites financial inputs.

- **Tracking:** active collection or bounded closing follow-up. Missing initial counters, provider caching, unknown provider timestamps and incomplete organic attribution do not by themselves demand immediate intervention during normal collection. Sampling/retries continue. Persistent missing/failing counters beyond the expected daily interval can need attention.
- **Ready for payout:** an already-accepted eligible total with valid organic/cutoff evidence, a closed eligibility window, and no provider compensation block. It is not approval of a bonus, statement or payment. Previously reviewed organic evidence can resolve an ad flag; a false/missing ad flag never supplies that evidence.
- **Needs review:** unresolved campaign/policy/format/ad issues, invalid legacy acceptance, persistent data failure, or finished collection without verified organic/cutoff evidence. The UI gives a reason and the next action; finalized months require existing linked corrections.
- **Historical:** first discovered after the configured tracking/follow-up window, with no accepted eligible total. These records are separated from urgent operational queues but **remain unresolved for payout finalization** until reviewed or explicitly excluded. They are not automatically classified as test content or silently made eligible.
- **Excluded:** an explicit exclusion, deletion or source erasure. Records remain available according to existing retention policies; excluded posts cannot earn compensation under the existing engine.

The worker's existing automatic collection transitions remain in place. The UI derives these labels from current stored observations/evidence, so recovering API reads and completion update the presentation without separate acknowledgement. No new automatic organic approval or evidence-generation mechanism is introduced. Without supported organic and exact-cutoff evidence, completed public-view tracking still needs a decision.

## Explicit historical exclusion

Needs attention → expand **Historical posts** → **Exclude historical posts** → confirm. Post details also offers a single historical-post exclusion. This is intended for historical content outside the compensation program, including test content identified by the administrator; there is no automatic inference that a creator's real content is a test.

The existing admin-only, same-origin command API accepts a bounded, atomic `excludeHistoricalPosts` command. All selected records must still be unresolved historical posts, and all must be editable. Any finalized/paid-month selection rejects the entire command. Exclusion sets existing eligible views to zero, records the administrator's explicit rationale and an audit event, and recalculates draft statements with the existing rules. No source post, observation, mapping, identity, rule version or finalized financial record is deleted. Later evidence-backed review remains possible only while the month is editable.

No exclusions were executed on production data. Historical records remain financially held until the administrator chooses an appropriate action.

## Configuration / rollout

No **additional** SQL migration, environment variable, dependency, OAuth configuration or Cron change is required for this update. New media-attempt timestamps use the existing tracking JSON. The previously prepared `202611100001_post_thumbnails.sql` retention migration remains a prerequisite if not yet applied; it removes stale preview URLs independently of account activity. Verify migration history and apply only unapplied migrations manually. Do not reset/reseed or rerun the original schema migration.

Before deployment, validate locally: automatic preview appearance after one normal sync, Grid/Table/details state consistency, compact Overview at desktop/tablet/mobile widths, readable history, and the historical exclusion confirmation in isolated preview/test data. Do not confirm destructive/exclusion actions against live data merely to test styling. Verify that historical posts are absent from the urgent count but still hold payout drafts until explicitly resolved. A live browser session was unavailable during this update; interactive visual QA remains necessary.
