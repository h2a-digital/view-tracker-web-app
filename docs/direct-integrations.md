# Direct YouTube, Instagram and Facebook integrations

Prepared November 8, 2026. **See [the lifecycle and production rollout checklist](production-rollout.md) for schema 5, deletion/revocation callbacks, retention and cutover order.** No deployment, OAuth application activation, live database change or paid service purchase was performed. TikTok continues to use the existing Zernio account/connection. Direct integrations never use Zernio and do not consume its two-account allowance.

## Upgrade the existing database once

Stop old application/worker processes for the cutover. Keep your usual backup available. In Supabase SQL Editor, inspect:

```sql
select public.read_dashboard()->>'schemaVersion' as schema_version;
```

This release requires **schema 5**. If currently at 3, apply `supabase/migrations/202611080003_direct_integrations.sql` once, followed by `supabase/migrations/202611080004_provider_lifecycle.sql` once. If at 4, apply only 004. If still at 2, first apply the previously prepared operations migration 002. At 5, skip migrations. Never rerun the original migration, reset/reseed the database or delete existing records.

003 adds private encrypted OAuth tables, optional account/snapshot provenance, extra metric classifications, provider-policy guards and support for up to eight account jobs per worker invocation. No TikTok connections, historical observations, rules, finalized statements, account ownership or accounting timezone are rewritten. Existing RLS and service-only RPC protections remain. OAuth material is never returned by `read_dashboard` or the browser API. The schema 5 lifecycle erases direct-provider source details on revocation/deletion/retention expiry, preserving settled company monetary records with source counts/evidence redacted.

The current application refuses to operate against an earlier schema. Do not keep an older worker running after upgrading. This migration does not schedule jobs or contact providers.

## Production environment and URLs

For new Instagram connections, use the separate credentials and exact configuration in [Unified Login setup](instagram-unified-login.md); the `META_*` settings below remain for Facebook and legacy grants. Retain every existing Netlify/Supabase/TikTok variable. Add these **through Netlify Project configuration → Environment variables**, Production only, including Functions scope; use Builds + Functions / All scopes where needed for the proxy/adapter. Never put these secrets in `netlify.toml`, public source, `NEXT_PUBLIC_*`, OAuth URLs or chat.

| Variable                            | Value                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OAUTH_TOKEN_ENCRYPTION_KEY`        | 64 random hex characters, e.g. `openssl rand -hex 32`. AES-256-GCM key; securely back it up. Changing it without migrating stored ciphertext makes existing grants unreadable; reconnect affected accounts if lost. |
| `GOOGLE_CLIENT_ID`                  | Google Web application OAuth client ID                                                                                                                                                                              |
| `GOOGLE_CLIENT_SECRET`              | Matching Google OAuth client secret                                                                                                                                                                                 |
| `META_APP_ID`                       | Meta app ID                                                                                                                                                                                                         |
| `META_APP_SECRET`                   | Matching Meta app secret                                                                                                                                                                                            |
| `META_GRAPH_VERSION`                | Explicit supported Graph API version for your app, e.g. `v26.0`. Verify your chosen version before enabling production.                                                                                             |
| `META_LOGIN_CONFIG_ID`              | Optional Facebook Login for Business configuration ID; required if your selected Meta setup requires it. Its configuration must grant the requested scopes.                                                         |
| `PUBLIC_SUPPORT_EMAIL`              | Company mailbox intentionally rendered on public privacy/deletion pages. An administrator must monitor it.                                                                                                          |
| `YOUTUBE_ANALYTICS_POLICY_APPROVED` | Default `false`. Set `true` only after resolving YouTube derived-metric/financial-use and cross-owner aggregation approval, consent and retention obligations. OAuth verification alone is insufficient.            |
| `INSTAGRAM_ORGANIC_VIEWS_VERIFIED`  | Default `false`. Only set `true` after current Meta media-metric definitions and a boosted/unboosted test verify that media `views` excludes paid traffic for the selected API/version.                             |
| `FACEBOOK_ORGANIC_VIEWS_VERIFIED`   | Default `false`; requires the same verification for the configured Facebook organic metric.                                                                                                                         |
| `FACEBOOK_REEL_VIEW_METRIC`         | Candidate default `fb_reels_total_plays`. Validate on a native Page Reel. Configure the supported replacement if Meta requires a different metric for your version.                                                 |
| `FACEBOOK_REEL_ORGANIC_METRIC`      | Optional supported organic metric name; blank by default. No unsupported field is invented or silently replaced with another count.                                                                                 |
| `FACEBOOK_REEL_PAID_METRIC`         | Optional supported paid metric name; blank by default.                                                                                                                                                              |

No Google API key or publishing permission is required. Direct provider configuration is optional for accounts still using manual/CSV. The worker does not require a Zernio key just to run direct-only jobs; existing TikTok jobs continue to need the current Zernio key. Redeploy after environment changes. No provider application is activated just by adding code to this repository.

Use your existing canonical HTTPS `APP_URL`, e.g. `https://hub.example.com`. These exact callback paths are implemented:

