import 'server-only';
import { z } from 'zod';
import { oauthConfig, scopes } from './config';
import { providerJson } from './http';
import type { TokenBundle } from './tokens';
import { rejectCallback, type CallbackTrace } from './diagnostics';
const shortToken = z.object({
  access_token: z.string().min(1),
  user_id: z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    .transform(String),
  permissions: z.union([z.string(), z.array(z.string())]),
});
export const instagramLongToken = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});
export const instagramIdentity = z.object({
  user_id: z.string().regex(/^\d+$/),
  username: z.string().min(1),
});
/** OAuth actor IDs and Graph resource IDs are distinct namespaces. Keep both. */
export async function resolveInstagram(
  code: string,
  username: string,
  deadline: number,
  trace: CallbackTrace
) {
  const c = oauthConfig('instagram', 'instagram_login');
  trace.stage = 'instagram_token_exchange';
  const response = z.union([shortToken, z.object({ data: z.tuple([shortToken]) })]).parse(
    await providerJson(
      'https://api.instagram.com/oauth/access_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: c.redirectUri,
        }).toString(),
      },
      deadline
    )
  );
  const short = 'data' in response ? response.data[0] : response;
  const granted =
    typeof short.permissions === 'string' ? short.permissions.split(/[,\s]+/) : short.permissions;
  trace.stage = 'instagram_scope_validation';
  if (scopes('instagram', 'instagram_login').some((scope) => !granted.includes(scope)))
    rejectCallback(
      trace,
      'required_scopes_missing',
      'Both read-only Instagram permissions are required.'
    );
  trace.stage = 'instagram_long_token_exchange';
  const token = instagramLongToken.parse(
    await providerJson(
      `https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: c.clientSecret, access_token: short.access_token })}`,
      {},
      deadline
    )
  );
  trace.stage = 'instagram_identity';
  const identity = instagramIdentity.parse(
    await providerJson(
      `https://graph.instagram.com/${c.version}/me?fields=user_id,username`,
      { headers: { Authorization: `Bearer ${token.access_token}` } },
      deadline
    )
  );
  const normal = (v: string) => v.replace(/^@/, '').toLowerCase();
  if (normal(identity.username) !== normal(username))
    rejectCallback(
      trace,
      'registered_instagram_mismatch',
      'A different Instagram account was authorized.'
    );
  return {
    resourceId: identity.user_id,
    bundle: {
      accessToken: token.access_token,
      actorId: short.user_id,
      authMode: 'instagram_login',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      scopes: granted,
    } satisfies TokenBundle,
  };
}
