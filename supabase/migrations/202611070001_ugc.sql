-- Run in a NEW dedicated Supabase project. Never apply to the imported app's database.
-- Run the complete file as postgres (SQL Editor's default database role).
-- A failure rolls back the schema, seeds, and grants together. This initial migration runs once.
begin;
create schema if not exists extensions;
-- gen_random_uuid() is built into supported PostgreSQL versions; pgcrypto is unnecessary.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema public to authenticated, service_role;

create table public.admin_users(id uuid primary key references auth.users(id) on delete cascade);
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.admin_users where id=auth.uid())$$;
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;
alter table public.admin_users enable row level security;
revoke all on table public.admin_users from public, anon, authenticated;
grant select on public.admin_users to authenticated;
create policy own_admin on public.admin_users for select to authenticated using(id=auth.uid());
create table private.dashboard_revision(id boolean primary key default true check(id),revision bigint not null default 0);
insert into private.dashboard_revision(id) values(true);
create table public.apps(id uuid primary key,name text not null,slug text unique not null,color text not null,archived boolean not null default false);
create table public.campaigns(id uuid primary key,app_id uuid not null references public.apps(id),name text not null,status text not null check(status in ('active','paused','archived')));
create table public.creators(id uuid primary key,name text not null,email text not null default '',notes text not null default '');
create table public.memberships(id uuid primary key,creator_id uuid not null references public.creators(id),campaign_id uuid not null references public.campaigns(id),starts_at timestamptz not null,ends_at timestamptz,check(ends_at is null or ends_at>starts_at));
create table public.accounts(id uuid primary key,creator_id uuid not null references public.creators(id),platform text not null check(platform in ('tiktok','instagram','youtube','facebook')),username text not null,ownership text not null check(ownership in ('company','creator')),provider text not null check(provider in ('manual','zernio')),provider_account_id text,provider_profile_id text,status text not null,last_synced_at timestamptz,error text,unique(platform,username),unique(provider,provider_account_id));
create table public.mappings(id uuid primary key,account_id uuid not null references public.accounts(id),membership_id uuid not null references public.memberships(id),starts_at timestamptz not null,ends_at timestamptz,check(ends_at is null or ends_at>starts_at));
create table public.rule_versions(id uuid primary key,scope text not null check(scope in ('app','campaign','creator_app','creator_campaign')),app_id uuid not null references public.apps(id),campaign_id uuid references public.campaigns(id),creator_id uuid references public.creators(id),effective_at timestamptz not null,patch jsonb not null,created_at timestamptz not null);
create index rule_effective on public.rule_versions(app_id,effective_at);
create table public.posts(id uuid primary key,account_id uuid not null references public.accounts(id),platform text not null,platform_post_id text not null,url text not null,caption text not null,published_at timestamptz not null,campaign_id uuid references public.campaigns(id),app_id uuid references public.apps(id),creator_id uuid not null references public.creators(id),rules jsonb,rule_version_ids jsonb not null default '[]',deadline timestamptz,eligible_views bigint check(eligible_views>=0),eligibility_status text not null check(eligibility_status in ('tracking','review','accepted','excluded')),review_note text,accepted_by text,accepted_at timestamptz,deleted boolean not null default false,unique(platform,platform_post_id),unique(platform,url));
create index post_month on public.posts(app_id,creator_id,published_at);
create index post_deadline on public.posts(deadline) where eligibility_status='tracking';
create table public.snapshots(id uuid primary key,post_id uuid not null references public.posts(id),views bigint not null check(views>=0),metric text not null check(metric in ('public_views','organic_views')),source text not null check(source in ('manual','csv','api')),observed_at timestamptz not null,provider_updated_at timestamptz,evidence text,quality text not null check(quality in ('reported','uncertain')),provider text not null,unique(post_id,source,metric,observed_at,views));
create index snapshot_history on public.snapshots(post_id,observed_at);
create table public.statements(id uuid primary key,app_id uuid not null references public.apps(id),creator_id uuid not null references public.creators(id),month text not null check(month~'^\d{4}-(0[1-9]|1[0-2])$'),policy jsonb not null,status text not null check(status in ('draft','finalized','paid')),potential_bonus_cents bigint not null check(potential_bonus_cents>=0),approved_bonus_cents bigint check(approved_bonus_cents>=0),bonus_note text,fingerprint text not null,base_cents bigint not null check(base_cents>=0),payable_cents bigint not null check(payable_cents>=0),capped_cents bigint not null check(capped_cents>=0),lines jsonb not null,finalized_at timestamptz,paid_at timestamptz,payment_reference text,payment_amount_cents bigint,unique(app_id,creator_id,month),check(status='draft' or finalized_at is not null),check(status<>'paid' or (paid_at is not null and payment_reference is not null and payment_amount_cents is not null and payment_amount_cents=payable_cents)));
create table public.audit_events(id uuid primary key,action text not null,entity_id text not null,detail text not null,created_at timestamptz not null);
create table public.sync_runs(id uuid primary key,account_id uuid not null references public.accounts(id),status text not null,started_at timestamptz not null,finished_at timestamptz,message text not null);
create table private.connection_sessions(id uuid primary key default gen_random_uuid(),token_hash text unique not null,account_id uuid not null references public.accounts(id),profile_id text not null,expires_at timestamptz not null,consumed_at timestamptz);
create table private.jobs(id uuid primary key default gen_random_uuid(),account_id uuid not null references public.accounts(id),status text not null default 'queued',available_at timestamptz not null default now(),leased_until timestamptz,attempts integer not null default 0,last_error text,created_at timestamptz not null default now());
create unique index one_active_job on private.jobs(account_id) where status in ('queued','running');
create table public.adjustments(id uuid primary key,statement_id uuid not null references public.statements(id),post_id uuid not null references public.posts(id),eligible_views bigint not null check(eligible_views>=0),proposed_cents bigint not null,status text not null check(status in ('pending','approved','rejected','paid')),note text not null,created_at timestamptz not null,paid_at timestamptz,payment_reference text);

