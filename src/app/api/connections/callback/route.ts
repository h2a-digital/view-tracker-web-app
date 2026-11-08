import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { ZernioProvider, remoteId } from '@/services/tracking/zernio';
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get('ticket');
  const fail = (message: string) =>
    new NextResponse(
      `<!doctype html><html><body style="background:#101016;color:#eee;font:16px system-ui;padding:64px"><h1>Connection needs attention</h1><p>${message}</p><p>Ask the administrator for a new connection link.</p></body></html>`,
      {
        status: 400,
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      }
    );
  if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) return fail('This connection link is invalid.');
  if (url.searchParams.has('error'))
    return fail(
      'TikTok authorization did not complete. Ask for a new link and accept every required permission.'
    );
  try {
    const hash = createHash('sha256').update(ticket).digest('hex');
    const db = adminDatabase();
    const { data: session, error } = await db.rpc('read_connection', { hash });
    if (error || !session) return fail('This connection link has expired or was already used.');
    const provider = new ZernioProvider();
    const remote = await provider.listAccounts();
    if (remote.length > 2)
      return fail(
        'The free account allowance was exceeded outside this dashboard. Review connections in Zernio.'
      );
    const id = url.searchParams.get('accountId');
    const connected = remote.find((a) => remoteId(a) === id && a.platform === 'tiktok');
    const profile = connected?.profileId;
    const profileId = typeof profile === 'string' ? profile : (profile?._id ?? profile?.id);
    if (!connected || profileId !== session.profile_id || connected.isActive === false)
      return fail('The provider could not verify the expected account connection.');
    const { data, revision } = await loadDashboard();
    const account = data.accounts.find((a) => a.id === session.account_id);
    if (!account) return fail('The registered account no longer exists.');
    if (
      account.username.toLowerCase().replace(/^@/, '') !==
      connected.username.toLowerCase().replace(/^@/, '')
    )
      return fail(
        'A different TikTok username was authorized. Disconnect it in Zernio and request the correct link.'
      );
    account.provider_account_id = remoteId(connected);
    account.provider_profile_id = session.profile_id;
    account.status = 'connected';
    account.error = null;
    data.audit.unshift({
      id: crypto.randomUUID(),
      action: 'connect',
      entity_id: account.id,
      detail: 'TikTok connection verified against provider account and profile.',
      created_at: new Date().toISOString(),
    });
    const { error: commitError } = await db.rpc('commit_connection', {
      hash,
      expected_revision: revision,
      document: data,
    });
    if (commitError)
      return fail(
        'The connection changed concurrently. Retry this callback once, or request a new link.'
      );
    await db.rpc('request_tracking', { target_account: account.id });
    return new NextResponse(
      '<!doctype html><html><head><title>TikTok connected</title></head><body style="background:#15171e;color:#eceef4;font:16px system-ui;max-width:560px;margin:80px auto;padding:24px"><h1>TikTok account connected</h1><p>Your account is ready for tracking. You can close this window. The administrator will manage posts and compensation in the private dashboard.</p></body></html>',
      {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      }
    );
  } catch {
    return fail('The connection could not be completed. Check setup and request a new link.');
  }
}
