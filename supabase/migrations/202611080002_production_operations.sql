-- Apply ONCE to the existing Creator Ledger project, after 202611080001.
-- Additive operations metadata only; no financial data, connections or snapshots are rewritten.
-- Does NOT install a Cron schedule or contact the worker.
begin;
lock table private.dashboard_revision in exclusive mode;
do $$begin
 if (public.read_dashboard()->>'schemaVersion')::integer<>2 then
   raise exception 'Expected tracking/New York schema version 2. Do not rerun migrations.';
 end if;
end;$$;
alter table private.jobs add column lease_token uuid;
create table private.worker_invocations (
 id uuid primary key, source text not null check(source in ('supabase-cron','manual')),
 started_at timestamptz not null default now(), finished_at timestamptz,
 outcome text not null default 'running' check(outcome in ('running','idle','success','failed','skipped')),
 processed integer not null default 0 check(processed in (0,1)), http_status integer,
 detail text
);
create index worker_invocations_started on private.worker_invocations(started_at desc);
create table private.worker_http_requests(request_id bigint primary key, created_at timestamptz not null default now());
revoke all on private.worker_invocations,private.worker_http_requests from public,anon,authenticated,service_role;

create or replace function public.lease_tracking_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.jobs;
begin
 update private.jobs set status='queued',leased_until=null,lease_token=null where status='running' and leased_until<now();
 select * into job from private.jobs where status='queued' and available_at<=now() order by available_at for update skip locked limit 1;
 if not found then return null; end if;
 update private.jobs set status='running',attempts=attempts+1,leased_until=now()+interval '3 minutes',lease_token=gen_random_uuid() where id=job.id returning * into job;
 return to_jsonb(job);
end;$$;
-- Disable the old unfenced API. In-flight workers from an older release cannot complete a new lease.
create or replace function public.finish_tracking_job(job_id uuid,success boolean,error_message text default null) returns void language plpgsql security definer set search_path='' as $$begin raise exception 'Lease token required. Deploy the current worker.';end;$$;
create function public.finish_tracking_job(job_id uuid,success boolean,error_message text,expected_lease_token uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
 update private.jobs set status=case when success then 'complete' when attempts>=5 then 'failed' else 'queued' end,
 available_at=now()+interval '5 minutes'*power(2,least(attempts,5)),leased_until=null,lease_token=null,last_error=left(error_message,500)
 where id=job_id and status='running' and lease_token=expected_lease_token and leased_until>now();
 get diagnostics changed=row_count;
 return changed=1;
end;$$;
create function public.commit_tracking_job(job_id uuid,expected_lease_token uuid,expected_revision bigint,document jsonb,success boolean,error_message text default null) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from private.jobs where id=job_id and status='running' and lease_token=expected_lease_token and leased_until>now() for update;
 if not found then raise exception 'LEASE_LOST';end if;
 perform public.commit_dashboard(expected_revision,document);
 if not public.finish_tracking_job(job_id,success,error_message,expected_lease_token) then raise exception 'LEASE_LOST';end if;
end;$$;

create function public.record_worker_invocation(invocation_id uuid,invocation_source text,invocation_outcome text default 'running',processed_count integer default 0,response_status integer default null,safe_detail text default null) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into private.worker_invocations(id,source,outcome,processed,http_status,detail,finished_at)
 values(invocation_id,invocation_source,invocation_outcome,processed_count,response_status,left(safe_detail,500),case when invocation_outcome<>'running' then now() end)
 on conflict(id) do update set outcome=excluded.outcome,processed=excluded.processed,http_status=excluded.http_status,detail=excluded.detail,finished_at=excluded.finished_at;
end;$$;

-- Called only by the manually configured Cron job. Secrets stay in Vault, never in cron.job.
create function private.dispatch_worker() returns bigint language plpgsql security definer set search_path='' as $$
declare worker_url text; worker_secret text; request_id bigint;
begin
 select decrypted_secret into worker_url from vault.decrypted_secrets where name='ugc_worker_url';
 select decrypted_secret into worker_secret from vault.decrypted_secrets where name='ugc_cron_secret';
 if worker_url is null or worker_url !~ '^https://[^/@?#[:space:]]+/api/internal/jobs$' then raise exception 'Configure the HTTPS ugc_worker_url Vault secret';end if;
 if worker_secret is null or length(worker_secret)<32 or worker_secret ~ '[[:space:]]' then raise exception 'Configure ugc_cron_secret in Vault (at least 32 characters, no whitespace)';end if;
 select net.http_post(url:=worker_url,body:='{}'::jsonb,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||worker_secret,'X-Worker-Source','supabase-cron'),timeout_milliseconds:=70000) into request_id;
 insert into private.worker_http_requests(request_id) values(request_id);
 return request_id;
end;$$;
revoke all on function private.dispatch_worker() from public,anon,authenticated,service_role;

create function public.get_operations_status() returns jsonb language plpgsql security definer set search_path='' as $$
declare runs jsonb; queue jsonb; schedules jsonb:='[]'; cron_runs jsonb:='[]'; requests jsonb:='[]';
begin
 select coalesce(jsonb_agg(to_jsonb(t) order by started_at desc),'[]') into runs from (select * from private.worker_invocations order by started_at desc limit 50) t;
 select coalesce(jsonb_object_agg(status,n),'{}') into queue from (select status,count(*) n from private.jobs group by status) t;
 if to_regclass('cron.job') is not null then
   execute $q$select coalesce(jsonb_agg(jsonb_build_object('jobid',jobid,'schedule',schedule,'active',active)),'[]') from cron.job where jobname='ugc-worker-every-five-minutes'$q$ into schedules;
 end if;
 if to_regclass('cron.job_run_details') is not null then
   execute $q$select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select d.start_time,d.end_time,d.status from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='ugc-worker-every-five-minutes' order by d.start_time desc limit 20) t$q$ into cron_runs;
 end if;
 if to_regclass('net._http_response') is not null then
   execute $q$select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select r.request_id,r.created_at,h.status_code,h.timed_out,(h.error_msg is not null) as has_error from private.worker_http_requests r left join net._http_response h on h.id=r.request_id order by r.created_at desc limit 20) t$q$ into requests;
 end if;
 return jsonb_build_object('invocations',runs,'queue',queue,'schedules',schedules,'cronRuns',cron_runs,'httpRequests',requests,'checkedAt',now());
end;$$;

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
  return jsonb_build_object('data',result,'revision',rev,'accountingTimezone','America/New_York','schemaVersion',3);
end;$$;

do $$declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('lease_tracking_job','finish_tracking_job','commit_tracking_job','record_worker_invocation','get_operations_status','read_dashboard') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end;$$;
update private.dashboard_revision set revision=revision+1 where id=true;
notify pgrst,'reload schema';
commit;
