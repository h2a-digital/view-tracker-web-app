# Production deployment: Netlify Free + existing Supabase + Supabase Cron

Prepared November 8, 2026 for Creator Hub. No deployment, purchase or live database change was performed. Reuse the existing Creator Ledger Supabase project, administrator, TikTok connection and historical data. No new database migration is needed for the Netlify conversion.

## 1. Create the Netlify project when ready

1. Select **Netlify Free**. Do not enable paid add-ons, upgrade or purchase credits without approval. Free currently supports this commercial pilot, with a shared 300-credit monthly allowance. Check whether other sites already consume that team's allowance.
2. Check Git repository ownership before import: Netlify's Free plan does not support direct Git integration with **organization-owned private repositories**. A supported personal private repository owned by the administrator can remain private. If the existing repository is organization-owned/private, stop and decide a supported deployment path; do not publish source code, move the repository or upgrade automatically. See [plan restrictions](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/).
3. In Netlify, **Add new project → Import an existing project**, authorize the Git provider and select the repository. Select the intended production branch. Before starting the deployment, configure environment variables as described below.
4. Use the repository root as base directory, build command **`npm run build`**, publish directory **`.next`**, and **Node.js 22**. These are declared in `netlify.toml`; `.nvmrc` and package engines also select Node 22. This is a full Next.js 16 application, not a static export or Netlify Drop upload. Do not add an SPA fallback rewrite. Netlify automatically installs its maintained Next.js/OpenNext adapter; no extra runtime plugin or replacement framework is required. See [Next.js on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/).
5. Choose a canonical HTTPS origin, e.g. `https://YOUR-SITE.netlify.app` or `https://hub.example.com`, and use exactly that origin for sign-in, APP_URL, connection links and Cron. Avoid individual deploy URLs and aliases that redirect. Configure a custom domain and SSL if desired; no purchased domain is required for the netlify.app address.
6. The production host must be externally reachable. Netlify's platform-level **private project** login blocks Supabase Cron and remote creators' OAuth callbacks. Publish the production project so the application can receive requests; the existing administrator authentication still protects dashboard data. This does not make the Git repository public, enable registration or grant creators dashboard access. Avoid a platform login wall or bot challenge on `/api/internal/jobs` and `/api/connections/callback`. See [project visibility](https://docs.netlify.com/manage/security/secure-access-to-sites/project-visibility/).
7. Disable unused branch deploys/previews or keep them free of live credentials. The application also blocks live access on preview/branch artifacts. Do not run a second scheduler on Netlify: Supabase Cron remains the sole scheduler.

The worker stays a normal synchronous Node.js API route. Netlify's current synchronous execution limit is **60 seconds**; native Netlify scheduled functions have a 30-second limit, so do not wrap this route as one. The provider deadline is 45 seconds from HTTP handler entry, including queue/database startup, leaving headroom for final save/health recording. The platform can still terminate a request during slow database access; the three-minute lease is then recovered by a later tick. See [function limits](https://docs.netlify.com/build/functions/configuration/).

## 2. Configure Netlify environment variables

In **Netlify → Project configuration → Environment variables**, add the following for **Production only**. Use the current Creator Ledger Supabase project and the current Free Zernio account. Redeploy production after any changes. The two `NEXT_PUBLIC_` values are intentionally public identifiers; every other variable is server-only and must never receive a `NEXT_PUBLIC_` prefix.

| Variable                               | Production value / source                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Existing project HTTPS API URL, from Supabase Connect / API settings; `https://YOUR-REF.supabase.co`                                                                                                      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Existing project's **publishable** key; legacy anon key also works via `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead                                                                                            |
| `SUPABASE_SECRET_KEY`                  | Existing project's **secret** key; legacy service-role key also works via `SUPABASE_SERVICE_ROLE_KEY` instead. Server only; never use this as the public key                                              |
| `ADMIN_EMAIL`                          | Exact authorized existing Supabase Auth user's email; this user's UUID must already be in `public.admin_users`                                                                                            |
| `APP_URL`                              | Canonical HTTPS origin, e.g. `https://ledger.example.com`, no path/query/credentials; use no trailing slash for consistency                                                                               |
| `ZERNIO_API_KEY`                       | Existing Zernio API key. Server only; keep the Free plan and existing TikTok connection                                                                                                                   |
| `CRON_SECRET`                          | Random token, at least 32 characters, no whitespace. Prefer 64 hexadecimal characters from a password manager or `openssl rand -hex 32`. Server only; exact same value goes in Vault as `ugc_cron_secret` |

These are the seven application variables. For an explicit Node.js 22 function runtime pin, also set the non-secret Netlify build setting **`AWS_LAMBDA_JS_RUNTIME=nodejs22.x`** in the UI (Builds scope); Netlify does not read that setting from `netlify.toml`. The default runtime normally follows the build Node version, but the explicit pin avoids ambiguity. See [Node function runtime selection](https://docs.netlify.com/build/functions/configuration/#nodejs-version-for-runtime). Use **Production** context values, with runtime **Functions** scope included (or All scopes if that is what your plan offers). The two public Supabase values must also be available to **Builds**. Server values may use Builds + Functions / All scopes on Production only to support adapter/runtime propagation; server-only names are never placed in client configuration. Values stored only in `netlify.toml` are not serverless runtime variables. Mark secrets as such wherever Netlify offers that setting. See [environment variables and functions](https://docs.netlify.com/build/functions/environment-variables/).

Do not manually set `CONTEXT`, `NETLIFY`, `NODE_ENV` or `APP_DEPLOYMENT_ENV`. Netlify provides build context; Next.js embeds only the non-secret deployment classification into the artifact so the serverless runtime and auth proxy retain preview isolation even if build variables are absent there. A preview artifact or preview runtime context always blocks live service access. Standalone production builds also enforce secure cookies, HTTPS configuration and disabled demo mode. Local `npm run dev` retains the isolated sample preview.

No database password, TikTok app secret or new OAuth client is required. Do not add secrets to Next.js `env`, `NEXT_PUBLIC_*`, committed configuration, URL parameters or chat. `next.config.ts` embeds only the deployment classification, never credentials. Redeploy after changing variables. Leave `.env.local` uncommitted for local development.

## 3. Prepare the existing Supabase project

1. Keep the current Auth user and `public.admin_users` allowlist row. In **Authentication → URL Configuration**, set Site URL to the canonical production origin. Password sign-in uses server cookies, not an Auth redirect; there is no Supabase OAuth callback to register. Do not add wildcard preview redirects. Localhost may remain an explicit development redirect if you need it.
2. In **Authentication → Sign In / Providers**, turn off **Allow new users to sign up** and unused sign-in providers. Keep the existing administrator's email/password login. No registration endpoint or creator dashboard access exists. Admin access requires both the configured email and the UUID allowlist row; a valid session alone is insufficient.
3. In Data API settings, keep `private`, `vault`, `net` and `cron` **out of exposed schemas**. Keep the existing application RLS enabled. Browser users can only read allowed app data under the existing admin policies; writes and operational RPCs are restricted to the server service role. Do not grant custom RPCs access to operational secrets or return Vault/pg_net request headers.
4. Stop any local worker/old application process during the migration/deployment cutover. There is no Cron schedule yet in the local pilot. If you have since created one, temporarily deactivate that named schedule.
5. Check the existing database version using this **read-only** SQL:

   ```sql
   select public.read_dashboard()->>'schemaVersion' as schema_version;
   ```

   If it is **3**, skip migrations entirely. If it is **2**, the previously prepared [`202611080002_production_operations.sql`](../supabase/migrations/202611080002_production_operations.sql) still needs to be applied **once**, manually, before this version can operate. Keep your usual backup available. This is the earlier operations upgrade, not a new Netlify migration. Do not rerun it if version 3 is present, rerun prior migrations, reset the project or delete records. If the version is unexpected, investigate before deployment.

6. The operations upgrade only adds operational metadata and fenced job functions. It preserves accounts, snapshots and financial records, does not create a schedule, and does not contact any host. This Netlify change adds no migration and leaves the existing safe migration files unchanged.
7. Deploy the new production app from Netlify after setting its environment. Open the canonical domain and sign in with the same admin. Confirm the existing app, creator/test account and imported videos are present. Sign-out must return to the sign-in screen. An unauthenticated request to `/api/dashboard` or `/api/operations` must return 401; a POST to `/api/internal/jobs` without the exact bearer secret must return 401. A browser GET to the worker is not a valid invocation.

No fresh seed, duplicate Versel app, new administrator account or TikTok reconnection is needed just to move hosts. Do not keep the previous local code running against this upgraded database; pull this version locally if you continue local testing.

## 4. Zernio production authorization

The current adapter sends `GET https://zernio.com/api/v1/connect/tiktok` with `profileId`, `redirect_url`, `scopes=analytics`, `expectedUsername`, and an optional reconnect account ID. `redirect_url` is built from `APP_URL`:

```
https://ledger.example.com/api/connections/callback?ticket=ONE_TIME_RANDOM_TICKET
```

The provider adds connection identifiers on return. The callback verifies the one-use ticket, expiry (30 minutes), registered account username, platform and provider profile before saving the connection. It grants no access to the dashboard. Creators do not need a Supabase account.

- With the standard Zernio connection product used here, Zernio operates the TikTok OAuth application. **Do not register the Creator Ledger callback as a native TikTok app redirect.** The app passes its HTTPS return URL to Zernio on each connection request; the current official endpoint does not document an additional dashboard callback registration for this flow. If your Zernio workspace has separately enabled redirect-domain restrictions/custom OAuth, allow the exact production origin/callback there, or use the standard flow. See [Connect URL API](https://docs.zernio.com/connect/get-connect-url) and [connecting accounts](https://docs.zernio.com/guides/connecting-accounts).
- Set the correct production `APP_URL` before generating a link. Old localhost links remain localhost links and expire; generate new links from the production dashboard for future creators. Use the authorization URL returned by the dashboard and let the creator complete the provider's final continue/return step.
- Keep the existing API key, profile and connected `@versel.app` account. Do not disconnect/reconnect a healthy account solely for deployment. No plan upgrade, paid analytics add-on or new connected account is initiated by deployment. The adapter retains its two-account guard.
- Discovery uses the existing external-post discovery/analytics adapter, not a list restricted to videos published through Zernio. Existing provider contract tests cover that behavior. Moving to HTTPS changes the return origin, not the provider endpoints or metrics semantics.

## 5. Enable Supabase Cron (manual, after production works)

In the same Supabase project, confirm **Cron / pg_cron** and **pg_net** are enabled. The original migration enabled them; do not rerun it. Enable a missing extension through Supabase's Extensions/Cron UI if needed. Vault is a managed Supabase facility.

In **Supabase → Vault**, create or update these two named secrets (avoid duplicate names):

| Vault secret name | Exact value                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ugc_worker_url`  | `https://ledger.example.com/api/internal/jobs` (replace with canonical production domain; not a redirect or localhost URL) |
| `ugc_cron_secret` | Exactly the Netlify Production `CRON_SECRET`, without `Bearer `                                                            |

Then run [`supabase/operations/configure-production-cron.sql`](../supabase/operations/configure-production-cron.sql) in SQL Editor. It checks prerequisites and replaces only the job named `ugc-worker-every-five-minutes`, leaving other jobs untouched. It is safe to rerun when changing configuration. It schedules:

```sql
select cron.schedule(
  'ugc-worker-every-five-minutes',
  '*/5 * * * *',
  'select private.dispatch_worker();'
);
```

Use the supplied full script for validation and duplicate prevention, not just this explanatory snippet. The security-definer dispatcher reads Vault and enqueues an asynchronous **POST** with `Authorization: Bearer <CRON_SECRET>`, JSON `{}`, `X-Worker-Source: supabase-cron`, and a 70-second HTTP timeout. Secret values are absent from the stored Cron command. At five-minute cadence this is about 288 HTTP calls/day; idle calls do not invoke Zernio. No Netlify scheduler or external caller is needed.

Cron scheduling time is irrelevant to payout boundaries: `*/5` runs at five-minute intervals and all eligibility instants are absolute UTC. Accounting remains America/New_York and seven-day eligibility remains exactly 168 hours.

**Supabase constraint:** pg_net queues decrypted request headers temporarily. Supabase documents that database roles able to use pg_net can read these headers; Vault does not hide them in transit through that queue. Supabase does not support changing the managed queue grants/RLS per project. Keep database login credentials restricted to trusted administrators, do not expose `net` through the Data API, and use a dedicated worker-only secret, never a Supabase service-role key in the HTTP header. Rotate it in both Netlify and Vault if needed. See [Supabase's pg_net credential notice](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net-ad6357).

Official references: [Supabase Cron](https://supabase.com/docs/guides/cron), [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net), [Vault](https://supabase.com/docs/guides/database/vault), [scheduled HTTP calls with Vault](https://supabase.com/docs/guides/functions/schedule-functions).

## 6. Verify unattended operation

Wait 5–10 minutes, then open **Needs attention → Automation health → Check now**. This only refreshes monitoring; it does not manually sync an account.

- An active five-minute schedule should appear and a recent invocation should say `supabase-cron`. `idle` / processed 0 is a healthy call when no account is due. Missing calls for 15 minutes display a warning.
- Recent Cron SQL executions show whether the dispatcher ran. **A successful Cron SQL execution only means pg_net queued HTTP; it does not prove a successful worker.** HTTP statuses/timeouts and authenticated worker outcomes are shown separately. HTTP 401 suggests a secret mismatch; 3xx a wrong/redirecting domain; 403/HTML often a Netlify visibility/protection layer; 5xx a setup, provider, database or runtime error. A running invocation older than its lease is flagged as unfinished.
- Connected TikTok accounts become due roughly hourly, and each combined sync discovers posts and samples eligible metrics automatically. One invocation handles one account, so two accounts may be processed on adjacent five-minute ticks. There are no separate metric jobs to create manually.
- **Recent synchronization runs** shows posts/counters fetched, snapshots saved, freshness, skipped observations, missing counters and provider errors. A completed HTTP call may have no new snapshots because data is cached, unchanged in the same sample bucket, or historical videos are already outside eligibility. The five old test videos alone cannot prove seven-day tracking; publish a new test video and watch its snapshots over the window.
- Normal metric sampling remains daily, hourly during the final six hours, and bounded hourly follow-up for stale closing readings up to 24 hours after the deadline. Provider timestamps govern freshness, not collection time alone. New posts trigger automated provisional calculations and draft statements.
- Run without local `npm run dev` or terminal worker calls. After initial deployment, no manual Sync is needed. Check the monitoring screen after the first two hourly account cycles. Keep external review/bonus/final payout approvals; automation never approves uncertain organic attribution.

Netlify function logs include a safe `ugc_worker` event with an invocation ID, source, outcome and status. Database/server-side details may require Supabase logs; no raw provider response, OAuth ticket or secret is written by the worker's structured logger. The admin health API exposes operational summaries, not Vault values, request headers or Cron command bodies. pg_net's own response history normally expires after about six hours; the application's heartbeats and request IDs persist. There are no email/push outage alerts in this MVP.

Optional read-only SQL checks, without printing secrets:

```sql
select jobname,schedule,active from cron.job
where jobname='ugc-worker-every-five-minutes';
select public.get_operations_status(); -- SQL Editor owner / server role only
```

## Operational limits and recovery

- Temporary provider/database errors return HTTP 503 and retain/requeue jobs with exponential backoff. Duplicate executions cannot lease the same active job, and stale leases cannot commit or finish a newer lease. Saving the workspace and completing the job is one transaction; optimistic revision conflicts roll back and retry. A timed-out function's 3-minute lease is recovered by a later tick. Five failed completed attempts end that job; a still-connected account whose sync is due can be enqueued again on a later tick. Actual revoked authorization needs reconnection; it is not repeatedly retried as if valid.
- The worker finishes its database calls before returning HTTP; it uses no persistent server memory or work after response. Request duration, provider throttling and database availability still matter. No system can reconstruct metrics missed during an outage. The MVP processes a pilot workspace in one transaction; large multi-creator backfills need paginated/incremental jobs before expansion.
- Supabase project pausing, hosting outages, provider entitlement changes and cached/missing analytics can interrupt collection. Review free-project operating constraints before relying on strict payroll deadlines. No uptime guarantee or historical reconstruction is implied.
- Public views remain provisional; Zernio does not verify organic-only seven-day totals. Missing cutoff/organic evidence remains an exception requiring review. The $10 TikTok rule, progressive CPM, $3,000 cap, New York accounting, manual bonus approval and finalized-statement immutability are unchanged. Other platform automated adapters are still outside this TikTok pilot.
- To pause tracking, deactivate the named job in Supabase Cron. To change domains, update Netlify `APP_URL`, redeploy, update Vault `ugc_worker_url`, and generate new future connection links. To rotate worker credentials, update Netlify `CRON_SECRET`, redeploy, then update Vault; a brief mismatch produces visible 401s and later ticks resume. Do not solve configuration failures by disabling endpoint authorization.

## 7. Monitor the Free plan credit budget

In the Netlify **team dashboard → Usage & billing**, inspect the current billing cycle's credits, compute, requests, bandwidth and production deployments. Check daily during the first week and weekly after the pattern stabilizes. Netlify sends usage emails/in-app notices at 50%, 75% and 100%; keep the owner email current and check those notices. Keep paid auto-recharge/add-ons disabled; Free uses a hard cap rather than automatically buying credits. Credits are shared by the team's projects, not reserved solely for Creator Hub. Netlify pauses projects when the allowance is exhausted, so credit headroom is part of tracking reliability. See [monitor credit usage](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/monitor-usage-for-credit-based-plans/).

Current new-account credit rates (verify in your own account if it is on a legacy plan):

| Meter                 | Rate                                            |
| --------------------- | ----------------------------------------------- |
| Free allowance        | 300 credits per month                           |
| Functions compute     | 10 credits per GB-hour; default 1 GB allocation |
| Production deployment | 15 credits each successful deploy               |
| Web requests          | 2 credits per 10,000                            |
| Bandwidth             | 20 credits per GB                               |

Sources: [credit accounting](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) and [function compute billing](https://docs.netlify.com/build/functions/usage-and-billing/). Preview deployments have no production-deployment charge, but their traffic and any running functions still consume resources. Avoid enabling Agent Runners, extra databases or other metered features for this app; PostgreSQL stays in the existing Supabase project.

At five-minute cadence expect **8,640 requests per 30-day month**, about **1.73 request credits**, before dashboard/static asset traffic. Most invocations are idle; one or two connected accounts are synchronized approximately hourly. Compute includes time awaiting APIs, not only active CPU.

Example only, not measured production performance: two accounts, 7,200 idle calls at 1 second and 1,440 active calls at 20 seconds, using 1 GB, consume about **100 compute credits/month**. Four production deployments add 60 credits. Add dashboard activity and bandwidth. If every invocation instead averaged 10 seconds, worker compute alone would be 240 credits, leaving insufficient room for those deployments and other usage. Measure actual idle/active duration in function logs, inspect billed allocation, and forecast the month from the observed totals. Do not promise permanently free operation from invocation counts alone.

Practical operating limits: aim to retain substantial headroom (for example keep your forecast below 200 credits); investigate rising duration, repeated failures or unexpected traffic before the cap. Use previews for development and deploy production deliberately. Do not slow the required five-minute schedule or disable authentication to hide usage problems. If the budget cannot support reliable tracking, pause onboarding and seek approval for a different hosting/billing plan. The application does not read the Netlify billing API and does not send budget/outage alerts itself.
