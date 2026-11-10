# Post previews, buttons and confirmations

**Follow-up:** [Operational dashboard](operational-dashboard.md) documents the verified five-post TikTok diagnosis, automatic historical preview backfill and simplified review queues.

## What changed

Posts & performance defaults to a responsive Grid; Table remains available for comparisons. Both views use the same search, app/campaign selection and post-detail flow. Cards show real provider thumbnails where available, title, creator, platform, New York publication date, public observations and existing eligibility status. The view toggle is local UI state; nothing is persisted to production by changing views.

The shared asynchronous Button no longer creates empty idle icon slots. Icon buttons replace the action icon in its existing slot. Text-only buttons overlay a centered spinner while making their label visually transparent; the label retains its geometry and accessible name, so the button neither grows nor reserves idle whitespace. Duplicate guards, `aria-busy`, disabled actions, error handling and `finally` cleanup are preserved. Real icon sizing defaults to 16px; explicit navigation/control sizes remain supported. SVG wrappers now have explicit dimensions to prevent sizing artifacts.

Management, disconnect and finalization confirmations share compact Radix Dialog styling, contextual titles and a bottom Cancel/Confirm group. Decorative icons and duplicate headings were removed. Cancel, close and Escape cannot dismiss an in-flight confirmation. Existing server deletion guards, shared-grant acknowledgements, provider revocation/source-erasure warnings and finalization protections remain authoritative.

## Thumbnail contracts and limits

| Integration               | Provider fields used                                                 | Verification / limitations                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TikTok / Zernio           | `thumbnailUrl`, then `mediaItems[].thumbnail`                        | Documented optional fields from the existing sync-external and paginated analytics responses. Contract tests cover normalization and no extra requests. No promise every native TikTok row has an accessible thumbnail.                    |
| Instagram / Zernio        | Same fields                                                          | Uses the existing Reel-only filter and account matching. No separate media/paid API or permission is added. Live thumbnail availability on the user's Instagram connection still needs testing.                                            |
| YouTube / official        | `snippet.thumbnails.high.url`, then `medium.url`, then `default.url` | Reuses existing `videos.list` requests and the existing per-execution video cache. No constructed `i.ytimg.com` URLs or additional quota calls. Live response rendering remains to be validated.                                           |
| Instagram / Meta official | `thumbnail_url` on `/IG_USER_ID/media`                               | Adds this one documented optional field to existing discovery requests, for legacy Facebook Login, Instagram Login and Unified Login. Unified Login's exact field allowlist is extended narrowly; scopes/messages access remain unchanged. |
| Facebook                  | No new field requested                                               | Existing Facebook integration is unchanged. Cards use a platform fallback; thumbnail support is not claimed.                                                                                                                               |

Sources: [Zernio analytics schema](https://docs.zernio.com/core/analytics), [Zernio sync-external schema](https://docs.zernio.com/analytics/sync-external-posts), [YouTube video resource](https://developers.google.com/youtube/v3/docs/videos#snippet.thumbnails), [Meta IG Media SDK fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/igmedia.py). Meta's reference website returned HTTP 429 during this review; `thumbnail_url` was confirmed in Meta's official generated SDK. Documentation and mocked contract tests are not a live entitlement or CDN test. No production provider API requests were needed for this implementation.

Signed URLs can expire, providers can omit images, and the existing image host allowlist can reject an unknown CDN. Only supported HTTPS image hosts are accepted; OAuth credential parameters are rejected, with the existing TikTok CDN image-signature exception. Missing, expired, malformed, untrusted or failed images use platform-specific placeholders. Images load lazily in the browser with no referrer, without Next.js proxying/downloading or separate thumbnail storage. Failed URLs retry when newly captured thumbnail metadata remounts the image.

Existing posts still receive previews from ordinary discovery/metrics. The follow-up adds a bounded metadata-only Zernio backfill for existing historical posts, without expanding normal discovery or modifying view snapshots. It reuses fetched analytics where possible and adds at most two bounded analytics GETs when needed; missing previews retry daily. See [Operational dashboard](operational-dashboard.md). The browser makes no provider API requests on page load.

## Storage and migration

Optional `{ url, capturedAt }` thumbnail metadata lives under the existing post `tracking` JSON. It is presentation metadata, absent from compensation fingerprints and statement inputs. Normal tracking-state recalculation preserves usable thumbnails; malformed/missing optional provider fields never fail the metrics request or clear valid cached previews. Expired cache entries are dropped when tracking is recalculated. Existing provider source deletion clears the entire tracking object, including thumbnails.

**One small incremental migration is required for unattended cache retention:** `supabase/migrations/202611100001_post_thumbnails.sql`, after the previously prepared migrations through `202611090003_social_profiles.sql`. It wraps the existing service-only retention sweep to remove thumbnail JSON older than 29 days (including malformed/missing capture timestamps), without changing any identity, mapping, snapshot or financial field. The normal workspace revision fence is advanced when cache data is removed. Existing source retention/revocation behavior is delegated unchanged. Schema version remains 5; no new table or column is added.

Apply the migration manually before deployment, after checking the installed migration history. Do not reset/reseed, rerun the original schema migration, or rerun already-applied incremental migrations. Installation is transactional with a five-second lock timeout; it changes no existing records immediately and briefly locks function definitions. If it times out, retry during a quiet period. Its ongoing expiry removes only disposable thumbnail URLs; later normal provider requests may repopulate them. No production migration was executed during development.

No new dependencies, environment variables, paid services, OAuth scopes or Cron schedule changes are required. The existing worker runs the retention sweep. Public views remain unverified traffic: cards use only cumulative public observations, not paid/daily/supporting/organic-only counters or provisional eligible totals. No exact cutoff, organic attribution, compensation rule or approval behavior is changed.

## Local validation before deployment

Use `npm run dev` and `http://localhost:3000/?preview=1` for isolated UI exploration. Sample data may have no real thumbnails; do not invent preview images to fill it. On a real local read-only workspace, recent cached metadata appears after an intentionally requested normal synchronization.

- Check button/icon alignment in navigation, refresh/sync actions, menus, forms, Sheets and compact dialogs. Text-only idle buttons should have no empty icon slot. Exercise a network failure/timeout; pending actions must reset and errors must not show success.
- Test removal/archive/restore, finalization and disconnect dialogs without confirming against production. Verify titles, close button, consequences, Cancel/Confirm placement and shared-grant acknowledgement disabling.
- Check Grid/Table switching, filters and card opening at desktop, tablet and mobile sizes. Tab/Enter should open cards; view toggles expose their selected state. All warnings and eligibility labels should remain unchanged.
- Validate actual cached thumbnails for TikTok/Zernio, Instagram connection methods in use, and YouTube. Block an image request to verify fallback. Confirm grid rendering causes no new provider API requests.
- Test reduced motion, visible focus, long titles/usernames, empty results and viewport-edge controls. A browser session was unavailable to the agent; interactive visual QA remains outstanding.

Automated coverage includes thumbnail parsing/caching and expiry, malformed fields, lazy cards/fallbacks, public counter selection, button loading geometry, unchanged sync snapshot/window behavior, and disposable PostgreSQL migration/permissions/paid-statement preservation.
