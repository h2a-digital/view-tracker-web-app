-- Additive read-only pagination; existing data, financial guards and write RPCs are unchanged.
begin;
set local lock_timeout='5s';
create index if not exists posts_publication_page_idx on public.posts(published_at desc,id desc);
create index if not exists posts_campaign_page_idx on public.posts(campaign_id,published_at desc,id desc);
create index if not exists posts_account_page_idx on public.posts(account_id,published_at desc,id desc);
create index if not exists snapshots_public_page_idx on public.snapshots(post_id,observed_at desc,id desc)
 where metric='public_views' and provenance->>'kind' is distinct from 'daily' and provenance->>'supporting' is distinct from 'true';
create function public.read_post_page(requested_page integer default 1,requested_size integer default 24,
 filter_app uuid default null,filter_campaign uuid default null,search_text text default '',sort_order text default 'newest',target_post uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if requested_page<1 or requested_page>1000000 or requested_size not in(12,24,48) or sort_order not in('newest','oldest','views') or length(search_text)>200 then raise exception 'Invalid pagination parameters';end if;
 with filtered as materialized (
   select p.*,case when a.integration->>'payoutsBlocked'='true' or p.source_erased_at is not null or p.deleted then null else latest.views end sort_views
   from public.posts p join public.creators c on c.id=p.creator_id join public.accounts a on a.id=p.account_id
   left join lateral(select s.views from public.snapshots s where s.post_id=p.id and s.metric='public_views' and s.provenance->>'kind' is distinct from 'daily' and s.provenance->>'supporting' is distinct from 'true' order by s.observed_at desc,s.id desc limit 1) latest on true
   where (filter_app is null or p.app_id=filter_app) and (filter_campaign is null or p.campaign_id=filter_campaign)
     and (target_post is null or p.id=target_post)
     and (search_text='' or position(lower(search_text) in lower(concat_ws(' ',p.caption,p.platform,p.platform_post_id,c.name)))>0)
 ), totals as(select count(*) total from filtered), bounds as(
   select total,greatest(1,least(requested_page,ceil(total::numeric/requested_size)::integer)) page from totals
 ), selected as(
   select f.*,row_number() over(order by case when sort_order='views' then sort_views end desc nulls last,case when sort_order='oldest' then published_at end asc,case when sort_order<>'oldest' then published_at end desc,id desc) ordinal
   from filtered f order by case when sort_order='views' then sort_views end desc nulls last,case when sort_order='oldest' then published_at end asc,case when sort_order<>'oldest' then published_at end desc,id desc
   limit requested_size offset(select (page-1)*requested_size from bounds)
 )
 select jsonb_build_object('page',b.page,'pageSize',requested_size,'total',b.total,
   'posts',coalesce((select jsonb_agg(to_jsonb(s)-'ordinal'-'sort_views' order by ordinal) from selected s),'[]'::jsonb),
   'snapshots',coalesce((select jsonb_agg(to_jsonb(s) order by observed_at,id) from public.snapshots s where s.post_id in(select id from selected)),'[]'::jsonb)) into result from bounds b;
 return result;
end;$$;
revoke all on function public.read_post_page(integer,integer,uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.read_post_page(integer,integer,uuid,uuid,text,text,uuid) to service_role;
commit;
