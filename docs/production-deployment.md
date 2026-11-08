# Production deployment: Vercel + existing Supabase + Supabase Cron

Prepared November 8, 2026. No deployment, subscription purchase, live SQL execution, account disconnection or data reset was performed. Keep the existing Creator Ledger Supabase project and Zernio account. The connected TikTok account and historical data remain in that database.

## 1. Choose the production domain and Vercel project

1. Import this Git repository into a Vercel project. Framework: **Next.js**. Root: repository root. Node.js: **22.x**. Install: `npm ci`. Build: `npm run build`. These settings are also declared in the repository. Do not add a Vercel Cron job: Supabase is the sole scheduler.
2. Use your company's existing commercial Vercel plan, or obtain approval before subscribing. Vercel [Hobby is limited to personal, non-commercial use](https://vercel.com/docs/plans/hobby); this company dashboard requires an appropriate commercial plan. No plan was purchased here.
3. Choose a stable canonical HTTPS domain, such as `https://ledger.example.com` or the project's stable production `https://YOUR-PROJECT.vercel.app` alias. Use the exact same origin for APP_URL, sign-in, connection links and Cron. Do not use an individual deployment/preview URL or an alias that redirects elsewhere. You cannot send dashboard mutations from a different origin.
4. Select a Vercel function region close to the existing Supabase database. The worker declares the Node.js runtime and a **60-second maximum duration**. Keep the project's function duration at least 60 seconds and Fluid Compute enabled. Provider calls share a 45-second budget; the job lease lasts 3 minutes. See [Vercel runtime limits](https://vercel.com/docs/functions/limitations) and [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
5. Keep Vercel previews protected and **do not supply production credentials to Preview environments**. This application rejects live access on `VERCEL_ENV=preview` even if keys were copied accidentally. The sample `/?preview=1` dashboard is local-only. Preview deployments display a sign-in surface but cannot access the live database or provider.
6. The production domain must permit inbound requests to `/api/internal/jobs` and `/api/connections/callback` without a Vercel login, bot challenge or redirect. Standard preview protection is compatible; blanket **production** Deployment Protection will block Cron and creators unless you configure appropriate exceptions. Let the application's admin authentication protect the dashboard. Do not put a Vercel bypass secret in OAuth URLs. See [Deployment Protection](https://vercel.com/docs/deployment-protection).

Do not deploy until the following production environment variables are ready. Importing this repository or committing changes does not require this agent to deploy it.

## 2. Configure Vercel environment variables

In **Vercel → Project → Settings → Environment Variables**, add the following for **Production only**. Use the current Creator Ledger Supabase project and the current Free Zernio account. Redeploy production after any changes. The two `NEXT_PUBLIC_` values are intentionally public identifiers; every other variable is server-only and must never receive a `NEXT_PUBLIC_` prefix.

| Variable                               | Production value / source                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Existing project HTTPS API URL, from Supabase Connect / API settings; `https://YOUR-REF.supabase.co`                                                                                                      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Existing project's **publishable** key; legacy anon key also works via `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead                                                                                            |
| `SUPABASE_SECRET_KEY`                  | Existing project's **secret** key; legacy service-role key also works via `SUPABASE_SERVICE_ROLE_KEY` instead. Server only; never use this as the public key                                              |
| `ADMIN_EMAIL`                          | Exact authorized existing Supabase Auth user's email; this user's UUID must already be in `public.admin_users`                                                                                            |
| `APP_URL`                              | Canonical HTTPS origin, e.g. `https://ledger.example.com`, no path/query/credentials; use no trailing slash for consistency                                                                               |
| `ZERNIO_API_KEY`                       | Existing Zernio API key. Server only; keep the Free plan and existing TikTok connection                                                                                                                   |
| `CRON_SECRET`                          | Random token, at least 32 characters, no whitespace. Prefer 64 hexadecimal characters from a password manager or `openssl rand -hex 32`. Server only; exact same value goes in Vault as `ugc_cron_secret` |

These are all required production variables. Vercel supplies `VERCEL`/`VERCEL_ENV`; do not override them. No database password, Supabase JWT signing secret, TikTok app secret, browser-held provider token or new OAuth client is required. Leave `.env.local` out of Git and keep it for local use. The committed `.env.example` contains no secrets. Secrets must not be pasted into chat, source files or URL query parameters.

## 3. Prepare the existing Supabase project

1. Keep the current Auth user and `public.admin_users` allowlist row. In **Authentication → URL Configuration**, set Site URL to the canonical production origin. Password sign-in uses server cookies, not an Auth redirect; there is no Supabase OAuth callback to register. Do not add wildcard preview redirects. Localhost may remain an explicit development redirect if you need it.
2. In **Authentication → Sign In / Providers**, turn off **Allow new users to sign up** and unused sign-in providers. Keep the existing administrator's email/password login. No registration endpoint or creator dashboard access exists. Admin access requires both the configured email and the UUID allowlist row; a valid session alone is insufficient.
3. In Data API settings, keep `private`, `vault`, `net` and `cron` **out of exposed schemas**. Keep the existing application RLS enabled. Browser users can only read allowed app data under the existing admin policies; writes and operational RPCs are restricted to the server service role. Do not grant custom RPCs access to operational secrets or return Vault/pg_net request headers.
4. Stop any local worker/old application process during the migration/deployment cutover. There is no Cron schedule yet in the local pilot. If you have since created one, temporarily deactivate that named schedule.
5. Use a current backup/export according to your project's backup facilities. In the existing project's SQL Editor, run **only** [`202611080002_production_operations.sql`](../supabase/migrations/202611080002_production_operations.sql). The previous New York/tracking migration must already be applied (as confirmed in this pilot). **Do not rerun either prior migration, reset the project or delete records.**
6. This transaction adds private operational tables, a lease token, fenced queue functions and schema version 3. It changes no compensation rules, statements, accounts, snapshots or OAuth connections. Existing financial immutability protections stay intact. It does not schedule Cron or make HTTP requests. The new app refuses live dashboard loads until schema version 3 is present; an old worker cannot finish a job without its lease token.
7. Deploy the new production app from Vercel after setting its environment. Open the canonical domain and sign in with the same admin. Confirm the existing app, creator/test account and imported videos are present. Sign-out must return to the sign-in screen. An unauthenticated request to `/api/dashboard` or `/api/operations` must return 401; a POST to `/api/internal/jobs` without the exact bearer secret must return 401. A browser GET to the worker is not a valid invocation.

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
| `ugc_cron_secret` | Exactly the Vercel Production `CRON_SECRET`, without `Bearer `                                                             |

