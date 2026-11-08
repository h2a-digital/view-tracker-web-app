# Legacy Instagram Login: configuration and rollout

**Superseded for new apps:** new connections now use [Unified Login](instagram-unified-login.md). Meta no longer offers this older setup for newly created apps. This document describes legacy grant behavior only; do not follow its new-app setup instructions for Unified Login.

Existing direct Instagram Login accounts use **Instagram Login**, with `instagram_business_basic` and `instagram_business_manage_insights`. Creators need a public Instagram **Professional Creator or Business** account. Personal accounts must switch first. No Facebook profile or linked Facebook Page is required for this method. The administrator registers the exact Instagram handle, maps the account to its campaign, and shares the existing expiring creator invitation. Creators get no dashboard access.

Existing Facebook-Login Instagram grants continue using their original Page token, Graph host, permissions, actor fingerprint and Facebook app secret. Their reconnect links still use Facebook Login and require their linked Page. An absent mode on an existing remote account means legacy Facebook Login, not a migration. Do not disconnect/delete accounts to switch login methods: disconnection intentionally erases API source data under the existing retention policy. There is no automatic grant conversion in this release. The separate Facebook Page integration, YouTube and TikTok/Zernio are unchanged.

## Meta Developer Dashboard

1. In **My Apps → Create App**, create a **separate app** for Instagram Login. In the flow documented by Meta, choose **Other → Business**, provide the company name/contact, and add the **Instagram** product with **Set up**. Meta can display a use-case selection instead; choose Instagram API with Instagram Login. Do not change the login mode of the existing Facebook app. Meta's App Review guide says one app can use Facebook Login or Instagram Login, not both.
2. Keep the new app in development/testing. Under **App settings → Basic**, configure the domain `creatorhub.h2adigital.com`, real company contact and applicable Business Portfolio. Set:
   - Website / public homepage: `https://creatorhub.h2adigital.com/integrations`
   - Privacy policy: `https://creatorhub.h2adigital.com/integrations/privacy`
   - Human-readable deletion instructions: `https://creatorhub.h2adigital.com/integrations/delete-data`
3. Open **Instagram → API setup with Instagram login → Set up Instagram business login → Business login settings**. Configure these exact URLs, without a trailing slash:

   | Setting                                     | URL                                                                 |
   | ------------------------------------------- | ------------------------------------------------------------------- |
   | OAuth redirect URI                          | `https://creatorhub.h2adigital.com/api/oauth/instagram/callback`    |
   | Deauthorize callback URL                    | `https://creatorhub.h2adigital.com/api/oauth/instagram/deauthorize` |
   | Data deletion request URL (signed callback) | `https://creatorhub.h2adigital.com/api/oauth/instagram/delete-data` |

   The latter two endpoints accept signed POST requests using the **Instagram app secret**. Do not use `/api/oauth/meta/*` for this new app; those remain dedicated to the existing Facebook app. These callbacks are separate from media/messaging webhooks. No messaging webhook subscription or verify token is needed for this polling implementation.

4. Copy the **Instagram App ID** and **Instagram App Secret** displayed in the Instagram login product settings (not the Facebook app credentials). Select a supported Graph version from your app dashboard; the current official examples use `v27.0`.
5. In the permissions/login configuration and **App Review → Permissions and features**, request only **`instagram_business_basic`** and **`instagram_business_manage_insights`**. No publishing, messaging, comment-management, Facebook Page or ads permissions are requested by the code. If the dashboard does not offer insights access for this app/login setup, do not substitute Facebook scopes or assume basic access grants insights: resolve that entitlement with Meta before rollout. The current Insights reference explicitly lists the insights permission for Instagram Login, while the general App Review guide's Instagram permission list omits it; the dashboard's actual entitlement is a required live check.
6. Add a legitimate Professional test account under **Instagram API setup / App Roles → Roles → Instagram Testers**. Accept its tester invitation in Instagram **Settings → Website permissions → Apps and websites → Tester Invites**. Testers must have the applicable app role and grant the requested scopes. Do not use generated dashboard access tokens as a replacement for testing Creator Ledger's OAuth flow.
7. Before external creators connect, obtain **Advanced Access** for both requested permissions through **App Review**, complete business verification and any access/tech-provider verification required by your dashboard, provide reviewer instructions and a screencast, and move the app to **Live** only after approval. Standard Access/testing is limited to eligible app-role/test assets. A private company dashboard does not bypass external-user review. Use disposable reviewer/test assets and creator invitation links; do not give reviewers real payroll access. Complete ongoing Data Use Checkups when requested.

