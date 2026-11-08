-- Incremental schema 4 -> 5. No source data is erased by applying this migration.
-- Runtime erasure is restricted to direct providers; TikTok/Zernio is untouched.
begin;
lock table private.dashboard_revision in exclusive mode;
do $$begin if (public.read_dashboard()->>'schemaVersion')::int<>4 then raise exception 'Expected schema 4';end if;end;$$;
alter table public.posts add column source_erased_at timestamptz;
alter table public.statements add column source_redacted_at timestamptz;
alter table public.adjustments add column source_redacted_at timestamptz;
alter table public.adjustments alter column eligible_views drop not null;
alter table private.oauth_credentials add column subject_hash text;
alter table private.oauth_credentials add column authorized_at timestamptz not null default now();
create table private.source_erasure_log(post_id uuid primary key,account_id uuid not null,erased_at timestamptz not null default now());
create table private.erased_accounts(account_id uuid primary key,erased_at timestamptz not null default now());
revoke all on private.source_erasure_log,private.erased_accounts from public,anon,authenticated,service_role;
create table private.lifecycle_guard(transaction_id bigint primary key);
create table private.source_checks(post_id uuid primary key references public.posts(id),verified_at timestamptz not null default now());
create table private.account_checks(account_id uuid primary key references public.accounts(id),last_success_at timestamptz not null default now(),next_check_at timestamptz not null default now(),lease_token uuid,leased_until timestamptz,last_error text);
create table private.deletion_links(hash text primary key,account_id uuid not null references public.accounts(id),expires_at timestamptz not null default now()+interval '90 days');
create table private.deletion_receipts(hash text primary key,completed_at timestamptz not null default now());
create table private.provider_revocations(id uuid primary key default gen_random_uuid(),account_id uuid not null references public.accounts(id),platform text not null,encrypted_token text,created_at timestamptz not null default now(),available_at timestamptz not null default now(),lease_token uuid,leased_until timestamptz,attempts integer not null default 0,status text not null default 'pending' check(status in ('pending','complete','failed')),last_error text);
revoke all on private.lifecycle_guard,private.source_checks,private.account_checks,private.deletion_links,private.deletion_receipts,private.provider_revocations from public,anon,authenticated,service_role;
-- Existing direct rows receive conservative verification ages; never reset the age of old source data.
insert into private.source_checks(post_id,verified_at) select p.id,least(now(),coalesce((select min(observed_at) from public.snapshots s where s.post_id=p.id),p.published_at)) from public.posts p join public.accounts a on a.id=p.account_id where a.provider='direct';
insert into private.account_checks(account_id) select id from public.accounts where provider='direct';
create function private.lifecycle_writing() returns boolean language sql security definer set search_path='' as $$select exists(select 1 from private.lifecycle_guard where transaction_id=txid_current())$$;
-- Only the lifecycle transaction can redact source fields. Monetary and settlement fields remain immutable.
create or replace function private.protect_statement() returns trigger language plpgsql security definer set search_path='' as $$begin
 if private.lifecycle_writing() then
  if old.status<>'draft' and (to_jsonb(new)-array['lines','fingerprint','bonus_note','source_redacted_at']) is distinct from (to_jsonb(old)-array['lines','fingerprint','bonus_note','source_redacted_at']) then raise exception 'Lifecycle cannot change settled money';end if;
  return new;
 end if;
 if old.status in ('finalized','paid') and (to_jsonb(new)-array['status','paid_at','payment_reference','payment_amount_cents']) is distinct from (to_jsonb(old)-array['status','paid_at','payment_reference','payment_amount_cents']) then raise exception 'Finalized statements are immutable';end if;
 if old.status='paid' and new is distinct from old then raise exception 'Paid statements are immutable';end if;
 if old.status='finalized' and new.status not in ('finalized','paid') then raise exception 'Invalid settlement transition';end if;
 return new;
