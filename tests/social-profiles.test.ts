import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { SocialAccount } from '@/domain/model';
const mocks = vi.hoisted(() => ({ accounts: vi.fn(), request: vi.fn(), rpc: vi.fn() }));
vi.mock('@/services/tracking/zernio', () => ({
  ZernioProvider: class {
    listAccounts = mocks.accounts;
  },
  remoteId: (a: { _id: string }) => a._id,
  zernioInstagramEnabled: () => process.env.ZERNIO_INSTAGRAM_ENABLED === 'true',
}));
vi.mock('@/services/tracking/direct/base', () => ({
  DirectAccess: class {
    request = mocks.request;
  },
}));
import { fetchProfile, instagramProfile, refreshProfile } from '@/services/profiles/metadata';
import { profileAvatar, mergeProfile } from '@/services/profiles/identity';
import { adminDatabase } from '@/lib/server/supabase';
const account: SocialAccount = {
  id: 'local',
  creator_id: 'creator',
  platform: 'tiktok',
  username: 'creator',
  provider: 'zernio',
  provider_account_id: 'remote',
  provider_profile_id: 'profile',
  status: 'connected',
  ownership: 'creator',
  last_synced_at: null,
  error: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_META_APP_ID', 'app');
  vi.stubEnv('INSTAGRAM_META_APP_SECRET', 'secret');
  vi.stubEnv('INSTAGRAM_LOGIN_CONFIG_ID', '123');
  vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v26.0');
  vi.stubEnv('OAUTH_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
});
afterEach(() => vi.unstubAllEnvs());
it.each(['tiktok', 'instagram'] as const)(
  'reads %s avatars from the existing Zernio account response',
  async (platform) => {
    mocks.accounts.mockResolvedValue([
      {
        _id: 'remote',
        platform,
        username: 'creator',
        profileId: 'profile',
        displayName: 'Creator Name',
        profilePicture: 'https://p16.tiktokcdn.com/avatar',
      },
    ]);
    expect(await fetchProfile({ ...account, platform }, Date.now() + 5000)).toMatchObject({
      name: 'Creator Name',
      username: 'creator',
      avatarUrl: 'https://p16.tiktokcdn.com/avatar',
    });
    expect(mocks.accounts).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
  }
);
it('rejects another provider identity instead of using its profile picture', async () => {
  mocks.accounts.mockResolvedValue([
    { _id: 'different', platform: 'tiktok', username: 'creator', profileId: 'profile' },
  ]);
  await expect(fetchProfile(account, Date.now() + 5000)).rejects.toThrow(/identity/);
});
it('queries only the connected Meta user and verifies the returned immutable ID', async () => {
  const a = {
    ...account,
    platform: 'instagram' as const,
    provider: 'direct' as const,
    provider_account_id: '222',
    integration: { instagramAuthMode: 'unified_login' as const },
  };
  const request = vi.fn().mockResolvedValue({
    id: '222',
    username: 'creator',
    name: 'Creator',
    profile_picture_url: 'https://scontent.cdninstagram.com/avatar',
  });
  expect(await instagramProfile(a, request)).toMatchObject({
    avatarUrl: 'https://scontent.cdninstagram.com/avatar',
  });
  expect(request.mock.calls[0][0]).toBe(
    'https://graph.facebook.com/v26.0/222?fields=id,username,name,profile_picture_url'
  );
  request.mockResolvedValue({ id: 'wrong', username: 'creator' });
  await expect(instagramProfile(a, request)).rejects.toThrow(/identity/);
});
it('records a failure separately and preserves the cached profile for retries', async () => {
  mocks.rpc
    .mockResolvedValueOnce({ data: { account, lease_token: 'lease' }, error: null })
    .mockResolvedValueOnce({ data: true, error: null });
  mocks.accounts.mockRejectedValue(new Error('Temporary provider outage'));
  const db = { rpc: mocks.rpc } as unknown as ReturnType<typeof adminDatabase>;
  expect(await refreshProfile(db, Date.now() + 5000)).toEqual({
    processed: true,
    status: 'unavailable',
  });
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'finish_profile_metadata',
    expect.objectContaining({
      profile: null,
      expected_channel: 'remote',
      expected_provider: 'zernio',
    })
  );
});
it('rejects credential-bearing/untrusted image URLs and preserves known fields on partial responses', () => {
  expect(profileAvatar('https://localhost/avatar')).toBeUndefined();
  expect(profileAvatar('https://cdninstagram.com/avatar?access_token=SECRET')).toBeUndefined();
  expect(
    mergeProfile(
      { name: 'Known', avatarUrl: 'https://cdninstagram.com/old', refreshedAt: 'old' },
      { username: 'creator', refreshedAt: 'new' }
    )
  ).toMatchObject({ name: 'Known', avatarUrl: 'https://cdninstagram.com/old', refreshedAt: 'new' });
});
it('allows TikTok CDN signed image refresh parameters, without allowing OAuth credentials on arbitrary URLs', () => {
  const avatar =
    'https://p16-common-sign.tiktokcdn-eu.com/avatar.jpeg?refresh_token=image-signature&x-expires=9999999999&x-signature=signed';
  expect(profileAvatar(avatar)).toBe(avatar);
  expect(
    profileAvatar('https://cdninstagram.com/avatar?refresh_token=oauth-secret')
  ).toBeUndefined();
  expect(
    profileAvatar('https://tiktokcdn-eu.com.evil.example/avatar?refresh_token=secret')
  ).toBeUndefined();
  expect(profileAvatar(`${avatar}&access_token=secret`)).toBeUndefined();
});
