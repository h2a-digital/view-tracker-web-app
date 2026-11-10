import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, requireSameOrigin, adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { ZernioProvider } from '@/services/tracking/zernio';
import { apiError } from '@/lib/server/http';
const input = z
  .object({
    entity: z.enum(['app', 'campaign', 'creator', 'account']),
    id: z.uuid(),
    operation: z.enum(['archive', 'restore', 'remove']),
  })
  .strict();
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const command = input.parse(await request.json());
    const { revision, data } = await loadDashboard();
    const targets = data.accounts.filter((a) =>
      command.entity === 'account'
        ? a.id === command.id
        : command.entity === 'creator' && a.creator_id === command.id
    );
    if (
      command.operation !== 'restore' &&
      targets.some((a) => a.provider === 'zernio' && a.provider_profile_id)
    ) {
      const remote = await new ZernioProvider().listAccounts();
      if (
        targets.some((a) =>
          remote.some((r) => {
            const p = r.profileId;
            return (
              r.platform === a.platform &&
              (typeof p === 'string' ? p : (p?._id ?? p?.id)) === a.provider_profile_id
            );
          })
        )
      )
        throw new Error(
          'A Zernio connection still exists. Disconnect it first and confirm the workspace slot is released.'
        );
    }
    const { error } = await adminDatabase().rpc('manage_dashboard_record', {
      expected_revision: revision,
      entity: command.entity,
      target: command.id,
      operation: command.operation,
    });
    if (error)
      throw new Error(
        error.code === '42883' || error.code === 'PGRST202'
          ? 'Apply the dashboard management migration before using removal or archival.'
          : error.message
      );
    return NextResponse.json(await loadDashboard(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const id = z.uuid().parse(new URL(request.url).searchParams.get('accountId'));
    const { data, error } = await adminDatabase().rpc('get_disconnect_impact', {
      target_account: id,
    });
    if (error)
      throw new Error('Apply the dashboard management migration to inspect shared-grant impact.');
    return NextResponse.json({ accounts: data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
