-- Incremental schema-5 capability: public channel labels without OAuth reconnection.
-- No existing data is deleted when this migration is applied.
begin;
lock table private.dashboard_revision in exclusive mode;
do $$begin
 if (public.read_dashboard()->>'schemaVersion')::int<>5 then raise exception 'Expected schema 5';end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='archived') then raise exception 'Apply 202611090001_dashboard_management.sql first';end if;
end;$$;
create function private.channel_metadata_instant(value text) returns timestamptz language plpgsql stable set search_path='' as $$begin
 return coalesce(value::timestamptz,'-infinity'::timestamptz);
 exception when others then return '-infinity'::timestamptz;
end;$$;
revoke all on function private.channel_metadata_instant(text) from public,anon,authenticated,service_role;
create function public.cache_youtube_channel_identity(target_account uuid,expected_username text,expected_channel text,identity jsonb,lookup_status text)
returns boolean language plpgsql security definer set search_path='' as $$declare current_identity jsonb;begin
 perform 1 from private.dashboard_revision where id=true for update;
 if lookup_status not in ('updated','not_found','unavailable') then raise exception 'Invalid metadata status';end if;
 if lookup_status='updated' and (identity is null or jsonb_typeof(identity)<>'object' or length(coalesce(identity->>'title','')) not between 1 and 1000 or private.channel_metadata_instant(identity->>'refreshedAt')='-infinity'::timestamptz) then raise exception 'Invalid channel identity';end if;
 select integration into current_identity from public.accounts where id=target_account and platform='youtube'
  and username=expected_username and provider_account_id is not distinct from expected_channel
  and not coalesce(archived,false) and integration->>'sourceErasedAt' is null for update;
 if not found then return false;end if;
 -- Requests delayed behind another lookup do not overwrite a newer observation.
 if private.channel_metadata_instant(current_identity->'channelIdentityLookup'->>'checkedAt')>now()-interval '1 minute' then return false;end if;
 current_identity:=coalesce(current_identity,'{}'::jsonb);
 if lookup_status='updated' then current_identity:=current_identity||jsonb_build_object('channelIdentity',identity);
 elsif lookup_status='not_found' then current_identity:=current_identity-'channelIdentity';end if;
 update public.accounts set integration=current_identity||jsonb_build_object('channelIdentityLookup',jsonb_build_object('checkedAt',now(),'status',lookup_status)) where id=target_account;
 update private.dashboard_revision set revision=revision+1 where id=true;
 return true;
end;$$;
revoke all on function public.cache_youtube_channel_identity(uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.cache_youtube_channel_identity(uuid,text,text,jsonb,text) to service_role;

-- Keep all existing grant/source retention behavior. Add expiry for public-only
-- channel labels on registered accounts that never acquire an OAuth grant.
alter function public.sweep_provider_retention() set schema private;
alter function private.sweep_provider_retention() rename to sweep_provider_retention_before_channel_metadata;
revoke all on function private.sweep_provider_retention_before_channel_metadata() from public,anon,authenticated,service_role;
create function public.sweep_provider_retention() returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb; n integer; m integer;begin
 result:=private.sweep_provider_retention_before_channel_metadata();
 update public.accounts set integration=integration-'channelIdentity' where platform='youtube' and integration ? 'channelIdentity'
  and private.channel_metadata_instant(integration->'channelIdentity'->>'refreshedAt')<now()-interval '29 days';
 get diagnostics n=row_count;
 update public.accounts set integration=integration-'channelIdentityLookup' where platform='youtube' and integration ? 'channelIdentityLookup'
  and private.channel_metadata_instant(integration->'channelIdentityLookup'->>'checkedAt')<now()-interval '29 days';
 get diagnostics m=row_count;
 if n+m>0 then update private.dashboard_revision set revision=revision+1 where id=true;end if;
 return result;
end;$$;
revoke all on function public.sweep_provider_retention() from public,anon,authenticated;
grant execute on function public.sweep_provider_retention() to service_role;
commit;
