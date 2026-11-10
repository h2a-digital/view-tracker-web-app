# Local preview refresh and compact Overview

## Confirmed root causes

1. Localhost uses the existing **remote Supabase project**, not a separate local database. A read-only `read_dashboard` check found no `thumbnail` or `thumbnailCheckedAt` value on any of the five TikTok records. No new thumbnail metadata had been persisted.
2. The dashboard's **Sync** action queues a job in Supabase. `next dev` does not run a worker/scheduler. Production Supabase Cron calls the deployed endpoint, not the unpublished code running on localhost. Earlier guidance that one local Sync would run the new backfill was incomplete.
3. Cards received a clock captured at page mount. `usableThumbnail` deliberately rejects capture timestamps later than that clock. A preview fetched after mount could therefore remain invisible even after a successful request. The dashboard now advances a monotonic display clock when replacing data and uses a trusted server `asOf` timestamp. Initial server rendering and dashboard refresh responses also supply server time.

The existing Zernio extraction and HTTPS host validation accept the real `thumbnailUrl` / `mediaItems[].thumbnail` values on `media.zernio.com`. Five matched images were retrieved with read-only requests, returned HTTP 200/image/jpeg, and were decoded and visually inspected as actual frames. No signed URL, credential or production response dump was committed.

## Immediate local testing

1. Reload localhost after updating the code.
2. Open **Social accounts → TikTok account → Details → Load missing previews**.
3. Return to Overview or Posts & performance. All available previews appear immediately; no worker invocation, per-post URL entry or permanent global refresh button is needed.

The contextual action only appears for a supported connected Zernio account with missing/expired previews. It shares the existing loading/error/duplicate-submission behavior. The server validates administrator authentication, origin, account state and native post identity. It rechecks source/connection state after retrieval to prevent restoring data erased or disconnected while the request was in flight.

**With your current localhost + remote Supabase configuration, this action is read-only against Supabase.** Previews are an in-memory overlay for the open dashboard. Ordinary workspace refreshes preserve that overlay while source state remains valid. A full page reload, tab closure or logout clears it. Revoked/disconnected, archived, erased or changed identities cannot receive the old overlay. No browser storage/cookies are added.

The server does not accept a client-supplied `persist` switch. On a correctly configured hosted production deployment, or against an explicitly local Supabase instance, the same action can save missing preview metadata through the existing revision-fenced repository. A local `next start` build with a remote Supabase URL remains read-only; NODE_ENV alone does not authorize shared-project writes. Existing snapshots, eligibility totals, rules, attribution, statements and approvals are not recalculated. Source changes between the final read and save are rejected by the existing revision fence.

No on-demand route was executed against production in write mode during development. The automatic scheduled backfill remains unchanged and will execute the deployed version after a manual deployment; it is separate from this immediate local preview action.

## Validation

- All five actual image assets were downloaded with read-only requests and decoded/viewed successfully.
- A pipeline regression test ran the actual fetched asset URLs through provider metadata application, isolated PostgreSQL persistence/readback, API JSON serialization and the real PostGrid image markup. It produced five image elements and no preview fallbacks, while snapshots, financial records and attribution remained unchanged. The isolated database contained synthetic records, not production records.
- The default pipeline test uses synthetic HTTPS image URLs and makes no live requests. For the separate live-asset verification, `UGC_TEST_PREVIEW_MANIFEST` pointed to a temporary local manifest of URLs obtained by the read-only inspection. This is a test-only input, not a production environment variable or dependency.
- API tests cover admin/origin restrictions, read-only local mode, write-mode revision failures, immutable input preservation, concurrent revocation/erasure, and rejection of a forged persistence parameter.
- Clock and overlay tests cover post-mount captures, missing/expired images, refresh preservation and connection/source changes.
- No browser session was available to the agent. Actual image decoding and the persistence/serialization/markup pipeline are verified; interactive browser layout, image onload behavior and visual viewport checks still need local confirmation.

## Compact Overview

**Top creators** is limited to three observed creators and sits alongside **Performance by platform** on desktop. Both reuse existing card/typography controls, compact rows and the same deduplicated public-view dataset. They align at the top and stretch to the taller content without a fixed/minimum height. Empty states are plain compact text, not large decorative empty panels. The cards stack below 850px.

KPI cards and recent video cards remain unchanged. Search continues filtering summaries/previews, and detailed rankings, comparisons and filters stay in Analytics. Public observations are not represented as organic or approved eligible views; missing platform observations show a dash with coverage information.

## Configuration and limitations

No new SQL migration, production environment variable, OAuth scope, dependency, schedule or paid service is required. If not already applied, the earlier `202611100001_post_thumbnails.sql` remains the retention prerequisite for persistent thumbnail caching. Do not rerun applied migrations or the original schema migration.

Provider omissions, deleted/private media, expired CDN assets and unknown image hosts still use the existing fallback. The on-demand endpoint uses the provider's bounded media-only capability (up to 50 existing posts, at most two analytics pages and a six-second provider budget); it never calls discovery or metrics APIs through the normal synchronization workflow. Preview-only local results deliberately are not permanent when using the shared production database.
