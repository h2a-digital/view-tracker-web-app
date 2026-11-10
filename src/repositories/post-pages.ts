import 'server-only';
import { adminDatabase } from '@/lib/server/supabase';
import type { PostPageQuery, PostPage } from '@/domain/post-pages';
export async function readPostPage(query: PostPageQuery): Promise<PostPage> {
  const { data, error } = await adminDatabase().rpc('read_post_page', {
    requested_page: query.page,
    requested_size: query.pageSize,
    filter_app: query.app === 'all' ? null : query.app,
    filter_campaign: query.campaign === 'all' ? null : query.campaign,
    search_text: query.search,
    sort_order: query.sort,
    target_post: query.postId ?? null,
  });
  if (error)
    throw new Error(
      error.code === '42883' || error.code === 'PGRST202'
        ? 'Apply the additive post-pagination migration before using Posts.'
        : 'Could not read posts. Please retry.'
    );
  return JSON.parse(JSON.stringify(data), (key, value) =>
    [
      'published_at',
      'deadline',
      'accepted_at',
      'observed_at',
      'provider_updated_at',
      'source_erased_at',
    ].includes(key) && typeof value === 'string'
      ? new Date(value).toISOString()
      : value
  ) as PostPage;
}
