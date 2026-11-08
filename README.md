# Creator Ledger

Private UGC operations dashboard for multiple apps. Next.js App Router, React, TypeScript, Supabase PostgreSQL/Auth, and a replaceable Zernio TikTok adapter. No public signup, subscriptions, or payment processing.

## Run locally

Node 22.15+ is required (see `.nvmrc`).

```sh
npm ci
npm run dev
```

Visit `http://localhost:3000`. Without dashboard credentials this shows setup instructions. Choose **Explore the local preview** (`/?preview=1`) for an isolated sample workspace. Preview mutations live only in component memory and reset on refresh. Preview never calls a provider or your database, even if live credentials exist. It contains sample evidence decisions and does not claim those views are real.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests cover payout arithmetic, rule versioning, publication-month boundaries, eligibility, immutable payouts, corrections, mocked Zernio contracts, and the migration against embedded PostgreSQL. Migration tests also exercise populated insert/update and append-only paths, atomic rollback, actual RLS caller identities, Storage policies, and both Supabase automatic-grant and opt-in privilege profiles. An optional native PostgreSQL test is enabled by `UGC_TEST_PG_SOCKET` (and optionally `UGC_TEST_PG_PORT`); point it only at a disposable local cluster. It creates and drops its own database and leaves test roles in that cluster. Embedded tests omit Supabase-specific extensions and substitute Auth/Storage tables; a fresh Supabase project is still required to validate those managed services. Browser visual testing and a live OAuth/API pilot remain setup steps; neither can be inferred from mocked tests.

## What is implemented

- App switcher and aggregate overview; apps, campaigns, creators, date-bounded assignments, social accounts and account-to-campaign routing.
- Post discovery, timestamped append-only snapshots, imported observations, organic eligibility review and ambiguous/missing-data queues.
- Configurable versioned app → campaign → creator/app → creator/campaign compensation. Flat or progressive CPM, fixed qualifying payments, tracking windows, app/creator monthly caps and optional bonus approval.
- Publication-month statements, partial bonus approvals/rejections, cap allocation to posts/campaigns, finalization, external-payment records, exports and separately approved linked corrections/recoveries.
- Zernio TikTok connection, disconnect, scheduled discovery and public metrics. Server-held API keys, one-use connection tickets, authorization verification, a free-tier connection guard, job leases and backoff.
- Instagram, YouTube and Facebook are supported throughout data entry, accounting and CSV imports. **Their automated adapters are not implemented in this initial TikTok pilot.** Facebook is excluded from Versel's bonus by default.

## Upgrade an existing live project

See [the detailed tracking upgrade notes](docs/tracking-upgrade.md) for collection states, diagnostics, and evidence requirements.

**Do not rerun or edit `202611070001_ugc.sql`.** The existing TikTok connection, posts, and snapshot history must remain in place.

1. Stop the scheduled worker and the old application process while migrating. Keep your usual database backup available.
2. In Supabase SQL Editor, as `postgres`, run **only** `supabase/migrations/202611080001_tracking_and_new_york.sql`, in full, once. Do not run test fixtures against Supabase.
3. This transaction adds tracking/evidence/diagnostic columns, changes monthly protection to New York, and invalidates draft bonus approvals. It does not delete records, reset OAuth links, rewrite finalized amounts, or start Cron jobs. It **aborts and rolls back** if converting months would move an existing statement or merge conflicting policies. If it aborts, preserve the database and review the affected payout transition rather than deleting/recreating records.
4. Deploy/restart this updated application and resume the existing five-minute worker schedule. The app checks schema version 2 before loading live data; it will request this incremental migration when the old schema is detected. Do not run an old app process against the upgraded database.
5. Invoke one worker run and inspect its `diagnostics` response and Needs attention. Historical imports will remain reviewable; no seven-day history is manufactured. Existing accepted posts without structured evidence must be re-reviewed before a draft can finalize.

## Dedicated Supabase setup

