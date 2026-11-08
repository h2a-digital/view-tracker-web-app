# Instagram Unified Login: production configuration and testing

New Instagram registrations use Meta **Unified Login**, Facebook Login for Business and a **Business Integration System User Access Token (SUAT)**. This replaces the default for the Instagram Login implementation, which newly created Meta apps cannot enable. Existing Facebook-based Instagram grants and existing Instagram Login grants with a remote account ID retain their original flow. Unconnected registrations made by the previous release now start Unified Login; request a fresh invitation after upgrading.

No live services were changed. No new SQL migration is needed on schema **5**: the mode is stored in existing account JSON; business ID when returned, configuration ID, system-user/deletion identifiers and token expiry are stored inside the encrypted grant. Do not rerun migrations or reset/reseed the database. Existing TikTok/Zernio, YouTube, Facebook Page connections, source history and compensation rules are preserved.

## Confirmed Meta configuration

| Setting                    | Value                                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| Configuration ID           | `4372319632985486`                                                          |
| Instagram Login Compatible | Yes                                                                         |
| Token                      | System-user access token / SUAT, configured to never expire                 |
| Required asset             | Instagram account                                                           |
| Optional asset             | Ad account; creators can skip it; Creator Ledger does not query ads         |
| Permissions                | `instagram_basic`, `instagram_manage_messages`, `instagram_manage_insights` |
| OAuth redirect             | `https://creatorhub.h2adigital.com/api/oauth/instagram/callback`            |