- Google: `https://hub.example.com/api/oauth/youtube/callback`
- Instagram (Unified Login for new accounts; existing Instagram/Facebook Login grants preserved): `https://hub.example.com/api/oauth/instagram/callback`
- Facebook Pages: `https://hub.example.com/api/oauth/facebook/callback`

Replace the origin everywhere; do not add tickets, queries, wildcards or trailing paths to the registered callback. Start/invitation URLs are created by the app and are **not** registered callbacks. Register production callbacks, not individual Netlify preview URLs. Application preview isolation stays enabled.

Public review/onboarding pages:

- Home/application description: `https://hub.example.com/integrations`
- Privacy policy: `https://hub.example.com/integrations/privacy`
- Data deletion instructions: `https://hub.example.com/integrations/delete-data`

These pages grant no dashboard access. The policy copy and real support contact must be reviewed by the company before publication; a page or feature flag is not proof of policy compliance. Creator private deletion links, signed Meta callbacks and retention sweeps now erase source data automatically; see the rollout guide for exact callback URLs and backup/export obligations.

## Google Cloud / YouTube setup

1. Create/select the company Google Cloud project. Enable **YouTube Data API v3** and **YouTube Analytics API**. Do not purchase quota or services. Ordinary pilot reads should fit the default quota; verify the actual Console quota. Current ordinary list reads cost one unit and use a 10,000-unit/day bucket. Analytics has separate request limits. No upload/search API is used.
2. Configure **Google Auth Platform → Branding/Audience/Data Access** (or OAuth consent screen in an older Console). External creators require an **External** audience; the company's private dashboard does not qualify outside creators for Workspace Internal access.
3. Supply app name, company support/developer contacts, the public home/privacy URLs above, and a verified authorized domain. Complete domain ownership/brand verification as required. Do not make the administrator dashboard or real payout records public for review.
4. Declare only:

   ```text
   https://www.googleapis.com/auth/youtube.readonly
   https://www.googleapis.com/auth/yt-analytics.readonly
   ```

   No upload, account management, Gmail, monetary analytics or revenue scope is requested.

5. Create **Clients → Web application** and register the exact Google callback above. This is a server-side OAuth flow; a browser JavaScript origin/API key is not required. Copy client ID/secret into Netlify's server environment. For local testing, a separate Web client may register `http://localhost:3000/api/oauth/youtube/callback`; keep production credentials separate.
6. During development, add explicit test users. A Testing-mode external consent screen normally produces refresh tokens expiring after **seven days**, so it cannot support unattended production. Move to the correct production publishing/verification status when approved. Submit branding/sensitive-scope verification, minimum-scope justification and a demonstration of the invitation/consent/read-only analytics flow. Do not assume a small number of creators exempts every production requirement.
7. Separately resolve the YouTube API analytics-use policy. Current developer policies restrict derived metrics and cross-content-owner aggregation; the newer analytics amendment covers specified metrics, including financial projections/sponsorship pricing. Seek the appropriate amendment/audit/permission for Creator Ledger's exact payout/aggregation use case, even if no extra quota is required. Obtain clarity on financial-record retention and deletion. Only then set `YOUTUBE_ANALYTICS_POLICY_APPROVED=true` and run the worker to update direct accounts' policy flags. Default behavior collects per-video evidence but excludes these accounts from aggregate view figures, provisional compensation and acceptance/finalization. It never presents your creator CPM as YouTube advertising revenue.
8. Register a **direct YouTube** account in Creator Ledger using the exact channel ID (`UC…`) or actual `@handle`, not the channel display name. The creator must select/authorize that exact channel (including the correct Brand Account channel). Set the campaign mapping before connecting.