end;$$;
create or replace function private.protect_post() returns trigger language plpgsql security definer set search_path='' as $$begin
 if private.lifecycle_writing() then
  if (to_jsonb(new)-array['caption','url','platform_post_id','published_at','deadline','eligible_views','eligibility_status','review_note','accepted_by','accepted_at','deleted','tracking','review_evidence','rules','rule_version_ids','source_erased_at']) is distinct from (to_jsonb(old)-array['caption','url','platform_post_id','published_at','deadline','eligible_views','eligibility_status','review_note','accepted_by','accepted_at','deleted','tracking','review_evidence','rules','rule_version_ids','source_erased_at']) then raise exception 'Invalid source redaction';end if;
  return new;
 end if;
 if old.source_erased_at is not null and new is distinct from old then raise exception 'Erased source cannot be restored';end if;
 if exists(select 1 from public.statements s where s.app_id=old.app_id and s.creator_id=old.creator_id and s.status in ('finalized','paid') and (s.month=to_char(old.published_at at time zone 'America/New_York','YYYY-MM') or s.lines @> jsonb_build_array(jsonb_build_object('postId',old.id::text)))) and (to_jsonb(new)-'tracking') is distinct from (to_jsonb(old)-'tracking') then raise exception 'Finalized post inputs are immutable; use a linked correction';end if;
 return new;
end;$$;
create or replace function private.protect_adjustment() returns trigger language plpgsql security definer set search_path='' as $$begin
 if private.lifecycle_writing() then
  if (to_jsonb(new)-array['eligible_views','evidence','note','source_redacted_at']) is distinct from (to_jsonb(old)-array['eligible_views','evidence','note','source_redacted_at']) then raise exception 'Lifecycle cannot change correction money';end if;
  return new;
 end if;
 if old.source_redacted_at is not null and new.status='approved' and old.status='pending' then raise exception 'Erased evidence cannot be approved';end if;
 if (to_jsonb(new)-array['status','paid_at','payment_reference']) is distinct from (to_jsonb(old)-array['status','paid_at','payment_reference']) then raise exception 'Correction inputs are immutable';end if;
 if old.status in ('rejected','paid') and new is distinct from old then raise exception 'Settled corrections are immutable';end if;
 if old.status='approved' and new.status not in ('approved','paid') then raise exception 'Invalid correction transition';end if;
 return new;
end;$$;
create function private.register_source_check() returns trigger language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.accounts a where a.id=new.account_id and a.provider='direct') then insert into private.source_checks(post_id) values(new.id) on conflict do nothing;end if;return new;
end;$$;
create trigger register_source_check after insert on public.posts for each row execute function private.register_source_check();
-- Erase all views/evidence and metadata, including copies in fingerprints, lines, corrections and diagnostics.
-- Retain only internal contractual/payment references, monetary allocations and the financial month.
create function private.erase_post_sources(targets uuid[]) returns integer language plpgsql security definer set search_path='' as $$declare n integer;begin
 insert into private.source_erasure_log(post_id,account_id) select id,account_id from public.posts where id=any(targets) on conflict do nothing;
 insert into private.lifecycle_guard values(txid_current()) on conflict do nothing;
 update public.statements s set lines=(select coalesce(jsonb_agg(case when (l->>'postId')::uuid=any(targets) then l-'views' || '{"views":null}'::jsonb else l end),'[]') from jsonb_array_elements(s.lines) l), fingerprint='',bonus_note=null,source_redacted_at=now()
 where exists(select 1 from public.posts p where p.id=any(targets) and (s.lines @> jsonb_build_array(jsonb_build_object('postId',p.id::text)) or (s.app_id=p.app_id and s.creator_id=p.creator_id and s.month=to_char(p.published_at at time zone 'America/New_York','YYYY-MM'))));
 update public.statements s set base_cents=0,potential_bonus_cents=0,approved_bonus_cents=null,payable_cents=0,capped_cents=0,lines='[]',fingerprint='' where status='draft' and source_redacted_at=now();
 update public.adjustments set eligible_views=null,evidence=null,note='Source evidence erased',source_redacted_at=now() where post_id=any(targets);
 delete from public.snapshots where post_id=any(targets);
 -- Audit/free-text diagnostics can contain copied URLs, captions, metrics or evidence.
 delete from public.audit_events where entity_id=any(select id::text from public.posts where id=any(targets)) or entity_id=any(select id::text from public.adjustments where post_id=any(targets)) or entity_id=any(select id::text from public.statements where source_redacted_at=now());
 delete from public.sync_runs where account_id in (select account_id from public.posts where id=any(targets));
 update public.posts set platform_post_id='erased:'||id::text,url='urn:creator-ledger:erased:'||id::text,caption='',published_at='1970-01-01T00:00:00Z',deadline=null,eligible_views=null,eligibility_status='excluded',review_note='Provider source erased',accepted_by=null,accepted_at=null,deleted=true,tracking=null,review_evidence=null,rules=null,rule_version_ids='[]',source_erased_at=now() where id=any(targets) and source_erased_at is null;
 get diagnostics n=row_count;
 delete from private.source_checks where post_id=any(targets);
 delete from private.lifecycle_guard where transaction_id=txid_current();
 return n;
