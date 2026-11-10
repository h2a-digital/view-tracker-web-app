-- Incremental presentation-cache retention only. No new columns, identity or financial changes.
-- Apply after 202611090003_social_profiles.sql. Never rerun the original schema migration.
begin;
set local lock_timeout = '5s';
alter function public.sweep_provider_retention() set schema private;
alter function private.sweep_provider_retention() rename to sweep_provider_retention_before_post_thumbnails;
revoke all on function private.sweep_provider_retention_before_post_thumbnails() from public,anon,authenticated,service_role;
create function public.sweep_provider_retention() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; removed integer;
begin
 -- Match dashboard writers' lock order and optimistic revision fence.
 perform 1 from private.dashboard_revision where id=true for update;
 result:=private.sweep_provider_retention_before_post_thumbnails();
 update public.posts set tracking=tracking-'thumbnail'
 where tracking ? 'thumbnail' and
   (private.channel_metadata_instant(tracking->'thumbnail'->>'capturedAt') is null
    or private.channel_metadata_instant(tracking->'thumbnail'->>'capturedAt')<=now()-interval '29 days');
 get diagnostics removed=row_count;
 if removed>0 then update private.dashboard_revision set revision=revision+1 where id=true;end if;
 return result || jsonb_build_object('thumbnailsExpired',removed);
end;$$;
revoke all on function public.sweep_provider_retention() from public,anon,authenticated;
grant execute on function public.sweep_provider_retention() to service_role;
commit;
