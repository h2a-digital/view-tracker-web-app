# Initial migration review — November 7, 2026

Reviewed `supabase/migrations/202611070001_ugc.sql` before first application to a dedicated Supabase project. No hosted project was modified.

The original `INSERT ... SELECT id, name, ... FROM jsonb_populate_recordset(null::public.creators, ...)` syntax is valid PostgreSQL: the composite table type provides named output columns. An alias is optional when those names are unambiguous. The regression tests execute the original form with an empty search path. The migration now uses separate target and `src.column` lists with `AS src` for clarity; this is not a workaround for a PostgreSQL syntax error.

Changes made during review:

- Wrapped the complete migration in a transaction. Run the entire file once, as `postgres` in SQL Editor. It is not a rerunnable reset script.
- Created the `extensions` schema if needed; installed `pg_cron` in its required `pg_catalog` schema and `pg_net` in `extensions`. Removed unnecessary `pgcrypto` installation; `gen_random_uuid()` is built in.
- Removed all inherited/default table privileges from `PUBLIC`, `anon`, and `authenticated` on this application's tables, including `admin_users`. Regranted only authenticated SELECT, subject to RLS. This also removes TRUNCATE, which RLS does not filter.
- Explicitly revoked `is_admin()` execution from `PUBLIC`, `anon`, and `authenticated`, then granted it only to `authenticated`. Supabase can give roles direct default grants, so revoking from PUBLIC alone was insufficient. Server RPCs remain callable only by `service_role` (and privileged database owners), with fixed empty search paths. Private tables remain outside browser roles' schema access.
- Rejected null revision arguments, non-object documents, and missing/non-array dashboard collections. Valid writes retain the revision row lock, immutable evidence paths, and transactional rollback.
- Required a non-null exact payment amount in the paid-statement CHECK constraint. PostgreSQL accepts NULL CHECK results, so equality alone did not require an amount.
- Verified the private evidence bucket and administrator-only read/insert policies. Managed Storage grants and policies outside this bucket are left untouched.
- Verified initial Versel settings against the domain defaults: 7 days; $10 per qualifying TikTok post at 1,000 eligible views; $1.50 / $0.50 / $0.25 progressive CPM at 100k / 500k; manual bonus approval; $3,000 cap; TikTok, Instagram and YouTube bonus platforms, excluding Facebook. Seed UTC effective date remains January 1, 2026. No creators, connected accounts, payout statements or Cron jobs are seeded.

Database verification covers every populated dashboard collection, replay/updating mutable records, preserving append-only evidence, late-write rollback, stale/null revisions, malformed documents, RLS identity checks, grants, evidence isolation, queue leases/backoff, connection tickets, and the exact Versel seed. Both broad automatic Supabase grants and explicit opt-in permissions are simulated.

The migration's core SQL also passed on native PostgreSQL 17.7, including both INSERT branches, unchanged finalized records on replay, the original unaliased SELECT and role privileges. Local tests substitute Auth/Storage schemas and omit the two unavailable managed extensions. They do not prove extension installation, Supabase's managed service behavior, or scheduling on the user's hosted project. Those installation statements were checked against the official documentation below; do not drop/recreate existing managed extensions to silence a schema warning.

Official references:

- [PostgreSQL JSON recordset functions](https://www.postgresql.org/docs/17/functions-json.html)
- [Supabase default privileges and explicit grants](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase function permissions](https://supabase.com/docs/guides/database/functions)
- [Supabase Cron installation](https://supabase.com/docs/guides/cron/install)
- [pg_cron required extension schema](https://github.com/citusdata/pg_cron/blob/main/pg_cron.control)
- [Supabase pg_net installation](https://supabase.com/docs/guides/database/extensions/pg_net)