end;$$;
create function private.erase_direct_account(target_account uuid,queue_revocation boolean default false) returns void language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.accounts where id=target_account and provider='direct') then raise exception 'Direct account required';end if;
 insert into private.erased_accounts(account_id) values(target_account) on conflict do nothing;
 if queue_revocation then insert into private.provider_revocations(account_id,platform,encrypted_token) select c.account_id,a.platform,c.encrypted_token from private.oauth_credentials c join public.accounts a on a.id=c.account_id where c.account_id=target_account;end if;
 perform private.erase_post_sources(array(select id from public.posts where account_id=target_account and source_erased_at is null));
 delete from private.oauth_credentials where account_id=target_account;
 delete from private.deletion_links where account_id=target_account;
 delete from private.oauth_flows where invite_hash in (select hash from private.oauth_invites where account_id=target_account);
 delete from private.oauth_invites where account_id=target_account;
 delete from private.account_checks where account_id=target_account;
 delete from public.audit_events where entity_id=target_account::text;
 delete from public.sync_runs where account_id=target_account;
 update private.jobs set status='cancelled',lease_token=null,leased_until=null,last_error=null where account_id=target_account and status in ('queued','running');
 update public.accounts set username='removed-'||id::text,provider_account_id=null,provider_profile_id=null,status='disconnected',last_synced_at=null,error=null,integration=jsonb_build_object('sourceErasedAt',now()) where id=target_account;
end;$$;
create function public.erase_direct_account(target_account uuid,receipt_hash text,expected_version bigint default null,queue_revocation boolean default true) returns boolean language plpgsql security definer set search_path='' as $$declare sibling record; subject text;begin
 perform 1 from private.dashboard_revision where id=true for update;
 if expected_version is not null and not exists(select 1 from private.oauth_credentials where account_id=target_account and version=expected_version) then return false;end if;
 if queue_revocation then
  select c.subject_hash into subject from private.oauth_credentials c join public.accounts a on a.id=c.account_id where c.account_id=target_account and a.platform in ('instagram','facebook');
  for sibling in select c.account_id from private.oauth_credentials c join public.accounts a on a.id=c.account_id where c.subject_hash=subject and c.account_id<>target_account and a.provider='direct' and a.platform in ('instagram','facebook') loop
   perform private.erase_direct_account(sibling.account_id,false);
  end loop;
 end if;
 perform private.erase_direct_account(target_account,queue_revocation);
 insert into private.deletion_receipts(hash) values(receipt_hash) on conflict do nothing;
 update private.dashboard_revision set revision=revision+1 where id=true;
 return true;
end;$$;
-- CAS revocation cannot erase a newer reconnect. In-flight worker writes lose their revision/lease.
create or replace function public.forget_direct_credentials(target_account uuid,expected_version bigint) returns void language plpgsql security definer set search_path='' as $$begin
 perform public.erase_direct_account(target_account,gen_random_uuid()::text,expected_version,false);
end;$$;
create or replace function public.disconnect_direct_account(target_account uuid,expected_revision bigint,document jsonb) returns void language plpgsql security definer set search_path='' as $$begin
 perform 1 from private.dashboard_revision where id=true and revision=expected_revision for update;
 if not found then raise exception 'CONFLICT';end if;
 perform public.erase_direct_account(target_account,gen_random_uuid()::text,null,true);
