import { browserDashboard } from '@/domain/read-model';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, requireSameOrigin } from '@/lib/server/supabase';
import { thumbnailPersistenceAllowed } from '@/lib/server/thumbnail-policy';
import { loadDashboard, saveDashboard } from '@/repositories/dashboard';
import { trackingProvider } from '@/services/tracking/registry';
import { loadMissingThumbnails } from '@/services/tracking/thumbnail-refresh';
import { withThumbnailOverrides } from '@/domain/thumbnail-overrides';
import { zernioInstagramEnabled } from '@/services/tracking/zernio';
import { apiError } from '@/lib/server/http';
export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const { accountId } = z
      .object({ accountId: z.uuid() })
      .strict()
      .parse(await request.json());
    const state = await loadDashboard();
    const account = state.data.accounts.find(
      (a) =>
        a.id === accountId &&
        !a.archived &&
        a.status === 'connected' &&
        !a.integration?.sourceErasedAt
    );
    if (
      !account ||
      account.provider !== 'zernio' ||
      !account.provider_account_id ||
      !['tiktok', 'instagram'].includes(account.platform)
    )
      throw new Error('Connect a supported Zernio account before loading previews.');
    if (account.platform === 'instagram' && !zernioInstagramEnabled())
      throw new Error('Instagram/Zernio is disabled.');
    const fetched = await loadMissingThumbnails(
      state.data,
      account,
      trackingProvider(account, Date.now() + 10000)
    );
    // Re-read after the provider call: local preview mode must honor concurrent source erasure too.
    const current = await loadDashboard();
    const connected = current.data.accounts.find((a) => a.id === accountId);
    if (
      !connected ||
      connected.status !== 'connected' ||
      connected.archived ||
      connected.integration?.sourceErasedAt ||
      connected.provider !== account.provider ||
      connected.platform !== account.platform ||
      connected.provider_account_id !== account.provider_account_id ||
      connected.provider_profile_id !== account.provider_profile_id ||
      connected.creator_id !== account.creator_id
    )
      throw new Error('The connected account changed. Refresh before loading previews again.');
    const overrides = fetched.overrides.filter((value) =>
      current.data.posts.some(
        (post) =>
          post.id === value.postId &&
          post.account_id === value.accountId &&
          post.platform_post_id === value.platformPostId &&
          !post.deleted &&
          !post.source_erased_at
      )
    );
    const asOf = new Date().toISOString();
    const data = withThumbnailOverrides(current.data, overrides, Date.parse(asOf));
    const persist = thumbnailPersistenceAllowed();
    // The existing revision fence rejects concurrent changes. It never overwrites a newer source deletion or account edit.
    if (persist && overrides.length) await saveDashboard(data, current.revision);
    return NextResponse.json(
      {
        data: browserDashboard(data),
        asOf,
        overrides,
        result: {
          mode: persist ? 'database' : 'session',
          available: overrides.length,
          requested: fetched.requested,
          unavailable: fetched.deferred ? 0 : fetched.requested - overrides.length,
          deferred: fetched.deferred,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
