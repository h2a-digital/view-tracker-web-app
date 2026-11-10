import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdmin, requireSameOrigin, adminDatabase } from '@/lib/server/supabase';
import { configuration } from '@/lib/server/config';
import { loadDashboard, saveDashboard } from '@/repositories/dashboard';
import { remoteId, ZernioProvider, zernioInstagramEnabled } from '@/services/tracking/zernio';
import { directConnectionAction } from '@/services/oauth/flow';
import { apiError } from '@/lib/server/http';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const { accountId, action, confirmShared } = await request.json();
    const { data, revision } = await loadDashboard();
    const account = data.accounts.find((a) => a.id === accountId);
    if (account?.provider === 'direct') {
      if (action === 'disconnect') {
        const impact = await adminDatabase().rpc('get_disconnect_impact', {
          target_account: account.id,
        });
        if (impact.error)
          throw new Error(
            'Apply the dashboard management migration before disconnecting direct accounts.'
          );
        if (!Array.isArray(impact.data))
          throw new Error('Could not verify shared-grant impact. No disconnection was performed.');
        if (impact.data.length && confirmShared !== true)
          throw new Error(
            'Other accounts share this provider grant. Review and explicitly confirm their disconnection.'
          );
      }
      return await directConnectionAction(account, data, revision, action);
    }
    if (
      !account ||
      !['tiktok', 'instagram'].includes(account.platform) ||
      account.provider !== 'zernio'
    )
      throw new Error('Select a registered TikTok or Instagram account using Zernio.');
    const provider = new ZernioProvider(undefined, account.platform as 'tiktok' | 'instagram');
    if (action === 'disconnect') {
      if (account.provider_account_id) await provider.disconnect(account.provider_account_id);
      account.status = 'disconnected';
      account.error = null;
      account.provider_account_id = null;
      data.audit.unshift({
        id: crypto.randomUUID(),
        action: 'disconnect',
        entity_id: account.id,
        detail:
          'Disconnected at Zernio. Historical observations remain subject to retention policy.',
        created_at: new Date().toISOString(),
      });
      await saveDashboard(data, revision);
      return NextResponse.json({ ok: true });
    }
    if (account.archived) throw new Error('Restore this archived account before connecting.');
    if (action !== 'connect') throw new Error('Unsupported connection action.');
    if (account.platform === 'instagram' && !zernioInstagramEnabled())
      throw new Error('Instagram/Zernio is disabled. Enable ZERNIO_INSTAGRAM_ENABLED for testing.');
    const remote = await provider.listAccounts();
    const existing = remote.find((a) => {
      const p = a.profileId;
      const profile = typeof p === 'string' ? p : (p?._id ?? p?.id);
      return (
        a.platform === account.platform &&
        profile === account.provider_profile_id &&
        a.username.replace(/^@/, '').toLowerCase() === account.username.toLowerCase()
      );
    });
    const reconnectId = account.provider_account_id || (existing ? remoteId(existing) : undefined);
    if (remote.length >= 2 && !reconnectId)
      throw new Error(
        'The two-account free allowance is full. Disconnect an existing provider account before connecting another. No paid upgrade will be made.'
      );
    const profile =
      account.provider_profile_id || (await provider.createProfile(`UGC · ${account.username}`));
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const { error } = await adminDatabase().rpc('store_connection', {
      hash,
      target_account: account.id,
      target_profile: profile,
      remote_count: remote.length,
      reconnecting: !!reconnectId,
    });
    if (error) throw new Error('Connection links are already pending. Retry after they expire.');
    const callback = new URL('/api/connections/callback', configuration().siteUrl);
    callback.searchParams.set('ticket', token);
    const authUrl = await provider.connectUrl(
      profile,
      callback.toString(),
      account.username,
      reconnectId
    );
    account.provider_profile_id = profile;
    await saveDashboard(data, revision);
    return NextResponse.json({
      authUrl,
      expiresIn: 1800,
      message: `This link only authorizes the selected ${account.platform} account; it does not grant dashboard access.`,
    });
  } catch (error) {
    return apiError(error);
  }
}