1. Create a **new free project**. Do not reuse the imported app's Supabase project. No deployment or paid account has been created by this implementation.
2. For a genuinely new database only, run `supabase/migrations/202611070001_ugc.sql` once, followed by `supabase/migrations/202611080001_tracking_and_new_york.sql` once. Run the complete file as the SQL Editor’s `postgres` role; it is a one-time initial migration wrapped in a transaction. It creates normalized tables, private job/connection tables, RLS policies, server-only transactional RPCs, indexes and initial Versel defaults. It installs `pg_cron` in `pg_catalog` and `pg_net` in `extensions`; enable Cron/pg_net in Integrations first if your project requires that. `pgcrypto` is not required because UUID generation uses PostgreSQL’s built-in function.
3. In Authentication settings disable **Allow new users to sign up**. Create the single administrator with a strong password through the Supabase dashboard (email confirmed). No client service-role key is needed or allowed.
4. Add that user's UUID in SQL Editor:

   ```sql
   insert into public.admin_users(id) values ('ADMIN_AUTH_USER_UUID');
   ```

5. Copy `.env.example` to a separate temporary file, fill it in, and merge the dashboard values into `.env.local`. **Do not overwrite existing local secrets blindly.** Set `ADMIN_EMAIL` to that exact user's email. Set the new project's URL and publishable key; put its secret/service-role key in `SUPABASE_SECRET_KEY`. Keys must belong to the same dedicated project. Never put secret keys under `NEXT_PUBLIC_` or commit `.env.local`.
6. Set `APP_URL` to the exact browser origin (`http://localhost:3000` locally). Production needs a stable HTTPS origin. Configure the Supabase Site URL for that origin. Restart Next.js after changing environment variables.
7. Sign in and create your first real creator. Add a campaign assignment, register the TikTok username, and add a routing interval inside that assignment **before connecting**, covering intended publication dates. Rules are locked from the original publication time, not discovery time.

Auth checks both the configured email and the allowlisted Auth UUID on every protected API. Browser sessions use Supabase cookies; The root proxy refreshes cookies before server rendering; protected API requests also refresh sessions. Revoked sessions must sign in again. Dashboard data and RPCs require the server's secret key. There are no authenticated browser write policies on financial tables.

## Free Zernio TikTok pilot

Read [`docs/zernio-verification.md`](docs/zernio-verification.md) first. Current documentation includes analytics on its usage-based free allowance; older legacy plans can still return an analytics add-on gate.

1. Create the new Zernio account using its **two-account, no-card allowance**. Do not enter a card or buy an analytics add-on. Generate an API key and set only `ZERNIO_API_KEY` on the server.
2. Set the stable public `APP_URL` for creator authorization. Zernio's own OAuth app handles TikTok consent; this dashboard does not require a separate TikTok developer app. For a local-only test, verify whether Zernio accepts your local redirect or use your approved HTTPS development origin.
3. In Social accounts, click **Connect TikTok**, then copy the private authorization link to give to the creator or open it yourself for a company-owned account. Zernio creates a profile and supplies its OAuth URL. The intended creator must sign in to the matching TikTok account and accept the required permissions. The callback checks ticket expiry, remote account ID, remote profile, active state and the registered username before allowing tracking.
4. The callback confirms success without granting dashboard access and queues sync. Refresh Social accounts afterward. Configure the worker below, or manually invoke it with the server-only cron secret for local testing. **Sync** in the UI queues work; it does not run a long provider fetch inside a browser request.
5. Before using compensation with a real creator, publish a test video **directly in TikTok**, confirm automatic discovery and its native ID, confirm a nonzero counter and provider freshness timestamp, wait for a second changed counter, and confirm it creates a separate snapshot without duplicating the post. Test revocation/reconnection and disconnect/replacement while remaining within the allowance. No live pilot has been performed yet.

Provider requests are confined to profiles, accounts, OAuth connect, external post sync and analytics. No publishing, advertising, checkout, paid-plan or billing mutation endpoint is called. Zernio's TikTok consent can still request posting scopes that its own connection product always includes; the dashboard does not exercise those permissions.

