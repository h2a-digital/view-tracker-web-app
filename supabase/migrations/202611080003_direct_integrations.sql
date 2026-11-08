-- Safe incremental upgrade from schema 3. Never reset/reseed the live database.
-- Adds private encrypted OAuth storage, read-only provider metadata and batched-worker support.
-- No external requests, OAuth applications or Cron schedules are activated.
begin;
lock table private.dashboard_revision in exclusive mode;
do $$begin if (public.read_dashboard()->>'schemaVersion')::integer<>3 then raise exception 'Expected schema 3; apply earlier migrations once in order';end if;end;$$;
alter table public.accounts drop constraint accounts_provider_check;
alter table public.accounts add constraint accounts_provider_check check(provider in ('manual','zernio','direct'));
alter table public.accounts add column integration jsonb;
alter table public.accounts add constraint direct_platform check(provider<>'direct' or platform in ('youtube','instagram','facebook'));
alter table public.snapshots drop constraint snapshots_metric_check;
alter table public.snapshots add constraint snapshots_metric_check check(metric in ('public_views','organic_views','paid_views','uncertain_views'));
alter table public.snapshots add column provenance jsonb;
-- Daily reports can contain equal counts on different days collected at the same instant.
-- Retain the original uniqueness semantics for historical observations without provenance.
alter table public.snapshots drop constraint snapshots_post_id_source_metric_observed_at_views_key;
create unique index snapshot_observation_identity on public.snapshots(post_id,source,metric,observed_at,views,coalesce(provenance->>'metricName',''),coalesce(provenance->>'periodStart',''));
alter table private.worker_invocations drop constraint worker_invocations_processed_check;
alter table private.worker_invocations add constraint worker_invocations_processed_check check(processed between 0 and 8);
create table private.oauth_invites(hash text primary key,account_id uuid not null references public.accounts(id),platform text not null check(platform in ('youtube','instagram','facebook')),expires_at timestamptz not null default now()+interval '30 minutes',consumed_at timestamptz);
create table private.oauth_flows(state_hash text primary key,invite_hash text not null references private.oauth_invites(hash),browser_hash text not null,verifier text not null,expires_at timestamptz not null default now()+interval '15 minutes',consumed_at timestamptz);
create table private.oauth_credentials(account_id uuid primary key references public.accounts(id),encrypted_token text not null,version bigint not null default 1,updated_at timestamptz not null default now());
revoke all on private.oauth_invites,private.oauth_flows,private.oauth_credentials from public,anon,authenticated,service_role;

create function public.create_oauth_invite(hash text,target_account uuid,target_platform text) returns void language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.accounts where id=target_account and provider='direct' and platform=target_platform) then raise exception 'Invalid direct account';end if;
 update private.oauth_invites set consumed_at=now() where account_id=target_account and consumed_at is null;
 insert into private.oauth_invites(hash,account_id,platform) values(hash,target_account,target_platform);
end;$$;
create function public.read_oauth_invite(hash text) returns jsonb language sql security definer set search_path='' as $$select to_jsonb(i) from private.oauth_invites i where i.hash=$1 and consumed_at is null and expires_at>now()$$;
create function public.start_oauth_flow(invite_hash text,state_hash text,browser_hash text,encrypted_verifier text) returns void language plpgsql security definer set search_path='' as $$begin
 perform 1 from private.oauth_invites i where i.hash=invite_hash and i.consumed_at is null and i.expires_at>now() for update;
 if not found then raise exception 'Invitation expired';end if;
 -- One active browser flow per invitation; starting a new one invalidates the previous flow.
 update private.oauth_flows f set consumed_at=now() where f.invite_hash=start_oauth_flow.invite_hash and consumed_at is null;
 insert into private.oauth_flows(state_hash,invite_hash,browser_hash,verifier) values(state_hash,invite_hash,browser_hash,encrypted_verifier);
end;$$;
create function public.read_oauth_flow(hash text) returns jsonb language sql security definer set search_path='' as $$select to_jsonb(f)||jsonb_build_object('account_id',i.account_id,'platform',i.platform) from private.oauth_flows f join private.oauth_invites i on i.hash=f.invite_hash where f.state_hash=$1 and f.consumed_at is null and f.expires_at>now() and i.consumed_at is null and i.expires_at>now()$$;
create function public.commit_direct_connection(hash text,expected_browser_hash text,expected_revision bigint,document jsonb,encrypted_token text) returns void language plpgsql security definer set search_path='' as $$
declare target uuid; invite text;
begin
 select i.account_id,i.hash into target,invite from private.oauth_flows f join private.oauth_invites i on i.hash=f.invite_hash where f.state_hash=commit_direct_connection.hash and f.browser_hash=expected_browser_hash and f.consumed_at is null and f.expires_at>now() and i.consumed_at is null and i.expires_at>now() for update of i,f;
 if not found then raise exception 'OAuth flow expired, invalid or consumed';end if;
 if not exists(select 1 from jsonb_array_elements(document->'accounts') a where a->>'id'=target::text and a->>'provider'='direct' and a->>'status'='connected' and coalesce(a->>'provider_account_id','')<>'') then raise exception 'Missing verified account';end if;
 perform public.commit_dashboard(expected_revision,document);
 insert into private.oauth_credentials(account_id,encrypted_token) values(target,encrypted_token) on conflict(account_id) do update set encrypted_token=excluded.encrypted_token,version=private.oauth_credentials.version+1,updated_at=now();
 update private.oauth_invites set consumed_at=now() where private.oauth_invites.hash=invite;
 update private.oauth_flows set consumed_at=now() where state_hash=commit_direct_connection.hash;
 insert into private.jobs(account_id) values(target) on conflict do nothing;
