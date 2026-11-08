-- MANUAL, AFTER deploying the current production app and applying 202611080002.
-- First create/update these secrets in Supabase Dashboard > Vault:
-- ugc_worker_url = https://YOUR-CANONICAL-DOMAIN/api/internal/jobs
-- ugc_cron_secret = exactly the production Netlify CRON_SECRET
-- No secret values should be pasted into this file or committed.
-- Supabase Cron (pg_cron) and pg_net must be enabled (original migration enables them).
-- This script deliberately does not make an immediate HTTP request.
begin;
do $$begin
 if to_regprocedure('private.dispatch_worker()') is null then raise exception 'Apply the production operations migration first';end if;
 if not exists(select 1 from vault.decrypted_secrets where name='ugc_worker_url' and decrypted_secret ~ '^https://[^/@?#[:space:]]+/api/internal/jobs$') then raise exception 'Configure ugc_worker_url in Vault';end if;
 if not exists(select 1 from vault.decrypted_secrets where name='ugc_cron_secret' and length(decrypted_secret)>=32 and decrypted_secret !~ '[[:space:]]') then raise exception 'Configure ugc_cron_secret in Vault';end if;
end;$$;
select cron.unschedule(jobid) from cron.job where jobname='ugc-worker-every-five-minutes';
select cron.schedule('ugc-worker-every-five-minutes','*/5 * * * *','select private.dispatch_worker();');
commit;