## Background worker

`POST /api/internal/jobs` requires `Authorization: Bearer CRON_SECRET` and leases one account job. It enqueues accounts due at least hourly. Discovery runs each sync; counters are sampled daily, with hourly attempts during the last six eligibility hours and one closing reading. Daily snapshots retain the original provider freshness, even when a cached counter has not changed. Repeated cached closing readings are diagnosed without adding duplicate snapshots; hourly polling continues within the bounded grace period. Missing/stale counters are exceptions even when the HTTP request succeeds. A job has a 45-second provider budget within a 60-second route, a 3-minute lease and exponential backoff. At most 40 analytics pages (4,000 posts) are read per account; exceeding the budget is flagged rather than silently reporting complete history. This is sufficient for the two-account pilot but must become a cursor-based incremental worker before large-scale backfills.

For development, call the endpoint with a secret read from your local environment, keeping it out of shell history/logs. Use a scheduled external HTTP caller or Supabase Cron in production. Nothing is scheduled automatically by the migration.

For Supabase Cron, create these two secrets **through the Vault UI**, not in source control:

- `ugc_worker_url`: `https://YOUR_APPROVED_HOST/api/internal/jobs`
- `ugc_cron_secret`: the exact `CRON_SECRET` on that host.

Then run in SQL Editor:

```sql
select cron.schedule('ugc-worker-every-five-minutes', '*/5 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='ugc_worker_url'),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='ugc_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
```

The deployed host must support this execution duration and public inbound HTTP. Review actual free-host limits before choosing hosting. No paid hosting was provisioned. Check `cron.job_run_details`, `net._http_response`, dashboard sync history and accounts' last-success times. A successful Cron enqueue alone does not prove the HTTP worker succeeded. Free project pauses and host outages can interrupt collection. The attention queue flags accounts older than 24 hours; there is no email alert delivery in this MVP.

A canceled/expired OAuth grant records an error and cannot collect new metrics until reconnected. Past observations stay available locally. A provider timeout or missing counter is never converted to zero. Unknown provider freshness is explicit. Per-post collection status is separate from eligibility: active, closing, complete, or review. Closing follow-up lasts at most 24 elapsed hours after the deadline and requires a provider measurement timestamp at/after the deadline, no more than two hours behind collection, before collection completes. A successful request or a collection timestamp alone cannot close the window. Completion does not establish an exact cutoff or organic attribution. Polling can retain cached counts; it cannot reconstruct unseen traffic at an exact timestamp.

## Compensation behavior

- Currency is USD; publication months and month boundaries use America/New_York. Tracking windows are elapsed hours (`days × 24`), including across daylight saving changes.
- Rules use replacement patches for each level: omitted keys inherit from the next level down, while `0`, empty payment arrays and `null` caps are explicit values. The order is app, campaign, creator/app, creator/campaign, so a creator/app preference takes precedence over a campaign preference. A new version never mutates an older version.
- Fixed payment and window changes can start during a month for future posts. CPM rates, included platforms, approval requirements and monthly caps start next calendar month or later. Existing posts keep resolved rules and source version IDs. No backdating is allowed. Campaign caps are disallowed; caps belong to app or creator/app. Conflicting schedules across one app/creator's simultaneous campaigns are rejected.
- One creator/app/publication-month pool combines eligible views, applies progressive tiers once, gives fixed payments priority, and applies one cap. Remainder allocation reconciles post and campaign amounts to the cent. Cross-posts on different platforms are distinct platform posts and intentionally contribute their platform views; this does not claim unique audience measurement.
- Versel: $10 for each TikTok post at 1,000 accepted organic views inside 7 days. Bonus: first 100k eligible combined TikTok/Instagram/YouTube views at $1.50 CPM; next 400k at $0.50; above 500k at $0.25. Bonus is discretionary and held until explicitly approved. Monthly total cap is $3,000.
- Public counters and imports are uncertain observations, **not verified organic totals**. Review after the window closes, enter the evidence-backed eligible organic total, cite an auditable analytics export/reference, confirm organic attribution and the exact source window, and accept or exclude. The evidence start/end must exactly match publication and deadline. Calculations then update automatically. Accepted totals cannot exceed recorded observations; add supporting analytics evidence first if necessary. An in-window snapshot can prove a lower bound, not the exact final window total. There is no automatic fraud/organic classifier. Draft statements are created automatically. Clearly labeled provisional estimates use only counters observed inside the window with an in-window provider timestamp; they never become payable without evidence review. Post-deadline lifetime counts are excluded from these estimates. Provisional estimates include potential discretionary bonuses and the existing cap, not approval or payment authorization.
- Draft changes invalidate prior bonus approval. Finalization requires the next month, all window deadlines passed, all posts resolved, no unassigned creator posts in that month, and a bonus approval/rejection when required. An ambiguous cross-app post conservatively blocks that creator's month until assigned.
- Finalized totals are immutable; external payments must exactly match the finalized payable. Repeating the same payment reference is idempotent. No payment is initiated by the dashboard. Caps do not carry over unused/excluded money.
- Corrections create a separate pending ledger item. Recalculate the original pool with corrected views and the original cap; preserve prior rejected bonus dollars. Approve/reject the signed delta separately, then record an external payment or recovery reference. Approved corrections are included in later correction calculations, preventing repeated recovery/payment. They never rewrite the original paid statement. A negative adjustment is a recovery to arrange externally, not an automatic deduction from a future creator payment.

