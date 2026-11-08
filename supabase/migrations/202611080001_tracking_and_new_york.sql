-- Incremental migration for an EXISTING Creator Ledger database. Run once as postgres.
-- No rows are deleted, no accounts disconnected, and the original migration is not rerun.
begin;
lock table private.dashboard_revision in exclusive mode;
lock table public.posts,public.statements in share row exclusive mode;
-- Refuse ambiguous regrouping rather than silently change a draft/finalized/paid payout.
do $$begin
 if exists(select 1 from public.statements s join public.posts p on p.app_id=s.app_id and p.creator_id=s.creator_id
   where (s.month=to_char(p.published_at at time zone 'Europe/Rome','YYYY-MM') or s.month=to_char(p.published_at at time zone 'America/New_York','YYYY-MM'))
     and to_char(p.published_at at time zone 'Europe/Rome','YYYY-MM')<>to_char(p.published_at at time zone 'America/New_York','YYYY-MM'))
 then raise exception 'Accounting timezone change affects existing statements. Migration rolled back. Review affected statements before converting; do not delete or rewrite finalized payouts.';end if;
 if exists(select 1 from public.posts where app_id is not null and rules is not null group by app_id,creator_id,to_char(published_at at time zone 'America/New_York','YYYY-MM')
 having count(distinct jsonb_build_array(rules->'cpmMode',rules->'tiers',rules->'flatCpm',rules->'bonusPlatforms',rules->'monthlyCap',rules->'bonusApproval'))>1)
 then raise exception 'New York month merges conflicting monthly compensation policies. Migration rolled back; resolve the policy transition first.';end if;
end;$$;
alter table public.posts add column tracking jsonb;
alter table public.posts add column review_evidence jsonb;
alter table public.sync_runs add column diagnostics jsonb;
alter table public.adjustments add column evidence jsonb;
alter table public.statements add column accounting_timezone text not null default 'America/New_York' check(accounting_timezone='America/New_York');
-- Old approvals must be reconsidered against the stronger evidence requirement.
update public.statements set approved_bonus_cents=null,bonus_note=null,fingerprint='' where status='draft';
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
  return jsonb_build_object('data',result,'revision',rev,'accountingTimezone','America/New_York','schemaVersion',2);
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


-- Keep accounting locks consistent with the application. Only tracking diagnostics may change on locked posts.
create or replace function private.protect_post() returns trigger language plpgsql set search_path='' as $$begin
 if exists(select 1 from public.statements s where s.app_id=old.app_id and s.creator_id=old.creator_id and s.status in ('finalized','paid')
   and (s.month=to_char(old.published_at at time zone 'America/New_York','YYYY-MM') or s.lines @> jsonb_build_array(jsonb_build_object('postId',old.id::text))))
   and (to_jsonb(new)-'tracking') is distinct from (to_jsonb(old)-'tracking')
 then raise exception 'Finalized post inputs are immutable; use a linked correction';end if;
 return new;
end;$$;
-- Invalidate pending optimistic writes made by an older application process.
update private.dashboard_revision set revision=revision+1 where id=true;
insert into public.audit_events(id,action,entity_id,detail,created_at)
 values(gen_random_uuid(),'tracking_upgrade','workspace','Accounting timezone changed to America/New_York. Added tracking diagnostics and evidence fields; original data retained.',now());
revoke all on function public.read_dashboard() from public,anon,authenticated;
grant execute on function public.read_dashboard() to service_role;
revoke all on function public.commit_dashboard(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.commit_dashboard(bigint,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
