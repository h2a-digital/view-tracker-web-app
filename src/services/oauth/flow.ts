import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { adminDatabase } from '@/lib/server/supabase';
import { assertLiveDeployment, hostedDeployment } from '@/lib/server/deployment';
import { configuration } from '@/lib/server/config';
import { loadDashboard } from '@/repositories/dashboard';
import type { DashboardData, SocialAccount } from '@/domain/model';
import { digest, nonce, seal, unseal } from './crypto';
import {
  directPlatform,
  oauthConfig,
  scopes,
  youtubePolicyApproved,
  type DirectPlatform,
} from './config';
import { providerJson } from './http';
import { subjectFingerprint } from '@/services/lifecycle/identity';
import { exchangeGoogle, type TokenBundle } from './tokens';
import { consentPage } from './consent-page';
import {
  rejectCallback,
  reportCallbackFailure,
  callbackDatabaseError,
  type CallbackTrace,
} from './diagnostics';
const cookieName = 'ugc_creator_oauth';
const validNonce = (v: string | null | undefined): v is string => !!v && /^[a-f0-9]{64}$/.test(v);
const normal = (s: string) => s.trim().replace(/^@/, '').toLowerCase();
const googleChannels = z.object({
  items: z.array(
    z.object({ id: z.string(), snippet: z.object({ customUrl: z.string().optional() }) })
  ),
});
const pagesSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      access_token: z.string(),
      tasks: z.array(z.string()).optional(),
      instagram_business_account: z.object({ id: z.string(), username: z.string() }).optional(),
    })
  ),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