## Netlify variables

In **Project configuration → Environment variables**, add these **server-only** values for the Production context with Functions/runtime scope (or all scopes if your Netlify plan presents that option). Deploy manually after configuration when ready. Do not use a `NEXT_PUBLIC_` prefix.

| Variable                           | Value                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_APP_ID`                 | Instagram product's App ID                                                                                |
| `INSTAGRAM_APP_SECRET`             | Its matching Instagram App Secret                                                                         |
| `INSTAGRAM_GRAPH_VERSION`          | Explicit supported version, e.g. `v27.0`, confirmed in the new app                                        |
| `OAUTH_TOKEN_ENCRYPTION_KEY`       | **Keep the existing value**, 64 hexadecimal characters. Changing it breaks all existing encrypted grants. |
| `APP_URL`                          | Keep `https://creatorhub.h2adigital.com`                                                                  |
| `PUBLIC_SUPPORT_EMAIL`             | Real company contact, intentionally public                                                                |
| `INSTAGRAM_ORGANIC_VIEWS_VERIFIED` | Keep `false` for the pilot                                                                                |

Keep all current Supabase, Google, Zernio, `CRON_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` and optional `META_LOGIN_CONFIG_ID` values. The `META_*` values belong to the existing Facebook app and legacy Instagram grants. New Instagram-only connections do not need them. No paid service is added.

**Database:** no new SQL migration, reset, reseed or data conversion. This change uses existing schema **5**: `accounts.integration` JSON stores `instagramAuthMode`; encrypted token bundles store their method/issue time; encrypted OAuth state binds each invitation flow to the selected method. Existing records without these properties retain legacy behavior. Source erasure, revocation outbox, retention sweeps, optimistic commits and row-version checks reuse the current database functions.

**Cron/hosting:** leave Supabase Cron calling authenticated `POST /api/internal/jobs` every five minutes. No additional scheduled function is introduced. Discovery, metric sampling, token renewal and lifecycle maintenance share the existing bounded worker and account scheduling/retry leases. Renewal also occurs during periodic source authorization checks for accounts with no active tracking posts. Netlify Node 22/Next.js deployment settings remain unchanged.

## Implemented API calls

| Purpose                     | Request                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator authorization       | `GET https://www.instagram.com/oauth/authorize` with fixed redirect, state, read-only scopes, `enable_fb_login=false`, `force_reauth=true`                                        |
| Authorization code exchange | `POST https://api.instagram.com/oauth/access_token` (server-side form)                                                                                                            |
| Long-lived token exchange   | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`                                                                                                       |
| Token renewal               | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`                                                                                                |
| Registered identity         | `GET https://graph.instagram.com/{version}/me?fields=user_id,username`                                                                                                            |
| Native Reel discovery       | `GET /{instagram-user-id}/media?fields=id,caption,timestamp,permalink,media_product_type` on `graph.instagram.com/{version}`; keep `REELS` only, paginate with fixed-host cursors |
| Reel analytics              | `GET /{media-id}/insights?metric=views&period=lifetime` on the same host                                                                                                          |
| Remote revocation attempt   | `DELETE /me/permissions` on the same host; failures remain queued/diagnosed, never reported as successful deletion of remote permissions                                          |

Long-lived tokens last about 60 days. The worker renews valid tokens when fewer than seven days remain and they are at least 24 hours old. Updated grants are encrypted and saved with compare-and-swap, preventing stale refreshes from overwriting a reconnect. Expired/revoked tokens require fresh consent; temporary errors are retried. Account identity is matched by handle at consent and by immutable Graph user ID thereafter. The OAuth app-scoped actor ID is stored separately for deletion callbacks; it need not equal the Graph resource ID.

