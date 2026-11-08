import { NextResponse } from 'next/server';
import { requireAdmin, requireSameOrigin, adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { apiError } from '@/lib/server/http';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const { accountId } = await request.json();
    const { data } = await loadDashboard();
    if (
      !data.accounts.some(
        (a) => a.id === accountId && a.status === 'connected' && a.provider !== 'manual'
      )
    )
      throw new Error('Connect an automated account first.');
    const { error } = await adminDatabase().rpc('request_tracking', { target_account: accountId });
    if (error) throw new Error('Could not queue synchronization.');
    return NextResponse.json({
      ok: true,
      message: 'Synchronization queued. The scheduled worker will collect metrics.',
    });
  } catch (error) {
    return apiError(error);
  }
}