## CSV imports and evidence

Posts & performance → Import CSV supplies templates and reference UUIDs. Import posts first, then observations. Required post columns: `account_id,platform_post_id,url,published_at`; optional: `caption,campaign_id`. Without campaign ID, date-based routing applies. Required observation columns: `post_id,views,metric,observed_at`; optional: `evidence`. Metric is `public_views` or `organic_views`. Use timezone-bearing ISO dates. Manual timestamp fields also require ISO 8601 with Z or an explicit offset; they never infer a creator’s timezone from the administrator’s browser. Dates and report timestamps display America/New_York with daylight saving handled automatically. Imports validate atomically, reject invalid/duplicate cross-account post ownership, and do not overwrite snapshots or accept eligibility automatically.

Evidence is currently an administrator-provided URL/reference or note; there is no file-upload UI. A private Supabase bucket is reserved for future uploads. Keep evidence in an access-controlled company location and record its reporting cutoff and treatment of paid traffic. Decide a documented retention schedule before collecting creator data. The initial migration has no automatic purge job. Provider data-retention/deletion obligations and creator consent should be checked against the actual Zernio agreement before production; local record retention does not override those terms. Direct platform adapters will need their own retention/refresh/deletion rules.

## Code structure

```text
src/app/                     Server entry, administrator and job APIs
src/components/dashboard/    Responsive dashboard, forms, rules editor
src/domain/                  Pure command validation and compensation ledger
src/services/tracking/       Provider contract, Zernio adapter, synchronization
src/repositories/            Transactional Supabase persistence
src/lib/server/              Server configuration, Auth and HTTP helpers
supabase/migrations/         Schema, RLS, queue and RPCs
 tests/                      Domain, provider and embedded database tests
```

The imported app's App Router/TypeScript/Tailwind structure and path aliases remain. Marketing pages, public contact/email routes and marketing analytics were removed from the active application. Credentials in the original `.env.local` were left untouched. Providers normalize posts and cumulative metrics; the domain and compensation UI do not depend on Zernio response shapes. The first version uses one optimistic workspace revision and normalized table upserts for a single administrator. It loads the small pilot workspace in one request; move to scoped queries, incremental transactions and snapshot pagination before a long-running 10-creator production rollout.

## Remaining live prerequisites

A dedicated Supabase project, administrator account/email, a new free Zernio API key, an approved HTTPS host and a scheduled worker. None were available during implementation. Configure them only when ready; do not share secrets in chat. No service was purchased or deployed. Passing local tests does not establish provider entitlement, organic verification, historical API completeness or production reliability.