## Metrics, compensation and limits

The current per-media Insights definition supports Reel `views` and describes organic interactions excluding ads containing the media. `total_views` includes promoted/boosted/ad engagement and Facebook surfaces, is Facebook-Login-only, and is **not collected**. Neither crossposted totals nor Facebook views are added into Instagram views. The API does not establish that traffic is non-artificial or give an exact 168-hour cutoff measurement. Its documentation warns of analytics delays up to 48 hours and session-dependent crosspost inclusion. Insights webhooks are unavailable for Instagram Login; collection must poll.

Consequently `views` remains an **uncertain cumulative observation** unless the existing definition-verification flag is enabled after checking the selected version and a boosted/unboosted/crossposted pilot. That flag verifies the definition only; it does not approve a post, authenticate all traffic, invent freshness timestamps or bypass the cutoff evidence requirement. A failed/missing counter is never zero. Collection time is not provider measurement time. All existing exact 168-hour windows, stale-cutoff follow-ups, manual evidence review, bonus approval, $3,000 cap and America/New_York accounting remain unchanged. Historical discovery is bounded to the existing initial 30-day lookback; old lifetime views cannot become verified seven-day views.

The calls introduce no API subscription charge. They remain subject to Meta's account/app rate limits and Netlify/Supabase usage allowances. Rate limits and temporary failures use the existing backoff; this implementation does not promise fixed throughput for arbitrarily large accounts.

## Manual rollout and acceptance checks

1. Confirm the existing database is schema 5 and preserve your normal backup/export safeguards; **run no new migration** for this feature. Keep the old Facebook app active and its credentials unchanged.
2. Create/configure the new Instagram app in development and add only a disposable Professional test account. Add the new Netlify variables, then deploy through your normal approved process. No deployment or live configuration was performed during implementation.
3. Register that exact handle in Social accounts as **Instagram / Official API**, assign its campaign, and send its Connect invitation to a browser without an admin session. Consent must describe Professional accounts and no Page requirement, open Instagram (not Facebook), verify both permissions, and finish successfully.
4. Publish a native Reel. Wait for the existing Cron discovery and subsequent metric collection; inspect job diagnostics, original UTC timestamp, lifetime metric provenance, uncertain eligibility and the seven-day deadline. Confirm missing/delayed counters are diagnosed. Do not infer exact cutoff data from lifetime insights after the deadline.
5. On disposable test data only, exercise a private deletion link and Meta's actual signed deletion/deauthorization test callbacks. Local source data and copies must be erased while settled company monetary records remain redacted. Verify remote grant revocation completes in worker lifecycle diagnostics. The revocation request is implemented, but its live entitlement/response must be checked against the selected Instagram app/version; fixture tests do not prove production permission revocation. If it fails, revoke via Instagram Apps and websites and resolve the API issue before external onboarding.
6. Confirm an existing Facebook-based Instagram account still reconnects through Facebook, a Facebook Page still syncs, and TikTok/Zernio history is unchanged. Check worker 401 without `CRON_SECRET`, successful scheduled runs, and no credentials in dashboard responses/logs.
7. Finish the permission reviews/verification above and the metric/deletion pilot before admitting external creators. A successful test-account login does not establish Advanced Access.

## Official documentation verified November 8, 2026

- [Instagram Login overview](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login)
- [Business Login: scopes, exchange and renewal](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Get started: user identity and media](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
- [Media insights: scopes, views definitions, delays and limitations](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights)
- [Create an Instagram app: product, callback settings and testers](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app)
- [App Review and login-type separation](https://developers.facebook.com/documentation/instagram-platform/app-review)

The setup, token, identity and insights requirements above were verified in official documentation. The actual app's permission availability, Advanced Access, reviewer acceptance, remote revocation and boosted/crossposted metric behavior still require a live test with your new app; no external OAuth application was activated for this implementation.
