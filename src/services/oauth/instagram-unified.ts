import 'server-only';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { oauthConfig, scopes } from './config';
import { providerJson } from './http';
import type { TokenBundle } from './tokens';
import { rejectCallback, type CallbackTrace } from './diagnostics';
const id = z.string().regex(/^\d+$/);
/** Fixed-host cursor pagination; never follow an API-supplied URL. No message calls. */
export async function assignedInstagramAccounts(
  origin: string,
  request: (url: string) => Promise<unknown>
) {
  const accounts: { id: string; username: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      fields: 'id,username',
      limit: '100',
      ...(after ? { after } : {}),
    });
    const result = z
      .object({
        data: z.array(z.object({ id, username: z.string().min(1) })),
        paging: z
          .object({
            next: z.string().optional(),
            cursors: z.object({ after: z.string().optional() }).optional(),
          })
          .optional(),
      })
      .parse(await request(`${origin}/me/assigned_instagram_accounts?${query}`));
    accounts.push(...result.data);
    if (!result.paging?.next) return accounts;
    after = result.paging.cursors?.after;
    if (!after) throw new Error('Instagram account pagination is incomplete.');
  }
  throw new Error('Instagram account selection exceeds the connection budget.');
}
export async function resolveUnifiedInstagram(
  code: string,
  username: string,
  existingId: string | null,
  deadline: number,
  trace: CallbackTrace
) {
  const c = oauthConfig('instagram', 'unified_login');
  const origin = `https://graph.facebook.com/${c.version}`;
  trace.stage = 'instagram_unified_exchange';
  const token = z
    .object({
      access_token: z.string().min(1),
      expires_in: z.number().int().nonnegative().optional(),
    })
    .parse(
      await providerJson(
        `${origin}/oauth/access_token?${new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          redirect_uri: c.redirectUri,
          code,
        })}`,
        {},
        deadline
      )
    );
  trace.stage = 'instagram_unified_token_validation';
  const debug = z
    .object({
      data: z.object({
        app_id: z.string(),
        is_valid: z.boolean(),
        user_id: id,
        scopes: z.array(z.string()),
        expires_at: z.number().int().nonnegative(),
        data_access_expires_at: z.number().int().nonnegative().optional(),
      }),
    })
    .parse(
      await providerJson(
        `${origin}/debug_token?${new URLSearchParams({ input_token: token.access_token })}`,
        { headers: { Authorization: `Bearer ${c.clientId}|${c.clientSecret}` } },
        deadline
      )
    ).data;
  if (!debug.is_valid || debug.app_id !== c.clientId)
    rejectCallback(
      trace,
      'instagram_unified_token_invalid',
      'Instagram grant is invalid or belongs to a different app.'
    );
  if (scopes('instagram', 'unified_login').some((scope) => !debug.scopes.includes(scope)))
    rejectCallback(
      trace,
      'required_scopes_missing',
      'The configured Instagram permissions were not granted.'
    );
  if (
    debug.scopes.some(
      (scope) => ![...scopes('instagram', 'unified_login'), 'public_profile'].includes(scope)
    )
  )
    rejectCallback(
      trace,
      'instagram_configuration_permissions_changed',
      'The Instagram configuration requests unexpected permissions. Contact the administrator.'
    );
  const expirations = [
    debug.expires_at,
    debug.data_access_expires_at ?? 0,
    token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : 0,
  ].filter((value) => value > 0);
  const expiresAt = expirations.length
    ? new Date(Math.min(...expirations) * 1000).toISOString()
    : null;
  if (expiresAt && Date.parse(expiresAt) <= Date.now())
    rejectCallback(
      trace,
      'instagram_unified_token_expired',
      'Instagram authorization has expired.'
    );
  const request = (url: string) => {
    const target = new URL(url);
    target.searchParams.set(
      'appsecret_proof',
      createHmac('sha256', c.clientSecret).update(token.access_token).digest('hex')
    );
    return providerJson(
      target.toString(),
      { headers: { Authorization: `Bearer ${token.access_token}` } },
      deadline
    );
  };
  trace.stage = 'instagram_unified_identity';
  const identity = z
    .object({ id, client_business_id: id })
    .parse(await request(`${origin}/me?fields=id,client_business_id`));
  trace.stage = 'instagram_unified_accounts';
  const accounts = await assignedInstagramAccounts(origin, request);
  const normal = (value: string) => value.replace(/^@/, '').toLowerCase();
  const match = accounts.find(
    (account) =>
      normal(account.username) === normal(username) && (!existingId || account.id === existingId)
  );
  if (!match)
    rejectCallback(
      trace,
      'registered_instagram_mismatch',
      'The registered Instagram account was not shared. Select the correct business portfolio and account.'
    );
  return {
    resourceId: match.id,
    bundle: {
      accessToken: token.access_token,
      authMode: 'unified_login',
      actorId: identity.id,
      deletionSubjectId: debug.user_id,
      clientBusinessId: identity.client_business_id,
      configId: c.loginConfigId,
      issuedAt: new Date().toISOString(),
      expiresAt,
      scopes: debug.scopes,
    } satisfies TokenBundle,
  };
}
