-- Optional schema-5 UI capability. No existing data is deleted or provider grant changed.
begin;
lock table private.dashboard_revision in exclusive mode;
do $$begin if (public.read_dashboard()->>'schemaVersion')::int<>5 then raise exception 'Expected schema 5';end if;end;$$;
-- Nullable keeps older documents compatible with composite-record INSERTs.
alter table public.creators add column archived boolean default false;
alter table public.accounts add column archived boolean default false;
create function private.preserve_archival() returns trigger language plpgsql set search_path='' as $$begin
 new.archived:=coalesce(new.archived,old.archived,false);
 if tg_table_name='accounts' then
  if new.archived and new.status in ('connected','attention') then raise exception 'Archived accounts must remain disconnected';end if;
 end if;
 return new;end;$$;
create trigger preserve_archival before update on public.creators for each row execute function private.preserve_archival();
create trigger preserve_archival before update on public.accounts for each row execute function private.preserve_archival();
revoke all on function private.preserve_archival() from public,anon,authenticated,service_role;

create function public.store_channel_identity(target_account uuid,expected_channel text,identity jsonb) returns void
language plpgsql security definer set search_path='' as $$begin
 perform 1 from private.dashboard_revision where id=true for update;
 if jsonb_typeof(identity)<>'object' or length(coalesce(identity->>'title','')) not between 1 and 1000 then raise exception 'Invalid channel metadata';end if;
 update public.accounts set integration=coalesce(integration,'{}'::jsonb)||jsonb_build_object('channelIdentity',identity)
 where id=target_account and provider='direct' and platform='youtube' and status='connected' and provider_account_id=expected_channel;
 if found then update private.dashboard_revision set revision=revision+1 where id=true;end if;
end;$$;