end;$$;
-- The new app supplies opaque subject/deletion hashes; no subject IDs enter dashboard data.
drop function public.commit_direct_connection(text,text,bigint,jsonb,text);
create function public.commit_direct_connection(hash text,expected_browser_hash text,expected_revision bigint,document jsonb,encrypted_token text,subject_fingerprint text default null,deletion_hash text default null) returns void language plpgsql security definer set search_path='' as $$declare target uuid; invite text;begin
 select i.account_id,i.hash into target,invite from private.oauth_flows f join private.oauth_invites i on i.hash=f.invite_hash where f.state_hash=commit_direct_connection.hash and f.browser_hash=expected_browser_hash and f.consumed_at is null and f.expires_at>now() and i.consumed_at is null and i.expires_at>now() for update of i,f;
 if target is null then raise exception 'OAuth flow expired, invalid or consumed';end if;
 if exists(select 1 from public.accounts where id=target and integration->>'sourceErasedAt' is not null) then raise exception 'Create a new registered account after erasure';end if;
 if not exists(select 1 from jsonb_array_elements(document->'accounts') a where a->>'id'=target::text and a->>'provider'='direct' and a->>'status'='connected' and coalesce(a->>'provider_account_id','')<>'') then raise exception 'Missing verified account';end if;
 perform public.commit_dashboard(expected_revision,document);
 insert into private.oauth_credentials(account_id,encrypted_token,subject_hash,authorized_at) values(target,encrypted_token,subject_fingerprint,now()) on conflict(account_id) do update set encrypted_token=excluded.encrypted_token,version=private.oauth_credentials.version+1,updated_at=now(),subject_hash=excluded.subject_hash,authorized_at=now();
 update private.oauth_invites set consumed_at=now() where private.oauth_invites.hash=invite;
 update private.oauth_flows set consumed_at=now() where state_hash=commit_direct_connection.hash;
 insert into private.jobs(account_id) values(target) on conflict do nothing;
 insert into private.account_checks(account_id) values(target) on conflict(account_id) do update set next_check_at=now(),lease_token=null,leased_until=null,last_success_at=now(),last_error=null;
 if deletion_hash is not null then insert into private.deletion_links(hash,account_id) values(deletion_hash,target);end if;
end;$$;
create function public.create_deletion_link(target_account uuid,token_hash text) returns void language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.accounts where id=target_account and provider='direct' and status<>'disconnected') then raise exception 'Connected direct account required';end if;
 insert into private.deletion_links(hash,account_id) values(token_hash,target_account);
end;$$;
create function public.read_deletion_link(token_hash text) returns boolean language sql security definer set search_path='' as $$select exists(select 1 from private.deletion_links where hash=token_hash and expires_at>now())$$;
create function public.redeem_deletion_link(token_hash text,receipt_hash text) returns void language plpgsql security definer set search_path='' as $$declare target uuid;begin
 perform 1 from private.dashboard_revision where id=true for update;
 select account_id into target from private.deletion_links where hash=token_hash and expires_at>now() for update;
 if target is null then raise exception 'Deletion link expired';end if;
 perform public.erase_direct_account(target,receipt_hash,null,true);
end;$$;
create function public.erase_meta_subject(subject_fingerprint text,issued_at timestamptz,receipt_hash text) returns void language plpgsql security definer set search_path='' as $$declare target record;begin
 perform 1 from private.dashboard_revision where id=true for update;
 for target in select c.account_id from private.oauth_credentials c join public.accounts a on a.id=c.account_id where c.subject_hash=subject_fingerprint and a.platform in ('instagram','facebook') and a.provider='direct' and c.authorized_at<issued_at+interval '1 second' loop
  perform private.erase_direct_account(target.account_id,false);
 end loop;
 insert into private.deletion_receipts(hash) values(receipt_hash) on conflict do nothing;
 update private.dashboard_revision set revision=revision+1 where id=true;
