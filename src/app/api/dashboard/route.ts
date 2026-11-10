import { browserDashboard } from '@/domain/read-model';
import { NextResponse } from 'next/server';
import { requireAdmin, requireSameOrigin } from '@/lib/server/supabase';
import { loadDashboard, saveDashboard } from '@/repositories/dashboard';
import { lookupYouTubeMetadata } from '@/services/youtube/metadata';
import { runCommand } from '@/domain/commands';
export const dynamic = 'force-dynamic';
import { apiError } from '@/lib/server/http';
export async function GET() {
  try {
    await requireAdmin();
    const state = await loadDashboard();
    return NextResponse.json(
      {
        data: browserDashboard(state.data),
        revision: state.revision,
        asOf: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAdmin();
    if (Number(request.headers.get('content-length') || 0) > 2000000)
      throw new Error('Request exceeds the 2 MB limit.');
    const raw = await request.text();
    if (raw.length > 2000000) throw new Error('Request exceeds the 2 MB limit.');
    const command = JSON.parse(raw);
    const { data, revision } = await loadDashboard();
    const next = runCommand(data, command, user.email);
    let notice: string | undefined;
    if (command.type === 'registerAccount' && command.platform === 'youtube') {
      const account = next.accounts.find((a) => !data.accounts.some((old) => old.id === a.id))!;
      const [metadata] = await lookupYouTubeMetadata(next, [account], Date.now() + 12000);
      if (metadata?.identity)
        account.integration = { ...account.integration, channelIdentity: metadata.identity };
      if (metadata && metadata.status !== 'credentials_required')
        account.integration = {
          ...account.integration,
          channelIdentityLookup: { checkedAt: new Date().toISOString(), status: metadata.status },
        };
      if (!metadata?.identity)
        notice =
          'Account registered. Channel details are unavailable; use Refresh YouTube details after checking credentials.';
    }
    await saveDashboard(next, revision);
    return NextResponse.json(
      {
        data: browserDashboard(next),
        revision: revision + 1,
        notice,
        asOf: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
