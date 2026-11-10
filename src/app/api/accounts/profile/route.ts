import { browserDashboard } from '@/domain/read-model';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, requireSameOrigin, adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { zernioInstagramEnabled } from '@/services/tracking/zernio';
import { refreshProfile } from '@/services/profiles/metadata';
import { apiError } from '@/lib/server/http';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const { accountId } = z
      .object({ accountId: z.uuid() })
      .strict()
      .parse(await request.json());
    const { data } = await loadDashboard();
    const account = data.accounts.find(
      (a) => a.id === accountId && !a.archived && !a.integration?.sourceErasedAt
    );
    if (
      !account ||
      !(
        account.platform === 'youtube' ||
        (account.status === 'connected' &&
          ((account.provider === 'zernio' && ['tiktok', 'instagram'].includes(account.platform)) ||
            (account.provider === 'direct' && account.platform === 'instagram')))
      )
    )
      throw new Error('Connect a supported account before refreshing profile details.');
    if (
      account.platform === 'instagram' &&
      account.provider === 'zernio' &&
      !zernioInstagramEnabled()
    )
      throw new Error(
        'Instagram/Zernio is disabled. Enable the existing pilot setting before refreshing its profile.'
      );
    const result = await refreshProfile(adminDatabase(), Date.now() + 15000, accountId);
    const refreshed = await loadDashboard();
    return NextResponse.json(
      { ...refreshed, data: browserDashboard(refreshed.data), result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