export async function directConnectionAction(
  account: SocialAccount,
  data: DashboardData,
  revision: number,
  action: string
) {
  const platform = directPlatform(account.platform),
    db = adminDatabase();
  if (action === 'deletion-link') {
    const ticket = nonce(),
      result = await db.rpc('create_deletion_link', {
        target_account: account.id,
        token_hash: digest(ticket),
      });
    if (result.error) throw new Error('Could not create deletion link.');
    return NextResponse.json({
      authUrl: new URL(
        `/integrations/delete-data/request?ticket=${ticket}`,
        configuration().siteUrl
      ).toString(),
      expiresIn: 90 * 86400,
    });
  }
  if (action === 'disconnect') {
    account.status = 'disconnected';
    account.error = null;
    data.audit.unshift({
      id: crypto.randomUUID(),
      action: 'disconnect',
      entity_id: account.id,
      detail:
        'Direct OAuth credentials removed; synchronization stopped. Historical records retained subject to provider deletion obligations.',
      created_at: new Date().toISOString(),
    });
    const result = await db.rpc('disconnect_direct_account', {
      target_account: account.id,
      expected_revision: revision,
      document: data,
    });
    if (result.error) throw new Error('Could not disconnect safely. Refresh and retry.');
    return NextResponse.json({ ok: true });
  }
  if (account.integration?.sourceErasedAt)
    throw new Error('Create a new registered account and fresh consent after erasure.');
  if (action !== 'connect') throw new Error('Unsupported connection action.');
  oauthConfig(platform);
  const token = nonce();
  seal({}, 'key-check');
  const result = await db.rpc('create_oauth_invite', {
    hash: digest(token),
    target_account: account.id,
    target_platform: platform,
  });
  if (result.error)
    throw new Error(
      'Could not create a creator invitation. Check the direct integrations migration.'
    );
  const url = new URL(`/api/oauth/${platform}/start`, configuration().siteUrl);
  url.searchParams.set('ticket', token);
  return NextResponse.json({
    authUrl: url.toString(),
    expiresIn: 1800,
    message: 'Share this expiring link with the registered creator. It grants no dashboard access.',
  });
}
export async function startOAuth(request: Request, value: string) {
  assertLiveDeployment();
  const platform = directPlatform(value),
    c = oauthConfig(platform),
    ticket = new URL(request.url).searchParams.get('ticket');
  if (!validNonce(ticket)) throw new Error('Invalid invitation.');
  const db = adminDatabase(),
    { data: invite, error } = await db.rpc('read_oauth_invite', { hash: digest(ticket) });
  if (error || !invite || invite.platform !== platform)
    throw new Error('Invitation expired. Request a new link.');
  const state = nonce(),
    browser = nonce(),
    verifier = nonce();
  const stored = await db.rpc('start_oauth_flow', {
    invite_hash: digest(ticket),
    state_hash: digest(state),
    browser_hash: digest(browser),
    encrypted_verifier: seal(verifier, digest(state)),
  });
  if (stored.error) throw new Error('Could not start authorization.');
  const url = new URL(
    platform === 'youtube'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : `https://www.facebook.com/${c.version}/dialog/oauth`
  );
  url.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: scopes(platform).join(platform === 'youtube' ? ' ' : ','),
    state,
    ...(platform === 'youtube'
      ? {
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }
      : { auth_type: 'rerequest', ...(c.loginConfigId ? { config_id: c.loginConfigId } : {}) }),
  }).toString();
  const response = NextResponse.redirect(url, 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.cookies.set(cookieName, browser, {
    httpOnly: true,
    secure: hostedDeployment(),
    sameSite: 'lax',
    path: '/api/oauth',
    maxAge: 900,
  });
  return response;
}
export async function oauthInvitation(request: Request, value: string) {
  assertLiveDeployment();
  const platform = directPlatform(value),
    ticket = new URL(request.url).searchParams.get('ticket');
  oauthConfig(platform);
  if (!validNonce(ticket)) throw new Error('Invalid invitation.');
  const { data, error } = await adminDatabase().rpc('read_oauth_invite', { hash: digest(ticket) });
  if (error || !data || data.platform !== platform) throw new Error('Invitation expired.');
  return consentPage(platform, ticket);
}
async function resolveMeta(
  platform: DirectPlatform,
  code: string,
  username: string,
  deadline: number
) {
  const c = oauthConfig(platform),
    origin = `https://graph.facebook.com/${c.version}`;
  const first = z
    .object({ access_token: z.string() })
    .parse(
      await providerJson(
        `${origin}/oauth/access_token?${new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: c.redirectUri })}`,
        {},
        deadline
      )
    );
  const token = z
    .object({ access_token: z.string() })
    .parse(
      await providerJson(
        `${origin}/oauth/access_token?${new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'fb_exchange_token', fb_exchange_token: first.access_token })}`,
        {},
        deadline
      )
    );
  const auth = { headers: { Authorization: `Bearer ${token.access_token}` } };
  const permissions = z
    .object({ data: z.array(z.object({ permission: z.string(), status: z.string() })) })
    .parse(
      await providerJson(
        `${origin}/me/permissions?appsecret_proof=${appSecretProof(token.access_token, c.clientSecret)}`,
        auth,
        deadline
      )
    );
  if (
    scopes(platform).some(
      (scope) => !permissions.data.some((p) => p.permission === scope && p.status === 'granted')
    )
  )
    throw new Error('Required read permissions were not granted.');
  const actor = z
    .object({ id: z.string() })
    .parse(
      await providerJson(
        `${origin}/me?fields=id&appsecret_proof=${appSecretProof(token.access_token, c.clientSecret)}`,
        auth,
        deadline
      )
    );
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      fields:
        platform === 'instagram'
          ? 'id,access_token,tasks,instagram_business_account{id,username}'
          : 'id,access_token,tasks',
      limit: '100',
      ...(after ? { after } : {}),
    });
    const result = pagesSchema.parse(
      await providerJson(
        `${origin}/me/accounts?${query}&appsecret_proof=${appSecretProof(token.access_token, c.clientSecret)}`,
        auth,
        deadline
      )
    );
    const match = result.data.find((p) =>
      platform === 'facebook'
        ? p.id === username
        : normal(p.instagram_business_account?.username || '') === normal(username)
    );
    if (
      match &&
      !match.tasks?.some((task) =>
        ['ANALYZE', 'PROFILE_PLUS_ANALYZE', 'MANAGE', 'PROFILE_PLUS_FULL_CONTROL'].includes(task)
      )
    )
      throw new Error('The authorizing user lacks Page analytics access.');
    if (match)
      return {
        resourceId: platform === 'facebook' ? match.id : match.instagram_business_account!.id,
        bundle: {
          accessToken: match.access_token,
          expiresAt: null,
          scopes: scopes(platform),
          actorId: actor.id,
          revocationToken: token.access_token,
        } satisfies TokenBundle,
      };
    after = result.paging?.cursors?.after;
    if (!result.paging?.next || !after) break;
  }
  throw new Error(
    'The registered Page or linked professional Instagram account was not authorized.'
  );
}
export async function finishOAuth(request: Request, value: string) {
  const trace: CallbackTrace = { stage: 'configuration', platform: 'unknown' };
  try {
    return await completeOAuth(request, value, trace);
  } catch (error) {
    throw reportCallbackFailure(trace, error);
  }
}
async function completeOAuth(request: Request, value: string, trace: CallbackTrace) {
  assertLiveDeployment();
  const deadline = Date.now() + 45000;
  const platform = directPlatform(value),
    url = new URL(request.url),
    state = url.searchParams.get('state'),
    code = url.searchParams.get('code');
  trace.platform = platform;
  trace.stage = 'request_validation';
  if (url.searchParams.has('error'))
    rejectCallback(trace, 'provider_denied', 'Authorization was denied. Request a new invitation.');
  if (!validNonce(state))
    rejectCallback(
      trace,
      'state_parameter_invalid',
      'Authorization state is invalid. Request a new invitation.'
    );
  if (!code || code.length > 4096)
    rejectCallback(
      trace,
      'authorization_code_missing_or_invalid',
      'Authorization code is missing or invalid. Request a new invitation.'
    );
  trace.stage = 'browser_cookie';
  const browser = (await cookies()).get(cookieName)?.value;
  if (!validNonce(browser))
    rejectCallback(
      trace,
      browser ? 'browser_cookie_invalid' : 'browser_cookie_missing',
      'Authorization browser state is missing or invalid. Request a new invitation.'
    );
  trace.stage = 'flow_lookup';
  const db = adminDatabase(),
    hash = digest(state),
    flow = await db.rpc('read_oauth_flow', { hash });
  if (flow.error) {
    callbackDatabaseError(trace, flow.error);
    rejectCallback(trace, trace.reason!, 'Could not read authorization state.');
  }
  trace.stage = 'flow_validation';
  if (!flow.data)
    rejectCallback(trace, 'flow_expired_or_consumed', 'Authorization state is invalid or expired.');
  if (flow.data.platform !== platform)
    rejectCallback(trace, 'flow_platform_mismatch', 'Authorization state is invalid or expired.');
  if (flow.data.browser_hash !== digest(browser))
    rejectCallback(trace, 'browser_state_mismatch', 'Authorization state is invalid or expired.');
  trace.stage = 'dashboard_load';
  const initial = await loadDashboard(),
    registered = initial.data.accounts.find(
      (a) => a.id === flow.data.account_id && a.provider === 'direct' && a.platform === platform
    );
  trace.stage = 'registered_account';
  if (!registered)
    rejectCallback(trace, 'registered_account_missing', 'Registered account is unavailable.');
  let resourceId: string, bundle: TokenBundle;
  if (platform === 'youtube') {
    trace.stage = 'verifier_decryption';
    const verifier = unseal<string>(flow.data.verifier, hash);
    trace.stage = 'google_token_exchange';
    bundle = await exchangeGoogle(code, verifier, deadline, trace);
    trace.stage = 'google_scope_validation';
    trace.youtubeReadGranted = bundle.scopes.includes(scopes(platform)[0]);
    trace.youtubeAnalyticsGranted = bundle.scopes.includes(scopes(platform)[1]);
    if (!trace.youtubeReadGranted || !trace.youtubeAnalyticsGranted)
      rejectCallback(
        trace,
        'required_scopes_missing',
        'Both read-only YouTube permissions are required.'
      );
    trace.stage = 'google_channel_lookup';
    const result = googleChannels.parse(
      await providerJson(
        'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
        { headers: { Authorization: `Bearer ${bundle.accessToken}` } },
        deadline
      )
    );
    trace.authorizedChannelCount = result.items.length;
    let match = result.items.find(
      (item) =>
        item.id === registered.username ||
        normal(item.snippet.customUrl || '') === normal(registered.username)
    );
    // customUrl can be a legacy alias or absent. Resolve an actual handle to its
    // immutable ID, then require that ID in the authorized mine=true result.
    if (!match && result.items.length && !/^UC[A-Za-z0-9_-]{22}$/.test(registered.username)) {
      trace.stage = 'google_handle_resolution';
      let resolved: z.infer<typeof googleChannels>;
      try {
        const query = new URLSearchParams({ part: 'id,snippet', forHandle: registered.username });
        resolved = googleChannels.parse(
          await providerJson(
            `https://www.googleapis.com/youtube/v3/channels?${query}`,
            { headers: { Authorization: `Bearer ${bundle.accessToken}` } },
            deadline
          )
        );
      } catch (error) {
        // Keep existing rejection semantics; provider errors remain safely classified.
        if (error instanceof Error && error.name === 'ZodError')
          trace.reason = 'channel_response_invalid';
        throw error;
      }
      match = result.items.find((item) => resolved.items.some((target) => target.id === item.id));
    }
    trace.stage = 'google_channel_match';
    if (!match)
      rejectCallback(
        trace,
        result.items.length ? 'registered_channel_mismatch' : 'authorized_channel_missing',
        'A different YouTube channel was authorized.'
      );
    resourceId = match.id;
  } else {
    trace.stage = 'meta_authorization';
    ({ resourceId, bundle } = await resolveMeta(platform, code, registered.username, deadline));
  }
  // Reload after external requests; optimistic commit + one-use state remain atomic.
  trace.stage = 'dashboard_reload';
  const { data, revision } = await loadDashboard(),
    account = data.accounts.find((a) => a.id === registered.id);
  trace.stage = 'account_revalidation';
  if (!account || account.username !== registered.username || account.provider !== 'direct')
    rejectCallback(
      trace,
      'registered_account_changed',
      'The registered account changed. Request a new invitation.'
    );
  account.provider_account_id = resourceId;
  account.status = 'connected';
  account.error = null;
  account.last_synced_at = null;
  account.integration = {
    payoutsBlocked: platform === 'youtube' && !youtubePolicyApproved(),
    policyReason:
      platform === 'youtube' && !youtubePolicyApproved()
        ? 'YouTube analytics policy approval required before compensation.'
        : undefined,
    tokenExpiresAt: bundle.expiresAt,
  };
  data.audit.unshift({
    id: crypto.randomUUID(),
    action: 'connect',
    entity_id: account.id,
    detail: `${platform} read-only OAuth identity verified. No dashboard access granted.`,
    created_at: new Date().toISOString(),
  });
  const deletionTicket = nonce();
  trace.stage = 'token_encryption';
  const encryptedToken = seal(bundle, account.id);
  const subject = subjectFingerprint(
    platform === 'youtube' ? 'google' : 'meta',
    bundle.actorId || resourceId
  );
  trace.stage = 'database_commit';
  const committed = await db.rpc('commit_direct_connection', {
    hash,
    expected_browser_hash: digest(browser),
    expected_revision: revision,
    document: data,
    encrypted_token: encryptedToken,
    subject_fingerprint: subject,
    deletion_hash: digest(deletionTicket),
  });
  if (committed.error) {
    callbackDatabaseError(trace, committed.error);
    rejectCallback(
      trace,
      trace.reason!,
      'Could not save authorization safely. Request a new invitation.'
    );
  }
  trace.stage = 'response';
  const deletionUrl = new URL(
    `/integrations/delete-data/request?ticket=${deletionTicket}`,
    configuration().siteUrl
  ).toString();
  const response = new NextResponse(
    `<!doctype html><html><head><title>Account connected</title></head><body><h1>Account connected</h1><p>You have not been granted dashboard access. The administrator manages tracking and payouts.</p><p>Bookmark this private <a href="${deletionUrl}">delete connection and source data link</a> (valid for 90 days). Deletion removes Creator Ledger data, not your platform videos. You can also revoke access in provider settings or contact the administrator.</p></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    }
  );
  response.cookies.set(cookieName, '', { path: '/api/oauth', maxAge: 0 });
  return response;
}
export function oauthMessage(message: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><title>Creator Ledger connection</title></head><body><h1>Creator Ledger</h1><p>${message.replace(/[<>&"']/g, '')}</p></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    }
  );
}
export function appSecretProof(token: string, secret: string) {
  return createHmac('sha256', secret).update(token).digest('hex');
}