-- Persist only server-computed records. Optimistic revision plus a row lock serialize all writes.
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
  return jsonb_build_object('data',result,'revision',rev);
end;$$;
create or replace function public.commit_dashboard(expected_revision bigint, document jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
  rev bigint;
  entry record;
  insert_cols text;
  source_cols text;
  changes text;
begin
  select revision into rev from private.dashboard_revision where id=true for update;
  if expected_revision is null or rev is null or rev <> expected_revision then
    raise exception 'CONFLICT';
  end if;
  if jsonb_typeof(document) is distinct from 'object' then
    raise exception 'Dashboard document must be a JSON object' using errcode='22023';
  end if;
  for entry in select * from (values
    ('apps','apps'), ('campaigns','campaigns'), ('creators','creators'),
    ('memberships','memberships'), ('accounts','accounts'), ('mappings','mappings'),
    ('ruleVersions','rule_versions'), ('posts','posts'), ('snapshots','snapshots'),
    ('statements','statements'), ('audit','audit_events'), ('syncRuns','sync_runs'),
    ('adjustments','adjustments')
  ) as x(key,tablename) loop
    if jsonb_typeof(document->entry.key) is distinct from 'array' then
      raise exception 'Dashboard collection % must be a JSON array', entry.key using errcode='22023';
    end if;
    select
      string_agg(format('%I',column_name), ', ' order by ordinal_position),
      string_agg(format('src.%I',column_name), ', ' order by ordinal_position),
      string_agg(format('%I=excluded.%I',column_name,column_name), ', ' order by ordinal_position)
        filter(where column_name<>'id')
    into insert_cols, source_cols, changes
    from information_schema.columns
    where table_schema='public' and table_name=entry.tablename;

    -- Composite-typed jsonb_populate_recordset exposes named columns even without an alias.
    -- Qualify the source explicitly so INSERT and SELECT column lists cannot be confused.
    if entry.tablename in ('snapshots','audit_events','rule_versions') then
      execute format(
        'insert into public.%I (%s) select %s from pg_catalog.jsonb_populate_recordset(null::public.%I,$1) as src on conflict do nothing',
        entry.tablename, insert_cols, source_cols, entry.tablename
      ) using document->entry.key;
    else
      execute format(
        'insert into public.%I (%s) select %s from pg_catalog.jsonb_populate_recordset(null::public.%I,$1) as src on conflict(id) do update set %s',
        entry.tablename, insert_cols, source_cols, entry.tablename, changes
      ) using document->entry.key;
    end if;
  end loop;
  update private.dashboard_revision set revision=revision+1 where id=true;
end;
$$;

create or replace function public.lease_tracking_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.jobs;
begin
  update private.jobs set status='queued',leased_until=null where status='running' and leased_until<now();
  select * into job from private.jobs where status='queued' and available_at<=now() order by available_at for update skip locked limit 1;
  if not found then return null; end if;
  update private.jobs set status='running',attempts=attempts+1,leased_until=now()+interval '3 minutes' where id=job.id returning * into job;
  return to_jsonb(job);
end;$$;
create or replace function public.enqueue_tracking() returns void language sql security definer set search_path='' as $$
  insert into private.jobs(account_id) select id from public.accounts where provider='zernio' and status='connected' and (last_synced_at is null or last_synced_at<now()-interval '1 hour') on conflict do nothing;
$$;
create or replace function public.request_tracking(target_account uuid) returns void language sql security definer set search_path='' as $$insert into private.jobs(account_id) values(target_account) on conflict do nothing$$;
create or replace function public.finish_tracking_job(job_id uuid,success boolean,error_message text default null) returns void language plpgsql security definer set search_path='' as $$
begin
  update private.jobs set status=case when success then 'complete' when attempts>=5 then 'failed' else 'queued' end,available_at=now()+interval '5 minutes'*power(2,least(attempts,5)),leased_until=null,last_error=error_message where id=job_id;
end;$$;
create or replace function public.store_connection(hash text,target_account uuid,target_profile text,remote_count integer,reconnecting boolean) returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(845216);
  update private.connection_sessions set expires_at=now() where account_id=target_account and consumed_at is null and expires_at>now();
  if not reconnecting and remote_count+(select count(distinct account_id) from private.connection_sessions where consumed_at is null and expires_at>now())>=2 then raise exception 'Two connection links are already pending. Wait for them to expire.';end if;
  insert into private.connection_sessions(token_hash,account_id,profile_id,expires_at) values(hash,target_account,target_profile,now()+interval '30 minutes');
end;$$;
create or replace function public.read_connection(hash text) returns jsonb language sql security definer set search_path='' as $$select to_jsonb(c) from private.connection_sessions c where token_hash=hash and consumed_at is null and expires_at>now()$$;
create or replace function public.consume_connection(hash text) returns boolean language plpgsql security definer set search_path='' as $$declare changed integer;begin update private.connection_sessions set consumed_at=now() where token_hash=hash and consumed_at is null and expires_at>now();get diagnostics changed=row_count;return changed=1;end;$$;

create or replace function public.commit_connection(hash text,expected_revision bigint,document jsonb) returns void language plpgsql security definer set search_path='' as $$begin
  if not public.consume_connection(hash) then raise exception 'Connection ticket expired or consumed';end if;
  perform public.commit_dashboard(expected_revision,document);
end;$$;

-- An issued financial statement can only transition to paid, retaining all calculation data.
create or replace function private.protect_statement() returns trigger language plpgsql set search_path='' as $$begin
  if old.status in ('finalized','paid') and (to_jsonb(new)-array['status','paid_at','payment_reference','payment_amount_cents']) is distinct from (to_jsonb(old)-array['status','paid_at','payment_reference','payment_amount_cents']) then raise exception 'Finalized statements are immutable';end if;
  if old.status='paid' and new is distinct from old then raise exception 'Paid statements are immutable';end if;
  if old.status='finalized' and new.status not in ('finalized','paid') then raise exception 'Invalid settlement transition';end if;
  return new;
end;$$;
create trigger protect_statement before update on public.statements for each row execute function private.protect_statement();


create or replace function private.protect_post() returns trigger language plpgsql set search_path='' as $$begin
  if exists(select 1 from public.statements s where s.app_id=old.app_id and s.creator_id=old.creator_id and s.month=to_char(old.published_at at time zone 'Europe/Rome','YYYY-MM') and s.status in ('finalized','paid')) and new is distinct from old then raise exception 'Finalized post inputs are immutable; use a linked correction';end if;
  return new;
end;$$;
create trigger protect_post before update on public.posts for each row execute function private.protect_post();
create or replace function private.protect_adjustment() returns trigger language plpgsql set search_path='' as $$begin
  if (to_jsonb(new)-array['status','paid_at','payment_reference']) is distinct from (to_jsonb(old)-array['status','paid_at','payment_reference']) then raise exception 'Correction inputs are immutable';end if;
  if old.status in ('rejected','paid') and new is distinct from old then raise exception 'Settled corrections are immutable';end if;
  if old.status='approved' and new.status not in ('approved','paid') then raise exception 'Invalid correction transition';end if;
  return new;
end;$$;
create trigger protect_adjustment before update on public.adjustments for each row execute function private.protect_adjustment();

do $$declare name text;begin
  foreach name in array array['apps','campaigns','creators','memberships','accounts','mappings','rule_versions','posts','snapshots','statements','audit_events','sync_runs','adjustments'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('create policy admin_read on public.%I for select to authenticated using(public.is_admin())',name);
    -- RLS does not guard TRUNCATE; remove all automatic Supabase grants first.
    execute format('revoke all on table public.%I from public,anon,authenticated',name);
    execute format('grant select on table public.%I to authenticated',name);
  end loop;
end;$$;
do $$declare f record;begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('read_dashboard','commit_dashboard','lease_tracking_job','enqueue_tracking','request_tracking','finish_tracking_job','store_connection','read_connection','consume_connection','commit_connection') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end;$$;

insert into public.apps values('10000000-0000-4000-8000-000000000001','Versel','versel','#a78bfa',false);
insert into public.campaigns values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Creator partnerships','active');
insert into public.rule_versions values('30000000-0000-4000-8000-000000000001','app','10000000-0000-4000-8000-000000000001',null,null,'2026-01-01T00:00:00Z','{"windowDays":7,"fixedPayments":[{"platform":"tiktok","amount":"10","minimumViews":1000}],"cpmMode":"progressive","tiers":[{"upTo":100000,"cpm":"1.50"},{"upTo":500000,"cpm":"0.50"},{"upTo":null,"cpm":"0.25"}],"flatCpm":"1.50","bonusPlatforms":["tiktok","instagram","youtube"],"monthlyCap":"3000","bonusApproval":true}','2026-01-01T00:00:00Z');

insert into storage.buckets(id,name,public) values('ugc-evidence','ugc-evidence',false) on conflict do nothing;
create policy evidence_admin_read on storage.objects for select to authenticated using(bucket_id='ugc-evidence' and public.is_admin());
create policy evidence_admin_insert on storage.objects for insert to authenticated with check(bucket_id='ugc-evidence' and public.is_admin());
-- Configure Cron only AFTER setting the deployed URL and CRON_SECRET in Vault. See README.
commit;