Then run [`supabase/operations/configure-production-cron.sql`](../supabase/operations/configure-production-cron.sql) in SQL Editor. It checks prerequisites and replaces only the job named `ugc-worker-every-five-minutes`, leaving other jobs untouched. It is safe to rerun when changing configuration. It schedules:

```sql
select cron.schedule(
  'ugc-worker-every-five-minutes',
  '*/5 * * * *',
  'select private.dispatch_worker();'
);
```

Use the supplied full script for validation and duplicate prevention, not just this explanatory snippet. The security-definer dispatcher reads Vault and enqueues an asynchronous **POST** with `Authorization: Bearer <CRON_SECRET>`, JSON `{}`, `X-Worker-Source: supabase-cron`, and a 70-second HTTP timeout. Secret values are absent from the stored Cron command. At five-minute cadence this is about 288 HTTP calls/day; idle calls do not invoke Zernio. No Vercel Cron or external scheduler is needed.

Cron scheduling time is irrelevant to payout boundaries: `*/5` runs at five-minute intervals and all eligibility instants are absolute UTC. Accounting remains America/New_York and seven-day eligibility remains exactly 168 hours.

**Supabase constraint:** pg_net queues decrypted request headers temporarily. Supabase documents that database roles able to use pg_net can read these headers; Vault does not hide them in transit through that queue. Supabase does not support changing the managed queue grants/RLS per project. Keep database login credentials restricted to trusted administrators, do not expose `net` through the Data API, and use a dedicated worker-only secret, never a Supabase service-role key in the HTTP header. Rotate it in both Vercel and Vault if needed. See [Supabase's pg_net credential notice](https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net-ad6357).

Official references: [Supabase Cron](https://supabase.com/docs/guides/cron), [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net), [Vault](https://supabase.com/docs/guides/database/vault), [scheduled HTTP calls with Vault](https://supabase.com/docs/guides/functions/schedule-functions).

## 6. Verify unattended operation

Wait 5–10 minutes, then open **Needs attention → Automation health → Check now**. This only refreshes monitoring; it does not manually sync an account.

- An active five-minute schedule should appear and a recent invocation should say `supabase-cron`. `idle` / processed 0 is a healthy call when no account is due. Missing calls for 15 minutes display a warning.
- Recent Cron SQL executions show whether the dispatcher ran. **A successful Cron SQL execution only means pg_net queued HTTP; it does not prove a successful worker.** HTTP statuses/timeouts and authenticated worker outcomes are shown separately. HTTP 401 suggests a secret mismatch; 3xx a wrong/redirecting domain; 403/HTML often a Vercel protection layer; 5xx a setup, provider, database or runtime error. A running invocation older than its lease is flagged as unfinished.
- Connected TikTok accounts become due roughly hourly, and each combined sync discovers posts and samples eligible metrics automatically. One invocation handles one account, so two accounts may be processed on adjacent five-minute ticks. There are no separate metric jobs to create manually.
- **Recent synchronization runs** shows posts/counters fetched, snapshots saved, freshness, skipped observations, missing counters and provider errors. A completed HTTP call may have no new snapshots because data is cached, unchanged in the same sample bucket, or historical videos are already outside eligibility. The five old test videos alone cannot prove seven-day tracking; publish a new test video and watch its snapshots over the window.
- Normal metric sampling remains daily, hourly during the final six hours, and bounded hourly follow-up for stale closing readings up to 24 hours after the deadline. Provider timestamps govern freshness, not collection time alone. New posts trigger automated provisional calculations and draft statements.
- Run without local `npm run dev` or terminal worker calls. After initial deployment, no manual Sync is needed. Check the monitoring screen after the first two hourly account cycles. Keep external review/bonus/final payout approvals; automation never approves uncertain organic attribution.

Vercel Runtime Logs include a safe `ugc_worker` event with an invocation ID, source, outcome and status. Database/server-side details may require Supabase logs; no raw provider response, OAuth ticket or secret is written by the worker's structured logger. The admin health API exposes operational summaries, not Vault values, request headers or Cron command bodies. pg_net's own response history normally expires after about six hours; the application's heartbeats and request IDs persist. There are no email/push outage alerts in this MVP.

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
- To pause tracking, deactivate the named job in Supabase Cron. To change domains, update Vercel `APP_URL`, redeploy, update Vault `ugc_worker_url`, and generate new future connection links. To rotate worker credentials, update Vercel `CRON_SECRET`, redeploy, then update Vault; a brief mismatch produces visible 401s and later ticks resume. Do not solve configuration failures by disabling endpoint authorization.
