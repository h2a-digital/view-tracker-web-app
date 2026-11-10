-- Profile-only cache/leases; video collection, rules and financial inputs are unchanged.
begin;
lock table private.dashboard_revision in exclusive mode;
do $$begin if to_regprocedure('public.cache_youtube_channel_identity(uuid,text,text,jsonb,text)') is null then raise exception 'Apply the YouTube metadata migration first';end if;end;$$;
create table private.profile_metadata_jobs(account_id uuid primary key references public.accounts(id) on delete cascade,
 next_due_at timestamptz not null default '-infinity',last_attempt_at timestamptz,lease_token uuid,leased_until timestamptz,last_error text);
revoke all on private.profile_metadata_jobs from public,anon,authenticated,service_role;
create function public.lease_profile_metadata(target_account uuid default null,instagram_zernio_enabled boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$declare chosen uuid; token uuid:=gen_random_uuid();begin
 insert into private.profile_metadata_jobs(account_id)
 select a.id from public.accounts a where not coalesce(a.archived,false) and a.integration->>'sourceErasedAt' is null
  and (a.platform='youtube' or a.status='connected' and (a.provider='zernio' and a.platform='tiktok' or a.platform='instagram' and a.provider in ('zernio','direct')))
 on conflict do nothing;
 select a.id into chosen from public.accounts a join private.profile_metadata_jobs j on j.account_id=a.id
 where not coalesce(a.archived,false) and a.integration->>'sourceErasedAt' is null
 and (a.platform='youtube' or a.status='connected' and (a.provider='zernio' and a.platform='tiktok' or a.platform='instagram' and a.provider in ('zernio','direct')))
 and (a.platform<>'instagram' or a.provider<>'zernio' or instagram_zernio_enabled)
 and (target_account is null or a.id=target_account)
 and (j.leased_until is null or j.leased_until<now())
 and (case when target_account is not null then coalesce(j.last_attempt_at,'-infinity')<now()-interval '1 minute'
 else j.next_due_at<=now() and (j.last_error is not null or greatest(private.channel_metadata_instant(a.integration->'profileMetadata'->>'refreshedAt'),case when a.platform='youtube' then private.channel_metadata_instant(a.integration->'channelIdentity'->>'refreshedAt') else '-infinity'::timestamptz end)<now()-interval '24 hours') end)
 order by coalesce(j.last_attempt_at,'-infinity'),a.id for update of j skip locked limit 1;
 if chosen is null then return null;end if;
 update private.profile_metadata_jobs set lease_token=token,leased_until=now()+interval '90 seconds',last_attempt_at=now() where account_id=chosen;
 return jsonb_build_object('account',(select to_jsonb(a) from public.accounts a where id=chosen),'lease_token',token);
end;$$;
create function public.finish_profile_metadata(target_account uuid,expected_lease uuid,expected_username text,expected_channel text,expected_provider text,profile jsonb)
returns boolean language plpgsql security definer set search_path='' as $$declare valid boolean;begin
 perform 1 from private.dashboard_revision where id=true for update;
 perform 1 from private.profile_metadata_jobs where account_id=target_account and lease_token=expected_lease and leased_until>now() for update;
 if not found then return false;end if;
 valid:=exists(select 1 from public.accounts where id=target_account and username=expected_username and provider=expected_provider and provider_account_id is not distinct from expected_channel and not coalesce(archived,false) and integration->>'sourceErasedAt' is null and (platform='youtube' or status='connected'));
 update private.profile_metadata_jobs set leased_until=null,lease_token=null,next_due_at=now()+case when profile is null then interval '1 hour' else interval '24 hours' end,last_error=case when profile is null then 'Profile refresh unavailable; cached metadata retained' else null end where account_id=target_account;
 if not valid then update private.profile_metadata_jobs set next_due_at=now()+interval '1 minute' where account_id=target_account;return false;end if;
 if profile is not null then
  if jsonb_typeof(profile)<>'object' or private.channel_metadata_instant(profile->>'refreshedAt')='-infinity'::timestamptz then raise exception 'Invalid profile metadata';end if;
  update public.accounts set integration=coalesce(integration,'{}'::jsonb)||jsonb_build_object('profileMetadata',(case when jsonb_typeof(integration->'profileMetadata')='object' then integration->'profileMetadata' else '{}'::jsonb end)||profile)
   where id=target_account and private.channel_metadata_instant(integration->'profileMetadata'->>'refreshedAt')<=private.channel_metadata_instant(profile->>'refreshedAt');
  -- Keep existing YouTube display/retention readers compatible.
  update public.accounts set integration=integration||jsonb_build_object('channelIdentity',jsonb_strip_nulls(jsonb_build_object('title',profile->>'name','handle',case when profile->>'username' is not null then '@'||(profile->>'username') end,'avatarUrl',profile->>'avatarUrl','refreshedAt',profile->>'refreshedAt')))
   where id=target_account and platform='youtube' and profile->>'name' is not null and private.channel_metadata_instant(integration->'channelIdentity'->>'refreshedAt')<=private.channel_metadata_instant(profile->>'refreshedAt');
 end if;
 update public.accounts set integration=coalesce(integration,'{}'::jsonb)||jsonb_build_object('profileMetadataStatus',jsonb_build_object('checkedAt',now(),'status',case when profile is null then 'unavailable' else 'updated' end)) where id=target_account;
 update private.dashboard_revision set revision=revision+1 where id=true;
 return true;
end;$$;
revoke all on function public.lease_profile_metadata(uuid,boolean),public.finish_profile_metadata(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.lease_profile_metadata(uuid,boolean),public.finish_profile_metadata(uuid,uuid,text,text,text,jsonb) to service_role;
-- Extend existing retention without altering its grant/source erasure behavior.
alter function public.sweep_provider_retention() set schema private;
alter function private.sweep_provider_retention() rename to sweep_provider_retention_before_social_profiles;
revoke all on function private.sweep_provider_retention_before_social_profiles() from public,anon,authenticated,service_role;
create function public.sweep_provider_retention() returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;n integer;begin
 result:=private.sweep_provider_retention_before_social_profiles();
 update public.accounts set integration=integration-'profileMetadata'-'profileMetadataStatus' where integration ? 'profileMetadata' and private.channel_metadata_instant(integration->'profileMetadata'->>'refreshedAt')<now()-interval '29 days';
 get diagnostics n=row_count;
 if n>0 then update private.dashboard_revision set revision=revision+1 where id=true;end if;
 return result;
end;$$;
revoke all on function public.sweep_provider_retention() from public,anon,authenticated;
grant execute on function public.sweep_provider_retention() to service_role;
commit;