The configuration controls requested permissions. Creator Ledger supplies `config_id`, not an overriding `scope` list. It rejects a grant missing these permissions or containing unexpected additional permissions (Meta's automatic `public_profile` may be present, but no personal profile fields are collected). Do not add publishing, advertising, Page or `business_management` permissions. The code does not read, send or store messages and does not subscribe to message webhooks. A tracking-only allowlist blocks messaging endpoints and Graph field expansions in the Unified API client.

## Netlify environment variables

Open **Project configuration → Environment variables**. Add these server-only values to the **Production** context with **Functions/runtime** scope (or all scopes where offered). They must be available at runtime. Do not prefix secrets with `NEXT_PUBLIC_` and do not commit a populated environment file.

| Variable                           | Value                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_META_APP_ID`            | **Meta App ID** of the newly configured Unified Login app, from App settings → Basic                      |
| `INSTAGRAM_META_APP_SECRET`        | Matching **Meta App Secret** of that new app                                                              |
| `INSTAGRAM_LOGIN_CONFIG_ID`        | `4372319632985486`                                                                                        |
| `INSTAGRAM_GRAPH_VERSION`          | Supported version confirmed in the app dashboard, e.g. `v27.0` used in the current official documentation |
| `APP_URL`                          | Keep `https://creatorhub.h2adigital.com`                                                                  |
| `OAUTH_TOKEN_ENCRYPTION_KEY`       | **Keep the existing value**. Changing it breaks all existing encrypted grants.                            |
| `INSTAGRAM_ORGANIC_VIEWS_VERIFIED` | Keep `false` during the pilot                                                                             |
| `PUBLIC_SUPPORT_EMAIL`             | Keep/set a real company support email, intentionally public                                               |

`INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` now apply **only to older Instagram Login grants**. The new Unified flow does not use them. Do not put Unified app credentials there.

Keep `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` and `META_LOGIN_CONFIG_ID` unchanged: those belong to the existing Facebook Page / legacy Facebook-based Instagram integration. Keep Google, Zernio, Supabase and `CRON_SECRET` variables unchanged. The new app does not require or request `business_management`.

## Remaining Meta dashboard configuration

1. Keep the new app in **Development** mode and owned by the correct company Business Portfolio. Retain the confirmed Unified configuration above. Under **Use cases → Manage messaging & content on Instagram → Customize → API setup with Unified login**, select **Use this configuration** and confirm the exact callback without a trailing slash.
2. Under **App settings → Basic**, configure the domain `creatorhub.h2adigital.com`, company contact and public URLs:
   - Homepage: `https://creatorhub.h2adigital.com/integrations`
   - Privacy: `https://creatorhub.h2adigital.com/integrations/privacy`
   - Human deletion instructions: `https://creatorhub.h2adigital.com/integrations/delete-data`
3. In the new app's applicable Facebook Login for Business / data-deletion settings, configure:

   | Setting                              | URL                                                                         |
   | ------------------------------------ | --------------------------------------------------------------------------- |
   | OAuth redirect                       | `https://creatorhub.h2adigital.com/api/oauth/instagram/callback`            |
   | Deauthorization callback             | `https://creatorhub.h2adigital.com/api/oauth/instagram/unified/deauthorize` |
   | Data deletion callback (signed POST) | `https://creatorhub.h2adigital.com/api/oauth/instagram/unified/delete-data` |

   These **new Unified callbacks** validate with `INSTAGRAM_META_APP_SECRET` and an isolated grant namespace. Do not change the old app's `/api/oauth/meta/*` callbacks. `/api/oauth/instagram/{delete-data,deauthorize}` remains for older Instagram Login grants and their Instagram secret. OAuth callback URLs are distinct from deletion callbacks and messaging webhooks.

4. For a pilot, open **Generate access tokens → Add account** and invite a legitimate Professional test account as an Instagram Tester. Accept the invitation in Instagram on the web: **Settings → Website permissions → Apps and websites → Tester Invites**. Ensure the testing identity has the required app role/access and the correct business portfolio owns the account. Synthetic Meta Test Users are not supported for this flow. A generated dashboard token is not needed in Netlify; use Creator Ledger's real OAuth flow.
5. Do not configure message/comment webhook subscriptions or subscribe the account to them. Creator Ledger polls media and insights using the existing authenticated worker. If a dashboard/review wizard requests webhook testing for a feature, do not subscribe messaging just to complete a generic checklist; clarify that the app uses media/insights polling and resolve any actual requirement before external onboarding.
6. External creators require **Advanced Access / App Review** for the configuration's permissions and **Live** mode, plus the business/access verification required by Meta. Facebook Login for Business documentation also identifies Advanced Access to `public_profile` as a go-live requirement; follow the dashboard's verification flow rather than adding a new manual OAuth scope. Explain that messaging is required by the compatible Meta configuration but is unused by Creator Ledger. Provide reviewer instructions, a screencast and safe test assets, never actual payroll access. Standard Access/tester success does not authorize external clients.

## Creator experience and connection test

After reviewing and deploying the code through your normal **manual** process:

1. Confirm the existing Supabase Cron still calls authenticated `POST /api/internal/jobs` every five minutes. No new schedule or database configuration is needed.
2. Register the creator's exact Instagram handle as **Instagram / Official API** and map it to the intended campaign. An existing unconnected registration can be used; do not delete a connected account or historical records to test the new flow.
3. Generate a **fresh Connect invitation** and open it in a browser without the administrator session. The consent page must explain the Professional-account and business-portfolio requirements, the optional ad account and Meta's actual three permissions. It must disclose that Creator Ledger does not use messaging capabilities.
4. Continue to Meta. `prompt=login` exposes Instagram and Facebook sign-in options. The creator can choose Instagram without a personal Facebook profile or linked Facebook Page, select the business portfolio that owns the account, select the registered Instagram account and skip the optional ad account. Personal Instagram accounts must switch to Creator/Business first.
5. The callback verifies browser-bound state, the bound app/configuration, the token's app ID/validity/permissions, business identity and assigned Instagram accounts. On reconnect it also requires the existing immutable Instagram account ID. Success grants no dashboard access; the company administrator can confirm the connected account separately.
6. Publish a native Reel, then wait for Cron discovery and metric sampling. Inspect job diagnostics and snapshots. Missing counters remain missing, never zero. Views remain uncertain; no organic/cutoff approval is granted automatically. Initial discovery uses the existing 30-day lookback.
7. On **disposable test assets only**, test cancellation, wrong account selection, revoked asset access and a private deletion link. Test real signed Meta deletion/deauthorization callbacks too. Local source data and copies are erased while finalized monetary records remain redacted; historical TikTok data must remain unchanged.
8. Check worker lifecycle diagnostics for the remote revocation attempt. It uses `DELETE /me/permissions` on the new Meta host with SUAT and app-secret proof. Its live support must be validated on this app/grant: the public Unified guide does not explicitly guarantee that revocation operation for SUAT. A provider refusal remains a pending/failed revocation, never a successful remote revocation. If refused, remove the app from the client business portfolio's integrations/settings and resolve the supported remote-revocation procedure before external rollout. Local deletion does not depend on that remote call succeeding. No broader business-management permission is requested as a workaround.
9. Recheck existing TikTok/Zernio, YouTube, legacy Instagram and Facebook Page synchronization before external onboarding. Complete App Review and Live-mode gates only after the full lifecycle pilot.

## API and lifecycle behavior

- Authorization: Facebook OAuth dialog with Meta app ID, `config_id`, fixed redirect, one-use browser-bound state and `prompt=login`. Configuration/app changes invalidate in-flight invitations.
- Exchange: server-side `GET https://graph.facebook.com/{version}/oauth/access_token`; no Instagram short/long-token exchange.
- Token inspection: `/debug_token`, using the new Meta app credential. Validate required scopes and app identity; never log codes, tokens, cookies or raw provider payloads.
- Business metadata: `/me?fields=client_business_id`, following Meta’s documented request; `/me.id` is the system-user actor, not the Instagram account. The actor ID must match the validated token subject. IDs normalize from digit strings or safe positive integers only. Missing/null business metadata is not an identity failure: this non-expiring configuration does not use the separate BISU token-management API. A present malformed business ID still fails validation. Instagram authorization is established separately by the exact registered account in `/me/assigned_instagram_accounts`, with immutable-ID matching on reconnect. Error diagnostics contain only fixed field-type labels and known token-type categories, never response values.
- Account discovery: `/me/assigned_instagram_accounts?fields=id,username`, paginated via fixed-host cursors. Select only the registered account. No Page discovery or Page token is involved.
- Native Reels: `/{instagram-id}/media` and `/{media-id}/insights?metric=views&period=lifetime` on `graph.facebook.com`, with SUAT and app-secret proof using the **new app's secret**.
- Periodic authorization/source checks use assigned Instagram accounts, not a comparison against `/me`'s system-user ID. Moving/removing assets or invalidating the token requires new consent; rate limits/temporary failures use existing retries. No extra Cron or Netlify function invocation is introduced.
- A token validated with zero expiration is stored as `expiresAt=null`, not an artificial 60-day expiry. Actual positive token/data-access expirations are respected. Never-expiring SUATs are not immortal: they can be revoked. No Instagram refresh call or Business Integration token-management API is made; the configured non-expiring token avoids needing its broader `business_management` permission.
- Source deletion and retention reuse schema-5 transactions and the revocation outbox. Signed requests use the token-debug subject identity and the new app's secret, isolated from legacy grant namespaces. Verify actual signed callback identity correlation in the pilot; fixture signatures cannot establish Meta's live callback behavior. Lost authorization also triggers existing source erasure/checks.
- All existing 168-hour eligibility, cached/uncertain cutoff review, organic evidence, discretionary bonus approval, Facebook exclusion from Versel bonuses, monthly cap and America/New_York accounting remain unchanged. `views` is collected without total/crossposted/Facebook additions and without fabricated provider freshness.

## Official references

- [Unified Login overview](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login)
- [Configuration, OAuth and assigned accounts](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started)
- [SUAT authentication and lifecycle](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication)
- [Permissions and Advanced Access](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/permissions)
- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
- [Media Insights](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights)
- [Migration and new-app availability](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide)

## Instagram consent navigation on Netlify/Chrome

Instagram consent POSTs finish with an HTTP 200 HTML handoff document before opening the server-generated Meta authorization URL through a meta refresh (with a normal link fallback). This deliberately separates the same-origin form submission from Meta's GET redirect chain: Chrome checks downstream redirects of a form's 303 response against `form-action` and can report the original form URL when a later redirect is blocked. No provider wildcard or extra CSP host is added. The trusted HTTPS destination is checked server-side, URL attributes are escaped, and the original OAuth state cookie and no-store headers are preserved. Same-origin Origin validation, explicit consent, invitation validation and the atomic browser-bound OAuth flow are unchanged. YouTube, Facebook and TikTok navigation are unchanged. No script, extra endpoint, database change or Meta callback change is required.
