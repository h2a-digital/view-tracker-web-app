import { browserDashboard } from '@/domain/read-model';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, requireSameOrigin, adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { lookupYouTubeMetadata } from '@/services/youtube/metadata';
import { apiError } from '@/lib/server/http';
const input = z.object({ accountIds: z.array(z.uuid()).min(1).max(50) }).strict();
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const { accountIds } = input.parse(await request.json());
    const { data } = await loadDashboard();
    const targets = data.accounts.filter(
      (a) =>
        accountIds.includes(a.id) &&
        a.platform === 'youtube' &&
        !a.archived &&
        !a.integration?.sourceErasedAt
    );
    if (targets.length !== new Set(accountIds).size)
      throw new Error('Select available, non-archived YouTube accounts.');
    const results = await lookupYouTubeMetadata(data, targets);
    for (const result of results) {
      if (result.status === 'cached' || result.status === 'credentials_required') continue;
      const account = targets.find((a) => a.id === result.accountId)!;
      const saved = await adminDatabase().rpc('cache_youtube_channel_identity', {
        target_account: account.id,
        expected_username: account.username,
        expected_channel: account.provider_account_id,
        identity: result.identity ?? null,
        lookup_status: result.status,
      });
      if (saved.error)
        throw new Error(
          'Could not persist channel details. Apply the YouTube metadata migration and retry.'
        );
      if (!saved.data) {
        result.status = 'changed';
        delete result.identity;
        result.message = 'The account changed during lookup. Refresh and retry.';
      }
    }
    const refreshed = await loadDashboard();
    return NextResponse.json(
      {
        ...refreshed,
        data: browserDashboard(refreshed.data),
        results: results.map(({ accountId, status, message }) => ({ accountId, status, message })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