Discovery uses `channels.list` → uploads playlist → `playlistItems.list` and batched `videos.list` reads. Public, non-live videos up to three minutes are initially **Shorts candidates**, not automatically certified Shorts. The daily Analytics report's `creatorContentType` confirms Shorts where available. Sparse/missing analytics may require explicit evidence-backed Shorts confirmation during review. Analytics identifying non-Shorts content blocks eligibility for that candidate.

Public `statistics.viewCount` remains a cumulative public counter, possibly including advertising and replays. Analytics uses separate Pacific-day reports with `day,insightTrafficSourceType,creatorContentType` dimensions. `ADVERTISING` rows are paid evidence; other source rows are labeled non-advertising evidence, **not certified fraud-free organic views**. Analytics is requested at most daily per account after a completed report cycle. A failed Analytics request preserves public counters and schedules retry. Missing/suppressed rows are not converted to zero. A cached video response can be reused during the same sync to avoid duplicate requests. Analytics queries use Pacific publication/cutoff dates, paginate up to 1,000 rows per video, and report an error rather than silently truncate if that budget is exceeded. Boundary-day buckets remain supporting evidence; their inclusion in a query does not make the entire day eligible.

Google access tokens refresh server-side, preserving refresh tokens when omitted from refresh responses. Credential writes use version checks so an old refresh cannot overwrite a reconnect. `invalid_grant` removes the unusable stored grant and marks the account for reauthorization; 429/quota errors back off without asking for reconnection. Channel identity and granted scopes are verified before a connection is committed.