end;$$;
create function public.read_deletion_receipt(token_hash text) returns jsonb language sql security definer set search_path='' as $$select jsonb_build_object('status','complete','completedAt',completed_at) from private.deletion_receipts where hash=token_hash and completed_at>now()-interval '30 days'$$;
create function public.sweep_provider_retention() returns jsonb language plpgsql security definer set search_path='' as $$declare target record; n integer:=0; ids uuid[];begin
 perform 1 from private.dashboard_revision where id=true for update;
 -- Conservative app policy: source rows 90 days, metadata/auth check no later than 29 days.
 for target in select c.account_id from private.account_checks c join public.accounts a on a.id=c.account_id where a.provider='direct' and c.last_success_at<now()-interval '29 days' limit 20 loop
  perform private.erase_direct_account(target.account_id,true);n:=n+1;
 end loop;
 select array_agg(id) into ids from (select p.id from public.posts p join public.accounts a on a.id=p.account_id join private.source_checks c on c.post_id=p.id where a.provider='direct' and p.source_erased_at is null and (p.published_at<now()-interval '90 days' or c.verified_at<now()-interval '29 days') order by c.verified_at limit 200) q;
 if ids is not null then n:=n+private.erase_post_sources(ids);end if;
 delete from private.oauth_flows f where expires_at<now() or consumed_at is not null or exists(select 1 from private.oauth_invites i where i.hash=f.invite_hash and (i.expires_at<now() or i.consumed_at is not null));
 delete from private.oauth_invites i where expires_at<now() or consumed_at is not null;
 delete from private.deletion_links where expires_at<now();
 delete from private.deletion_receipts where completed_at<now()-interval '30 days';
 update private.provider_revocations set encrypted_token=null,status='failed',last_error='Remote revocation could not be confirmed within 24 hours; source data already erased',lease_token=null,leased_until=null where status='pending' and created_at<now()-interval '24 hours';
 delete from private.provider_revocations where created_at<now()-interval '30 days';
 if n>0 then update private.dashboard_revision set revision=revision+1 where id=true;end if;
 return jsonb_build_object('erased',n);
end;$$;
create function public.lease_source_check() returns jsonb language plpgsql security definer set search_path='' as $$declare c private.account_checks;begin
 select x.* into c from private.account_checks x join public.accounts a on a.id=x.account_id where a.provider='direct' and a.status='connected' and x.next_check_at<=now() and (x.leased_until is null or x.leased_until<now()) and (a.integration->>'retryAfterAt' is null or (a.integration->>'retryAfterAt')::timestamptz<=now()) order by x.next_check_at for update of x skip locked limit 1;
 if c.account_id is null then return null;end if;
 update private.account_checks set lease_token=gen_random_uuid(),leased_until=now()+interval '3 minutes' where account_id=c.account_id returning * into c;
 return jsonb_build_object('account',(select to_jsonb(a) from public.accounts a where id=c.account_id),'leaseToken',c.lease_token,'posts',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from (select p.id,p.platform_post_id,p.published_at from public.posts p join private.source_checks s on s.post_id=p.id where p.account_id=c.account_id and p.source_erased_at is null and s.verified_at<now()-interval '1 day' order by s.verified_at limit 50) p));
end;$$;
create function public.complete_source_check(target_account uuid,expected_lease uuid,observations jsonb,authorized boolean,retry_seconds integer default 3600) returns void language plpgsql security definer set search_path='' as $$declare item jsonb; ids uuid[];begin
 perform 1 from private.dashboard_revision where id=true for update;
 perform 1 from private.account_checks where account_id=target_account and lease_token=expected_lease and leased_until>now() for update;
 if not found then raise exception 'LEASE_LOST';end if;
 if jsonb_typeof(observations)<>'array' or jsonb_array_length(observations)>50 then raise exception 'Invalid source checks';end if;
 insert into private.lifecycle_guard values(txid_current()) on conflict do nothing;
 for item in select * from jsonb_array_elements(observations) loop
  if item->>'status'='available' then
   update public.posts set caption=coalesce(item->>'caption','') where id=(item->>'id')::uuid and account_id=target_account and source_erased_at is null;
   update private.source_checks set verified_at=now() where post_id=(item->>'id')::uuid and exists(select 1 from public.posts p where p.id=post_id and p.account_id=target_account);
  end if;
 end loop;
 delete from private.lifecycle_guard where transaction_id=txid_current();
 select array_agg((o->>'id')::uuid) into ids from jsonb_array_elements(observations) o join public.posts p on p.id=(o->>'id')::uuid where p.account_id=target_account and o->>'status'='unavailable';
 if ids is not null then perform private.erase_post_sources(ids);end if;
 update private.account_checks set last_success_at=case when authorized then now() else last_success_at end, next_check_at=now()+make_interval(secs=>case when not authorized or jsonb_array_length(observations)=0 and exists(select 1 from private.source_checks s join public.posts p on p.id=s.post_id where p.account_id=target_account and s.verified_at<now()-interval '1 day') then greatest(300,least(retry_seconds,86400)) when exists(select 1 from private.source_checks s join public.posts p on p.id=s.post_id where p.account_id=target_account and s.verified_at<now()-interval '1 day') then greatest(300,least(retry_seconds,86400)) else 86400 end),lease_token=null,leased_until=null,last_error=case when not authorized then 'Source authorization check failed; retry pending' when exists(select 1 from private.source_checks s join public.posts p on p.id=s.post_id where p.account_id=target_account and s.verified_at<now()-interval '1 day') then 'Source checks pending' else null end where account_id=target_account;
 update private.dashboard_revision set revision=revision+1 where id=true;
