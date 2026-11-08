import 'server-only';
import { z } from 'zod';
import { adminDatabase } from '@/lib/server/supabase';
import { DirectAccess } from '@/services/tracking/direct/base';
import { oauthConfig } from '@/services/oauth/config';
import { unseal } from '@/services/oauth/crypto';
import type { TokenBundle } from '@/services/oauth/tokens';
import type { SocialAccount } from '@/domain/model';
import { instant } from '@/domain/time';
import { createHmac } from 'node:crypto';
type DB = ReturnType<typeof adminDatabase>;
type SourceJob = {
  account: SocialAccount;
  leaseToken: string;
  posts: { id: string; platform_post_id: string; published_at: string }[];
};
const items = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({ title: z.string(), channelId: z.string(), publishedAt: z.string() }),
      status: z.object({ privacyStatus: z.string() }),
    })
  ),
});
export async function checkSources(db: DB, deadline: number) {
  const leased = await db.rpc('lease_source_check');
  if (leased.error) throw new Error('Could not lease source checks.');
  const job = leased.data as SourceJob | null;
  if (!job) return false;
  const access = new DirectAccess(job.account, deadline),
    observations: { id: string; status: 'available' | 'unavailable'; caption?: string }[] = [];
  let authorized = false;
  try {
    const remote = encodeURIComponent(job.account.provider_account_id || '');
    if (job.account.platform === 'youtube') {
      const identity = z
        .object({ items: z.array(z.object({ id: z.string() })) })
        .parse(
          await access.request('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true')
        );
      if (!identity.items.some((i) => i.id === job.account.provider_account_id)) {
        await access.token.revoke();
        return true;
      }
      authorized = true;
      if (job.posts.length) {
        const query = new URLSearchParams({
          part: 'snippet,status',
          id: job.posts.map((p) => p.platform_post_id).join(','),
        });
        const result = items.parse(
          await access.request(`https://www.googleapis.com/youtube/v3/videos?${query}`)
        );
        for (const post of job.posts) {
          const v = result.items.find((v) => v.id === post.platform_post_id);
          if (
            !v ||
            v.status.privacyStatus !== 'public' ||
            v.snippet.channelId !== job.account.provider_account_id
          )
            observations.push({ id: post.id, status: 'unavailable' });
          else {
            if (instant(v.snippet.publishedAt) !== instant(post.published_at))
              throw new Error('Original publication timestamp changed.');
            observations.push({ id: post.id, status: 'available', caption: v.snippet.title });
          }
        }
      }
    } else {
      const origin = `https://graph.facebook.com/${oauthConfig(job.account.platform as 'instagram' | 'facebook').version}`;
      const identity = z
        .object({ id: z.string() })
        .parse(await access.request(`${origin}/${remote}?fields=id`));
      if (identity.id !== job.account.provider_account_id) {
        await access.token.revoke();
        return true;
      }
      authorized = true;
      for (const post of job.posts) {
        try {
          const video = z
            .object({
              id: z.string(),
              caption: z.string().optional(),
              description: z.string().optional(),
            })
            .parse(
              await access.request(
                `${origin}/${encodeURIComponent(post.platform_post_id)}?fields=id,${job.account.platform === 'instagram' ? 'caption' : 'description'}`
              )
            );
          if (video.id !== post.platform_post_id) throw new Error('Unexpected source identity.');
          observations.push({
            id: post.id,
            status: 'available',
            caption: video.caption || video.description || '',
          });
        } catch {
          break;
        } // Inaccessible is not zero or proof of deletion; expire if checks cannot recover.
      }
    }
  } catch {
    /* Retry transient/configuration failures; the hard retention sweep still applies. */
  }
  const retry = access.patch.retryAfterAt
    ? Math.max(300, Math.ceil((Date.parse(access.patch.retryAfterAt) - Date.now()) / 1000))
    : observations.length < job.posts.length || !authorized
      ? 3600
      : 300;
  const result = await db.rpc('complete_source_check', {
    target_account: job.account.id,
    expected_lease: job.leaseToken,
    observations,
    authorized,
    retry_seconds: retry,
  });
  // Revocation atomically cancels the source lease; a lost lease must never restore source data.
  if (result.error && !result.error.message?.includes('LEASE_LOST'))
    throw new Error('Could not save source checks.');
  return true;
}
export async function processRevocation(db: DB, deadline: number) {
  const leased = await db.rpc('lease_provider_revocation');
  if (leased.error) throw new Error('Could not lease revocation.');
  const job = leased.data as {
    id: string;
    account_id: string;
    platform: 'youtube' | 'instagram' | 'facebook';
    encrypted_token: string;
    lease_token: string;
  } | null;
  if (!job) return false;
  let success = false;
  try {
    const token = unseal<TokenBundle>(job.encrypted_token, job.account_id);
    let url: string, init: RequestInit;
    if (job.platform === 'youtube') {
      url = 'https://oauth2.googleapis.com/revoke';
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: token.refreshToken || token.accessToken }),
      };
    } else {
      const c = oauthConfig(job.platform);
      if (!token.actorId || !token.revocationToken)
        throw new Error('Legacy grant requires provider-side revocation.');
      const proof = createHmac('sha256', c.clientSecret)
        .update(token.revocationToken)
        .digest('hex');
      url = `https://graph.facebook.com/${c.version}/${encodeURIComponent(token.actorId)}/permissions?appsecret_proof=${proof}`;
      init = { method: 'DELETE', headers: { Authorization: `Bearer ${token.revocationToken}` } };
    }
    const remaining = deadline - Date.now();
    if (remaining < 500) throw new Error('Revocation budget exhausted.');
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(8000, remaining)),
    });
    if (job.platform === 'youtube') {
      if (response.status === 200) success = true;
      else if (response.status === 400) {
        const body = await response.json().catch(() => null);
        success = body?.error === 'invalid_token';
      }
    } else {
      const body = await response.json().catch(() => null);
      success = (response.ok && body?.success === true) || body?.error?.code === 190;
    }
  } catch {
    /* No tokens, actor IDs or raw provider errors enter logs or diagnostic rows. */
  }
  const saved = await db.rpc('finish_provider_revocation', {
    target_id: job.id,
    expected_lease: job.lease_token,
    success,
  });
  if (saved.error) throw new Error('Could not finish revocation.');
  return true;
}
export async function maintainProviders(db: DB, deadline: number) {
  const sweep = await db.rpc('sweep_provider_retention');
  if (sweep.error) throw new Error('Provider retention sweep failed.');
  const revocation = Date.now() < deadline - 1000 ? await processRevocation(db, deadline) : false;
  const checked = Date.now() < deadline - 1000 ? await checkSources(db, deadline) : false;
  return { erased: sweep.data?.erased ?? 0, revocation, checked };
}