end;$$;
create function public.read_direct_credentials(target_account uuid) returns jsonb language sql security definer set search_path='' as $$select to_jsonb(c) from private.oauth_credentials c where account_id=target_account$$;
create function public.write_direct_credentials(target_account uuid,encrypted_token text,expected_version bigint) returns boolean language plpgsql security definer set search_path='' as $$declare n integer;begin
 update private.oauth_credentials c set encrypted_token=write_direct_credentials.encrypted_token,version=version+1,updated_at=now() where account_id=target_account and version=expected_version;
 get diagnostics n=row_count;return n=1;
end;$$;
create function public.forget_direct_credentials(target_account uuid,expected_version bigint) returns void language sql security definer set search_path='' as $$delete from private.oauth_credentials where account_id=target_account and version=expected_version$$;
create function public.disconnect_direct_account(target_account uuid,expected_revision bigint,document jsonb) returns void language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from jsonb_array_elements(document->'accounts') a where a->>'id'=target_account::text and a->>'status'='disconnected' and a->>'provider'='direct') then raise exception 'Invalid disconnect document';end if;
 perform public.commit_dashboard(expected_revision,document);
 delete from private.oauth_credentials where account_id=target_account;
 update private.oauth_invites set consumed_at=now() where account_id=target_account and consumed_at is null;
 update private.jobs set status='cancelled',lease_token=null,leased_until=null where account_id=target_account and status in ('running','queued');
end;$$;

create or replace function public.enqueue_tracking() returns void language sql security definer set search_path='' as $$
 insert into private.jobs(account_id) select id from public.accounts where provider in ('zernio','direct') and status='connected'
 and (last_synced_at is null or last_synced_at<now()-interval '1 hour')
 and (integration->>'retryAfterAt' is null or (integration->>'retryAfterAt')::timestamptz<=now()) on conflict do nothing;
$$;
create or replace function public.finish_tracking_job(job_id uuid,success boolean,error_message text,expected_lease_token uuid) returns boolean language plpgsql security definer set search_path='' as $$declare changed integer;begin
 update private.jobs j set status=case when success then 'complete' when attempts>=5 then 'failed' else 'queued' end,
 available_at=greatest(now()+interval '5 minutes'*power(2,least(attempts,5)),coalesce((select (a.integration->>'retryAfterAt')::timestamptz from public.accounts a where a.id=j.account_id),now())),
 leased_until=null,lease_token=null,last_error=left(error_message,500)
 where id=job_id and status='running' and lease_token=expected_lease_token and leased_until>now();
 get diagnostics changed=row_count;return changed=1;
end;$$;
-- The workspace revision/transaction protections remain unchanged. New columns are
-- handled by the existing composite-record commit; secrets are never in its document.
create function private.check_direct_payout() returns trigger language plpgsql set search_path='' as $$begin
 if new.eligibility_status='accepted' and (tg_op='INSERT' or old.eligibility_status is distinct from new.eligibility_status or old.eligible_views is distinct from new.eligible_views)
 and exists(select 1 from public.accounts a where a.id=new.account_id and a.integration->>'payoutsBlocked'='true') then raise exception 'Provider policy approval required before eligible views can be accepted';end if;
 return new;
end;$$;
create trigger check_direct_payout before insert or update on public.posts for each row execute function private.check_direct_payout();
create function private.check_direct_finalization() returns trigger language plpgsql set search_path='' as $$begin
 if new.status='finalized' and (tg_op='INSERT' or old.status='draft') and exists(select 1 from public.posts p join public.accounts a on a.id=p.account_id where p.app_id=new.app_id and p.creator_id=new.creator_id and to_char(p.published_at at time zone 'America/New_York','YYYY-MM')=new.month and p.eligibility_status<>'excluded' and a.integration->>'payoutsBlocked'='true') then raise exception 'Provider policy approval required before finalization';end if;
 return new;
end;$$;
create trigger check_direct_finalization before insert or update on public.statements for each row execute function private.check_direct_finalization();
revoke all on function private.check_direct_payout(),private.check_direct_finalization() from public,anon,authenticated,service_role;
create or replace function public.read_dashboard() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb := '{}'::jsonb; entry record; rows jsonb; rev bigint;
begin
  select revision into rev from private.dashboard_revision where id=true for share;
  for entry in select * from (values ('apps','apps'),('campaigns','campaigns'),('creators','creators'),('memberships','memberships'),('accounts','accounts'),('mappings','mappings'),('ruleVersions','rule_versions'),('posts','posts'),('snapshots','snapshots'),('statements','statements'),('audit','audit_events'),('syncRuns','sync_runs'),('adjustments','adjustments')) as x(key,tablename) loop
    if entry.tablename='audit_events' then
      select coalesce(jsonb_agg(to_jsonb(t) order by created_at desc),'[]'::jsonb) into rows from (select * from public.audit_events order by created_at desc limit 1000) t;
    elsif entry.tablename='sync_runs' then
      select coalesce(jsonb_agg(to_jsonb(t) order by started_at desc),'[]'::jsonb) into rows from (select * from public.sync_runs order by started_at desc limit 200) t;
    else
    execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from public.%I t',entry.tablename) into rows;
    end if;
    result := result || jsonb_build_object(entry.key,rows);
  end loop;
  return jsonb_build_object('data',result,'revision',rev,'accountingTimezone','America/New_York','schemaVersion',4);
end;$$;

do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_oauth_invite','read_oauth_invite','start_oauth_flow','read_oauth_flow','commit_direct_connection','read_direct_credentials','write_direct_credentials','forget_direct_credentials','disconnect_direct_account','enqueue_tracking','finish_tracking_job','read_dashboard') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end;$$;
update private.dashboard_revision set revision=revision+1 where id=true;
notify pgrst,'reload schema';
commit;
