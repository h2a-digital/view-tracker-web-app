import 'server-only';
import { z } from 'zod';
import type { SocialAccount, ProfileMetadata } from '@/domain/model';
import { DirectAccess } from '@/services/tracking/direct/base';
import { metaGraphOrigin, instagramAuthMode } from '@/services/oauth/config';
import { ZernioProvider, remoteId, zernioInstagramEnabled } from '@/services/tracking/zernio';
import { lookupYouTubeMetadata } from '@/services/youtube/metadata';
import { loadDashboard } from '@/repositories/dashboard';
import { adminDatabase } from '@/lib/server/supabase';
import { profileIdentity } from './identity';
export const instagramProfileFields = 'id,username,name,profile_picture_url';
export const instagramLoginProfileFields = 'user_id,username,name,profile_picture_url';
export async function instagramProfile(
  account: SocialAccount,
  request: (url: string) => Promise<unknown>
): Promise<ProfileMetadata> {
  const direct = instagramAuthMode(account) === 'instagram_login';
  const url = `${metaGraphOrigin(account)}/${direct ? 'me' : encodeURIComponent(account.provider_account_id!)}?fields=${direct ? instagramLoginProfileFields : instagramProfileFields}`;
  const result = z
    .object({
      id: z.union([z.string(), z.number().int().safe()]).optional(),
      user_id: z.union([z.string(), z.number().int().safe()]).optional(),
      username: z.string(),
      name: z.string().nullish(),
      profile_picture_url: z.string().nullish(),
    })
    .parse(await request(url));
  if (String(direct ? result.user_id : result.id) !== account.provider_account_id)
    throw new Error('Instagram profile identity does not match the connected account.');
  return profileIdentity(result.name, result.username, result.profile_picture_url);
}
export async function fetchProfile(
  account: SocialAccount,
  deadline: number
): Promise<ProfileMetadata> {
  if (account.platform === 'youtube') {
    const { data } = await loadDashboard();
    const [result] = await lookupYouTubeMetadata(data, [account], deadline);
    const identity =
      result.identity ||
      (result.status === 'cached' &&
      account.integration?.channelIdentity &&
      Date.now() - Date.parse(account.integration.channelIdentity.refreshedAt) < 86400000
        ? account.integration.channelIdentity
        : undefined);
    if (!identity) throw new Error(result.message || 'YouTube profile is temporarily unavailable.');
    return {
      ...profileIdentity(identity.title, identity.handle, identity.avatarUrl),
      refreshedAt: identity.refreshedAt,
    };
  }
  if (account.status !== 'connected' || !account.provider_account_id)
    throw new Error('Connect this account before retrieving its profile.');
  if (
    account.provider === 'zernio' &&
    (account.platform === 'tiktok' || account.platform === 'instagram')
  ) {
    if (account.platform === 'instagram' && !zernioInstagramEnabled())
      throw new Error('Instagram/Zernio is disabled.');
    const remote = (await new ZernioProvider(deadline, account.platform).listAccounts()).find(
      (a) => remoteId(a) === account.provider_account_id && a.platform === account.platform
    );
    const profile = remote?.profileId;
    const profileId = typeof profile === 'string' ? profile : (profile?._id ?? profile?.id);
    if (
      !remote ||
      remote.isActive === false ||
      profileId !== account.provider_profile_id ||
      remote.username.replace(/^@/, '').toLowerCase() !==
        account.username.replace(/^@/, '').toLowerCase()
    )
      throw new Error('Zernio profile identity needs attention.');
    return profileIdentity(remote.displayName, remote.username, remote.profilePicture);
  }
  if (account.provider === 'direct' && account.platform === 'instagram') {
    const access = new DirectAccess(account, deadline);
    return instagramProfile(account, (url) => access.request(url));
  }
  throw new Error('Profile metadata is not supported by this account provider.');
}
type DB = ReturnType<typeof adminDatabase>;
export async function refreshProfile(db: DB, deadline: number, accountId?: string) {
  const leased = await db.rpc('lease_profile_metadata', {
    target_account: accountId ?? null,
    instagram_zernio_enabled: zernioInstagramEnabled(),
  });
  if (leased.error)
    throw new Error('Apply the social profile metadata migration before refreshing profiles.');
  const job = leased.data as { account: SocialAccount; lease_token: string } | null;
  if (!job) return { status: 'cached', processed: false };
  let profile: ProfileMetadata | null = null;
  try {
    profile = await fetchProfile(job.account, deadline);
  } catch {
    /* Do not erase cached metadata or disclose provider payloads. */
  }
  const saved = await db.rpc('finish_profile_metadata', {
    target_account: job.account.id,
    expected_lease: job.lease_token,
    expected_username: job.account.username,
    expected_channel: job.account.provider_account_id,
    expected_provider: job.account.provider,
    profile,
  });
  if (saved.error)
    throw new Error('Could not persist profile metadata. Check the migration and retry.');
  return { processed: true, status: !saved.data ? 'changed' : profile ? 'updated' : 'unavailable' };
}
