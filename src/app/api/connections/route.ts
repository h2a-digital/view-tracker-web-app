import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdmin, requireSameOrigin, adminDatabase } from '@/lib/server/supabase';
import { configuration } from '@/lib/server/config';
import { loadDashboard, saveDashboard } from '@/repositories/dashboard';
import { remoteId, ZernioProvider } from '@/services/tracking/zernio';
import { apiError } from '@/lib/server/http';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireAdmin();
    const { accountId, action } = await request.json();
    const { data, revision } = await loadDashboard();
    const account = data.accounts.find((a) => a.id === accountId);
    if (!account || account.platform !== 'tiktok' || account.provider !== 'zernio')
      throw new Error('Select a registered TikTok account using Zernio.');
    const provider = new ZernioProvider();
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
    if (action !== 'connect') throw new Error('Unsupported connection action.');
    const remote = await provider.listAccounts();
    const existing = remote.find((a) => {
      const p = a.profileId;
      const profile = typeof p === 'string' ? p : (p?._id ?? p?.id);
      return (
        a.platform === 'tiktok' &&
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
      message:
        'This link only authorizes the selected TikTok account; it does not grant dashboard access.',
    });
  } catch (error) {
    return apiError(error);
  }
}