create function public.manage_dashboard_record(expected_revision bigint,entity text,target uuid,operation text)
returns void language plpgsql security definer set search_path='' as $$
declare rev bigint; campaign_ids uuid[]; account_ids uuid[];
begin
 select revision into rev from private.dashboard_revision where id=true for update;
 if expected_revision is null or expected_revision<>rev then raise exception 'CONFLICT: Refresh before trying again';end if;
 if entity not in ('app','campaign','creator','account') or operation not in ('archive','restore','remove') then raise exception 'Invalid management operation';end if;
 if entity='app' then
  if not exists(select 1 from public.apps where id=target) then raise exception 'App not found';end if;
  select array_agg(id) into campaign_ids from public.campaigns where app_id=target;
 elsif entity='campaign' then
  if not exists(select 1 from public.campaigns where id=target) then raise exception 'Campaign not found';end if;
  campaign_ids:=array[target];
 elsif entity='creator' then
  if not exists(select 1 from public.creators where id=target) then raise exception 'Creator not found';end if;
  select array_agg(id) into account_ids from public.accounts where creator_id=target;
 else
  if not exists(select 1 from public.accounts where id=target) then raise exception 'Account not found';end if;
  account_ids:=array[target];
 end if;
 -- Provider revocation/erasure is a separate explicit operation. Never cascade a shared grant here.
 if operation<>'restore' and exists(select 1 from public.accounts a where a.id=any(account_ids)
   and (a.status in ('connected','attention') or a.provider_account_id is not null
     or exists(select 1 from private.oauth_credentials c where c.account_id=a.id))) then
  raise exception 'Disconnect associated accounts first. Direct-provider disconnection erases source data and may affect shared grants; review the confirmation.';
 end if;
 if operation in ('archive','remove') and exists(select 1 from private.connection_sessions where account_id=any(account_ids) and consumed_at is null and expires_at>now()) then raise exception 'A connection invitation is pending. Complete it or wait for expiry before archiving/removing.';end if;
 if operation='restore' and entity='account' and exists(select 1 from public.accounts a join public.creators c on c.id=a.creator_id where a.id=target and c.archived) then raise exception 'Restore the creator first';end if;
 if operation='remove' then
  if exists(select 1 from public.posts p where p.account_id=any(account_ids) or p.campaign_id=any(campaign_ids)
      or entity='app' and p.app_id=target or entity='creator' and p.creator_id=target)
    or exists(select 1 from public.statements s where entity='app' and s.app_id=target or entity='creator' and s.creator_id=target) then
   raise exception 'Historical posts or compensation exist. Archive instead; financial records cannot be removed.';
  end if;
  if entity in ('app','campaign') and exists(select 1 from public.memberships m where m.campaign_id=any(campaign_ids)) then
   raise exception 'Campaign assignments exist. Archive instead to retain attribution.';
  end if;
  if entity='creator' and exists(select 1 from public.accounts where creator_id=target) then
   raise exception 'Remove unused social accounts first, or archive this creator.';
  end if;
  if exists(select 1 from private.provider_revocations where account_id=any(account_ids) and status='pending') then
   raise exception 'Provider revocation is pending. Wait for maintenance before removing this account.';
  end if;
  -- Rules may only be discarded when no post anywhere references them.
  if exists(select 1 from public.rule_versions r join public.posts p on p.rule_version_ids ? r.id::text
   where entity='app' and r.app_id=target or entity='campaign' and r.campaign_id=target or entity='creator' and r.creator_id=target) then
   raise exception 'Historical rule references exist. Archive instead.';
  end if;
  delete from public.mappings where account_id=any(account_ids) or membership_id in(select id from public.memberships where entity='creator' and creator_id=target);
  delete from public.memberships where entity='creator' and creator_id=target;
  delete from public.rule_versions where entity='app' and app_id=target or entity='campaign' and campaign_id=target or entity='creator' and creator_id=target;
  delete from private.oauth_flows where invite_hash in(select hash from private.oauth_invites where account_id=any(account_ids));
  delete from private.oauth_invites where account_id=any(account_ids);
  delete from private.connection_sessions where account_id=any(account_ids);
  delete from private.deletion_links where account_id=any(account_ids);
  delete from private.account_checks where account_id=any(account_ids);
  delete from private.provider_revocations where account_id=any(account_ids);
  delete from private.jobs where account_id=any(account_ids);
  delete from public.sync_runs where account_id=any(account_ids);
  if entity='account' then delete from public.accounts where id=target;
  elsif entity='creator' then delete from public.creators where id=target;
  else
   delete from public.campaigns where id=any(campaign_ids);
   if entity='app' then delete from public.apps where id=target;end if;
  end if;
 else
  if entity='account' then update public.accounts set archived=operation='archive' where id=target;
  elsif entity='creator' then
   update public.creators set archived=operation='archive' where id=target;
   if operation='archive' then update public.accounts set archived=true where id=any(account_ids);end if;
  elsif entity='app' then
   update public.apps set archived=operation='archive' where id=target;
   if operation='archive' then update public.campaigns set status='archived' where id=any(campaign_ids);end if;
  else update public.campaigns set status=case when operation='archive' then 'archived' else 'paused' end where id=target;
  end if;
  if operation='archive' then
   -- Archive ends current routing without changing historical attribution.
   if exists(select 1 from public.mappings where starts_at>=now() and (account_id=any(account_ids) or membership_id in(select id from public.memberships where campaign_id=any(campaign_ids) or entity='creator' and creator_id=target))) or exists(select 1 from public.memberships where starts_at>=now() and (campaign_id=any(campaign_ids) or entity='creator' and creator_id=target)) then raise exception 'Future campaign assignments exist. Resolve their dates before archiving.';end if;
   update public.mappings set ends_at=now()
     where (ends_at is null or ends_at>now()) and (account_id=any(account_ids) or membership_id in(select id from public.memberships where campaign_id=any(campaign_ids) or entity='creator' and creator_id=target));
   update public.memberships set ends_at=now()
     where (ends_at is null or ends_at>now()) and (campaign_id=any(campaign_ids) or entity='creator' and creator_id=target);
   update private.connection_sessions set expires_at=now() where account_id=any(account_ids) and consumed_at is null;
   update private.oauth_invites set consumed_at=now() where account_id=any(account_ids) and consumed_at is null;
   update private.jobs set status='cancelled',leased_until=null,lease_token=null where account_id=any(account_ids) and status in ('queued','running');
  end if;
 end if;
 insert into public.audit_events(id,action,entity_id,detail,created_at) values(gen_random_uuid(),operation,target::text,entity||' '||operation||'; financial history protected',now());
 update private.dashboard_revision set revision=revision+1 where id=true;
end;$$;
revoke all on function public.manage_dashboard_record(bigint,text,uuid,text),public.store_channel_identity(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.manage_dashboard_record(bigint,text,uuid,text),public.store_channel_identity(uuid,text,jsonb) to service_role;
create function public.get_disconnect_impact(target_account uuid) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'platform',a.platform,'username',a.username)),'[]'::jsonb)
 from public.accounts a join private.oauth_credentials c on c.account_id=a.id
 where a.id<>target_account and a.provider='direct' and a.platform in ('instagram','facebook')
 and c.subject_hash=(select subject_hash from private.oauth_credentials where account_id=target_account)
 and exists(select 1 from public.accounts where id=target_account and platform in ('instagram','facebook'));
$$;
revoke all on function public.get_disconnect_impact(uuid) from public,anon,authenticated;
grant execute on function public.get_disconnect_impact(uuid) to service_role;
commit;