end;$$;
create function public.lease_provider_revocation() returns jsonb language plpgsql security definer set search_path='' as $$declare r private.provider_revocations;begin
 select * into r from private.provider_revocations where status='pending' and available_at<=now() and (leased_until is null or leased_until<now()) and created_at>now()-interval '24 hours' order by created_at for update skip locked limit 1;
 if r.id is null then return null;end if;
 update private.provider_revocations set lease_token=gen_random_uuid(),leased_until=now()+interval '3 minutes',attempts=attempts+1 where id=r.id returning * into r;
 return to_jsonb(r);
end;$$;
create function public.finish_provider_revocation(target_id uuid,expected_lease uuid,success boolean) returns void language plpgsql security definer set search_path='' as $$begin
 update private.provider_revocations set status=case when success then 'complete' else 'pending' end,encrypted_token=case when success then null else encrypted_token end,available_at=now()+interval '5 minutes'*power(2,least(attempts,7)),last_error=case when success then null else 'Provider revocation retry pending; source data already erased' end,lease_token=null,leased_until=null where id=target_id and lease_token=expected_lease and leased_until>now();
 if not found then raise exception 'LEASE_LOST';end if;
end;$$;
alter function public.read_dashboard() set schema private;
alter function private.read_dashboard() rename to read_dashboard_v4;
create function public.read_dashboard() returns jsonb language sql security definer set search_path='' as $$select private.read_dashboard_v4()||jsonb_build_object('schemaVersion',5)$$;
alter function public.get_operations_status() set schema private;
alter function private.get_operations_status() rename to get_operations_status_v4;
create function public.get_operations_status() returns jsonb language sql security definer set search_path='' as $$select private.get_operations_status_v4()||jsonb_build_object('lifecycle',jsonb_build_object('pendingRevocations',(select count(*) from private.provider_revocations where status='pending'),'failedRevocations',(select count(*) from private.provider_revocations where status='failed'),'pendingSourceChecks',(select count(*) from private.account_checks where next_check_at<=now()),'sourceCheckErrors',(select count(*) from private.account_checks where last_error is not null),'oldestSuccessfulCheck',(select min(last_success_at) from private.account_checks),'lastDeletion',(select max(completed_at) from private.deletion_receipts)))$$;
create function public.reapply_source_erasure_manifest(account_ids uuid[],post_ids uuid[]) returns void language plpgsql security definer set search_path='' as $$declare target record;begin
 perform 1 from private.dashboard_revision where id=true for update;
 for target in select id from public.accounts where id=any(account_ids) and provider='direct' loop perform private.erase_direct_account(target.id,false);end loop;
 perform private.erase_post_sources(array(select p.id from public.posts p join public.accounts a on a.id=p.account_id where p.id=any(post_ids) and a.provider='direct'));
 update private.dashboard_revision set revision=revision+1 where id=true;
end;$$;
-- All lifecycle RPCs are service-only; callbacks authenticate signatures/capabilities server-side.
do $$declare f record;begin
 for f in select n.nspname namespace,p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('reapply_source_erasure_manifest','erase_direct_account','forget_direct_credentials','disconnect_direct_account','commit_direct_connection','create_deletion_link','read_deletion_link','redeem_deletion_link','erase_meta_subject','read_deletion_receipt','sweep_provider_retention','lease_source_check','complete_source_check','lease_provider_revocation','finish_provider_revocation','read_dashboard','get_operations_status')) or (n.nspname='private' and p.proname in ('lifecycle_writing','protect_statement','protect_post','protect_adjustment','register_source_check','erase_post_sources','erase_direct_account','read_dashboard_v4','get_operations_status_v4')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 if f.namespace='public' then execute format('grant execute on function %s to service_role',f.signature);end if;
 end loop;
end;$$;
update private.dashboard_revision set revision=revision+1 where id=true;
notify pgrst,'reload schema';
commit;