Official references: [uploads](https://developers.google.com/youtube/data/guides/implementation/videos), [channel Analytics reports](https://developers.google.com/youtube/analytics/channel_reports), [OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [sensitive scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [developer policies](https://developers.google.com/youtube/terms/developer-policies), [analytics amendment](https://developers.google.com/youtube/terms/derived-metrics-policy), [quotas](https://developers.google.com/youtube/data/determine_quota_cost).

## Meta for Developers setup (Instagram and Facebook)

**New Instagram connections default to Unified Login**, with no linked Page required; creators can sign in with Instagram and select the owning business portfolio. Meta requires messaging permission in this configuration, but Creator Ledger does not access messages. They require a Professional Creator or Business account. Follow [the Unified Login setup guide](instagram-unified-login.md) for the separate app, permissions, environment variables and callbacks. The instructions below apply to **existing Facebook-Login Instagram grants and the separate Facebook Page integration**. Existing Instagram grants keep their original linked-Page requirements. Facebook tracking supports **Pages**, not ordinary or professional-mode personal profiles. No fake personal Facebook accounts should be created for partnerships.

1. Create/select the company's Meta developer app with the appropriate Business use case and Facebook Login for Business product/configuration for reading managed Pages and linked professional Instagram accounts. Associate the correct Business Portfolio. Keep the app in development/testing until approved.
2. Set the app domain/canonical HTTPS host, app contact, public privacy policy, public home URL and **data deletion instructions URL** above. Register `/api/oauth/meta/deauthorize` as the deauthorization callback and `/api/oauth/meta/delete-data` as the data deletion callback. Both validate Meta signed requests; the human instructions page is separate.
3. Under Facebook Login settings/configuration, enable the appropriate web/server OAuth flow and keep the Facebook callback URL and, for existing Facebook-based Instagram grants, the Instagram callback URL above as exact valid OAuth redirect URIs. Set `META_LOGIN_CONFIG_ID` if the product requires a generated login configuration. Its configured permissions must include the ones used by the requested flow.
4. Required read scopes:

   | Connection | Requested scopes                                                                           |
   | ---------- | ------------------------------------------------------------------------------------------ |
   | Instagram  | `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights` |
   | Facebook   | `pages_show_list`, `pages_read_engagement`, `read_insights`                                |

   The combined set is five distinct permissions. No publishing, messaging, comment-management or ads-management permission is requested by Creator Ledger. Some Business Manager/asset arrangements can require additional Meta permissions; those arrangements are not silently assumed supported. If Meta's app dashboard/current reference requires additional access, review the scope/use case before extending the code.

5. For development, authorize legitimate app-role/test users with access to the intended Page and Instagram account. Ordinary external creators require the relevant **Advanced Access/App Review**. Prepare business verification and any tech-provider/access verification requested by the dashboard; being an internal company tool does not bypass external-user requirements. Supply screencasts, reviewer instructions and a safe test setup demonstrating each requested permission. Never share production secrets or allow reviewers into actual payroll records.
6. The creator must have Page analytics access (`ANALYZE`/the applicable New Pages Experience task or full-control equivalent). The callback verifies granted permissions, matches the registered resource and checks the returned Page tasks. For Instagram, use the exact Instagram handle. For Facebook, register the **numeric Page ID**, not a vanity URL or personal handle. `/me/accounts` is paginated; the server never follows an arbitrary external paging URL.
7. Test a Reel posted directly in Instagram and another posted directly on the Facebook Page. Verify discovery, original timestamps and counter changes on later syncs. Confirm the chosen Facebook metric works on your actual API version. The SDK confirms the endpoints; it does not guarantee that every legacy video metric applies to Reels. Unsupported metrics remain diagnosed rather than replaced by zero. A failure in an optional metric does not discard an available primary counter.
8. Compare boosted and unboosted test content against the **current per-media metric definition**. Keep the organic-verification switches false until the definition and pilot support them. Instagram's `views` is collected, while `total_views`, `crossposted_views` and Facebook cross-post totals are not added into the eligible Instagram counter. Facebook optional paid/organic counters are stored separately. Never infer that total minus an incompatible paid metric equals organic views. Version changes require renewed validation.

For legacy Instagram and Facebook Page grants, the callback exchanges the short-lived Facebook user token for a long-lived user token, then stores the selected Page token encrypted. The long-lived user grant is retained encrypted only to support provider-side permission revocation; Page tokens remain the analytics credential. Page tokens do not behave like Google refresh tokens: there is no generic Meta refresh token to use indefinitely. The application uses the valid Page token and detects invalidation/revocation (including Graph error 190); a new creator authorization restores access. Tokens with no fixed expiry can still be revoked. Requests include app-secret proof; API responses/tokens are not logged or returned to the dashboard.

Official references: [Meta's Instagram collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [Facebook/Page token collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api), [Instagram Insights reference](https://developers.facebook.com/docs/instagram-platform/insights/), [Page API setup](https://developers.facebook.com/docs/pages-api/getting-started/), [Reel discovery SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py), [video Insights SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/advideo.py).

## Creator connection flow and admin operation

1. Add the creator, campaign assignment, **direct** platform account and routing interval from the dashboard. The account registration form offers Direct / Zernio / Manual. TikTok must stay on Zernio; manual/CSV remains available for every platform.
2. Click Connect and send the generated invitation URL to that creator. The invitation expires in 30 minutes; beginning authorization creates a 15-minute browser-bound OAuth state. Starting again invalidates the previous flow for that invite. Complete one connection at a time in the same browser; rejecting cookies or swapping browsers breaks the state check safely.
3. The creator first accepts the visible privacy/data-use policy (and YouTube terms for Google), then continues to consent at Google or Meta. Cross-origin or non-consenting POSTs cannot start authorization. Callback code checks the exact registered identity, browser state and scope grant. Single-use state, token encryption and account update are committed atomically. A failed/replayed callback grants no dashboard session. Close the success page and refresh Social accounts as administrator.
4. The callback queues discovery. Scheduled jobs subsequently discover native uploads and collect counters automatically. No manual Sync is required in normal operation.
5. Disconnect removes source data and direct credentials, invalidates invitations/leases and queues provider-side grant revocation. Shared grants may affect multiple accounts. Platform videos are never deleted. Settled company monetary records retain no API source views/evidence; see the lifecycle guide.

## Seven-day tracking, evidence and compensation

The eligibility deadline is still **publication + 168 elapsed hours**, and the accounting month is still **America/New_York**. Facebook remains excluded from Versel's existing bonus rules; no rule versions are rewritten. Base payment remains TikTok-only, with manual bonus approval and the $3,000 cap unchanged.

New snapshot classifications are `public_views`, `organic_views`, `paid_views` and `uncertain_views`. Provenance records the provider metric name, API version, cumulative versus daily period, source scope, and reporting timezone where applicable. Graph publication timestamps with explicit compact offsets (for example `-0500`) are normalized to UTC; timezone-less timestamps are rejected. All new direct readings start with unknown provider measurement time unless the API supplies an authoritative time; collection time is never fabricated as measurement freshness. Organic labels alone do not imply approved eligibility. Google non-advertising rows remain uncertain evidence even though separated from paid rows.

Paid counts, supporting metrics and daily Analytics buckets never overwrite the primary tracking counter or become provisional eligible totals. A direct cumulative count observed **before** the cutoff can support a clearly provisional lower-bound estimate, with unknown freshness explicitly retained. Post-deadline lifetime counts are excluded. Shorts candidates remain out of provisional payouts until classified; YouTube policy-blocked accounts remain out altogether. Review still requires exact-window and organic evidence, and a Shorts confirmation when classification remains uncertain. Neither verified-organic switches nor successful tracking accept a post automatically.

Default discovery overlap remains two days. New direct accounts initially request a **30-day** discovery window to avoid expensive, ineligible lifetime backfills; Zernio's existing lookback is unchanged. Discovery and query pagination have explicit safety budgets (up to 500 YouTube upload rows / 1,000 Meta media rows per sync); exceeding them is an error, not a claim of complete history. Instagram does not promise sortable ordering, so older rows do not silently stop pagination. Very large pre-existing accounts need a dedicated resumable backfill before onboarding; the dedicated partnership accounts are the intended pilot.

Direct counters are fetched only when a post is due: daily normally and hourly in the final six hours. Direct integrations have bounded closing follow-up up to **72 hours** to accommodate delayed analytics; after the first closing day, fetches are reduced to approximately six-hour sampling. This does not extend eligibility. TikTok's existing 24-hour hourly follow-up is unchanged. When freshness/cutoff cannot be verified, collection transitions to review rather than inventing exact eligible views. Calendar-day Analytics reports cannot prove a 168-hour total, especially across Pacific DST boundaries. The extra grace period cannot solve missing event-level data.

## Worker throughput and Free-plan limits

Keep the existing Supabase Cron/Vault setup, authenticated POST endpoint and five-minute cadence. No new scheduler, paid queue or Netlify native Scheduled Function is needed. The worker now processes **up to eight leased account jobs per HTTP call**, sequentially within the shared 45-second provider deadline, and stops claiming jobs when less than eight seconds remain. Atomic per-job saves, optimistic revisions and lease tokens are preserved. One failed account does not discard another account's successful transaction. A timeout's lease expires after three minutes and can be recovered later.

Do not interpret eight jobs as guaranteed throughput under slow APIs. Native daily sampling, within-batch workspace reuse, within-sync YouTube caching, batched video reads and daily Analytics requests reduce unnecessary calls. OAuth refreshes are on demand. Rate limits record a retry-not-before timestamp and the database honors it alongside exponential backoff. Empty data is never zero. A historical video with no counter receives an initial attempt and is then held for review; it does not remain in hourly metric fetches forever. Provider authorization/permission failures are flagged for attention; temporary failures retry automatically.

Monitoring: **Needs attention → Automation health** exposes worker results, queue state, account errors, provider configuration booleans and verification switches without credentials. Per-run diagnostics distinguish fetches, saved observations, missing counters and stale/unknown measurements. Metric history shows source metric/period/quality. The worker response includes per-account `results`; `processed` can now be greater than one. HTTP 200 means the handled jobs succeeded, not that every provider counter advanced or any compensation was approved. Check Netlify Usage & billing after the first few days; monthly requests remain ~8,640, but execution duration increases with actual work.

## Remaining production gates

- Google/Meta OAuth credentials, callback registration, required provider API permissions, review/verification and working creator-owned test accounts are not provisioned by this implementation. Contract/fixture tests do not prove live entitlement.
- YouTube analytics-policy approval is an explicit payout/aggregation gate. Do not set the approval flag as a workaround. Current policy restrictions on cross-owner aggregation must be resolved for the intended admin overview as well as financial calculations.
- Current Meta organic definitions and Facebook Reel metric availability must be verified in the actual app/API version. Until then, counters are uncertain and paid/organic precision is not promised.
- Public home/privacy/deletion pages need a real company contact and approved operational policy. The automated source lifecycle now covers closed-window verification, deletion, revocation and expiration. Company accounting retention, backup/export handling and actual provider callback validation still require the rollout checklist. TikTok source history is outside these direct-provider erasure jobs.
- Account tokens can be revoked; creators will occasionally need to reconnect. No integration can guarantee zero intervention, exact event-level cutoffs, fraud detection or a missing organic split.
- The shared pilot workspace is loaded once per worker batch and reused after successful commits; optimistic conflicts invalidate that cache. It remains a full-workspace transaction model. Before a large 5–10-creator four-platform rollout, use scoped persistence/pagination and measure Netlify compute credits and Supabase egress/database growth. Free hosting is appropriate for the initial pilot, not a guarantee of unlimited unattended operation.

## Consent form troubleshooting

The creator consent page uses `Referrer-Policy: strict-origin`. Native browser form POSTs under `no-referrer` send `Origin: null`, which the unchanged same-origin guard rejects before invitation lookup, OAuth state creation or cookie issuance. `strict-origin` preserves the canonical origin while excluding invitation paths and query strings from referrers. Missing/null/foreign origins remain rejected.

The consent page's CSP permits its own form endpoint plus the selected provider's fixed authorization host: Chromium also checks the external destination of a form's 303 redirect. The exception is restricted to the three direct OAuth `/start` paths in both the route response and Next.js/Netlify headers. Other pages retain their original policies. No database migration or credential rotation is required for this fix.

Invitation GET is read-only. Consent POST revalidates the 30-minute invitation and creates a 15-minute browser-bound state/PKCE flow and HttpOnly, Secure production cookie (`SameSite=Lax`, `/api/oauth`). Only a successful callback consumes the invitation. Starting another flow invalidates the previous state. After deploying the consent-page fix, generate a fresh Connect link and reload the page rather than submitting an already-open page with the old headers.

The optional real-browser regression uses isolated temporary Chrome profiles and localhost fixtures only:

```sh
UGC_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm test
```

It reproduces the old Origin failure, checks Chromium's CSP redirect block, and confirms that the fixed native form reaches a local stand-in for the provider. It never connects a live account or contacts Google/Meta.

## Callback diagnostics

A failed callback now displays a random reference ID. In Netlify, open the project's **Logs → Functions** (or the deployed Next.js server function's logs) and find `oauth_callback_failed` with that reference. The structured event contains only a fixed failure stage/reason, allow-listed provider HTTP/error codes, database SQLSTATE/PostgREST codes, required-scope booleans and a channel count. It never includes callback URLs, authorization codes, state values/hashes, cookies, account/channel identities, token payloads, encryption material, database documents, raw errors or stack traces.

- `browser_cookie` / `flow_validation`: use the same browser and canonical HTTPS domain; request a fresh invitation if state expired or another flow invalidated it.
- `google_token_exchange`: `invalid_client` indicates a mismatched Google client/secret; `invalid_grant` can indicate an expired/reused code or PKCE/redirect mismatch. Missing offline authorization has its own `offline_refresh_token_missing` reason. Keep the same OAuth encryption key across deploys.
- `google_scope_validation`: both read-only scope booleans must be true. Scope validation uses Google's token response, never the untrusted callback query.
- `google_channel_lookup`: `accessNotConfigured`/`SERVICE_DISABLED` requires enabling YouTube Data API v3 in the Google project owning the OAuth client. A Google consent screen alone does not prove this API is enabled.
- `google_handle_resolution` / `google_channel_match`: register the exact handle or immutable channel ID and authorize its owning channel/Brand Account. The callback can resolve an actual handle with `channels.list(forHandle=...)` when `snippet.customUrl` is missing or a legacy alias, but still requires that resolved ID in the authorized `mine=true` result. Display names alone are not accepted.
- `verifier_decryption` / `token_encryption`: check that `OAUTH_TOKEN_ENCRYPTION_KEY` is valid and unchanged; do not rotate it to troubleshoot.
- `dashboard_load` / `database_commit`: schema 5 is required. Codes identify missing/stale RPC signatures, permissions, uniqueness conflicts or optimistic workspace conflicts without printing SQL payloads. Do not rerun migrations or change permissions blindly; use the reported stage/reason to determine the remedy.

The handle-resolution fix requires no new Google scopes, Netlify variables or SQL migration. `APP_URL` must remain `https://creatorhub.h2adigital.com`, and the Google Web client's authorized callback must exactly match `https://creatorhub.h2adigital.com/api/oauth/youtube/callback`. The generic error shown by older releases cannot identify which production stage failed retrospectively; capture the new reference after a fresh manual deployment/connection attempt if it persists.
