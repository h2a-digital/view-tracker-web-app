import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), revoke: vi.fn(), rpc: vi.fn() }));
vi.mock('@/services/tracking/direct/base', () => ({
  DirectAccess: class {
    request = mocks.request;
    token = { revoke: mocks.revoke };
    patch = {};
  },
}));
import { checkSources, processRevocation } from '@/services/lifecycle/worker';
import { seal } from '@/services/oauth/crypto';
import type { adminDatabase } from '@/lib/server/supabase';
const db = { rpc: mocks.rpc } as unknown as ReturnType<typeof adminDatabase>;
const job = {
  account: { id: 'account', platform: 'youtube', provider_account_id: 'channel' },
  leaseToken: 'lease',
  posts: [{ id: 'post', platform_post_id: 'video', published_at: '2026-11-01T12:00:00Z' }],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OAUTH_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('META_APP_ID', 'meta');
  vi.stubEnv('META_APP_SECRET', 'secret');
  vi.stubEnv('META_GRAPH_VERSION', 'v26.0');
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data: name === 'lease_source_check' ? job : null,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('checks old YouTube videos in one batch and refreshes available metadata', async () => {
  mocks.request.mockResolvedValueOnce({ items: [{ id: 'channel' }] }).mockResolvedValueOnce({
    items: [
      {
        id: 'video',
        snippet: {
          title: 'Updated',
          channelId: 'channel',
          publishedAt: job.posts[0].published_at,
        },
        status: { privacyStatus: 'public' },
      },
    ],
  });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'complete_source_check',
    expect.objectContaining({
      authorized: true,
      observations: [{ id: 'post', status: 'available', caption: 'Updated' }],
    })
  );
});
it('flags deleted/private videos for erasure without inventing a zero view count', async () => {
  mocks.request
    .mockResolvedValueOnce({ items: [{ id: 'channel' }] })
    .mockResolvedValueOnce({ items: [] });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'complete_source_check',
    expect.objectContaining({ observations: [{ id: 'post', status: 'unavailable' }] })
  );
});
it('retries temporary failures without treating them as successful authorization or deletion', async () => {
  mocks.request.mockRejectedValue(new Error('Temporary failure'));
  await checkSources(db, Date.now() + 10000);
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'complete_source_check',
    expect.objectContaining({ authorized: false, observations: [] })
  );
});
it('revokes mismatched YouTube authorization instead of retaining access', async () => {
  mocks.request.mockResolvedValue({ items: [{ id: 'different' }] });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.revoke).toHaveBeenCalledOnce();
});
function revocation(platform = 'youtube') {
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'lease_provider_revocation'
        ? {
            id: 'outbox',
            lease_token: 'lease',
            account_id: 'account',
            platform,
            encrypted_token: seal(
              {
                accessToken: 'access',
                refreshToken: 'refresh',
                actorId: '123',
                revocationToken: 'user-token',
              },
              'account'
            ),
          }
        : null,
  }));
}
it('handles an empty Google revocation response and never sends a token in the URL', async () => {
  revocation();
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await processRevocation(db, Date.now() + 10000);
  expect(fetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke');
  expect(String(fetch.mock.calls[0][1].body)).toContain('token=refresh');
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'finish_provider_revocation',
    expect.objectContaining({ success: true })
  );
});
it('retries provider revocation failures without discarding the queued credential', async () => {
  revocation();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  await processRevocation(db, Date.now() + 10000);
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'finish_provider_revocation',
    expect.objectContaining({ success: false })
  );
});
it('uses the Meta user grant for permission revocation, not the Page token', async () => {
  revocation('instagram');
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
  vi.stubGlobal('fetch', fetch);
  await processRevocation(db, Date.now() + 10000);
  expect(fetch.mock.calls[0][0]).toContain('/123/permissions?appsecret_proof=');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'DELETE',
    headers: { Authorization: 'Bearer user-token' },
  });
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'finish_provider_revocation',
    expect.objectContaining({ success: true })
  );
});

it('revokes an Instagram Login grant using its own token and host, without the Facebook user grant', async () => {
  vi.stubEnv('INSTAGRAM_APP_ID', 'instagram');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'instagram-secret');
  vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v27.0');
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'lease_provider_revocation'
        ? {
            id: 'outbox',
            lease_token: 'lease',
            account_id: 'account',
            platform: 'instagram',
            encrypted_token: seal(
              { accessToken: 'ig-token', authMode: 'instagram_login', actorId: '456' },
              'account'
            ),
          }
        : null,
  }));
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
  vi.stubGlobal('fetch', fetch);
  await processRevocation(db, Date.now() + 10000);
  expect(fetch.mock.calls[0][0]).toBe('https://graph.instagram.com/v27.0/me/permissions');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'DELETE',
    headers: { Authorization: 'Bearer ig-token' },
  });
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'finish_provider_revocation',
    expect.objectContaining({ success: true })
  );
});

it('checks Instagram Login authorization against user_id rather than the app-scoped id', async () => {
  vi.stubEnv('INSTAGRAM_APP_ID', 'instagram');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'instagram-secret');
  vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v27.0');
  const instagramJob = {
    ...job,
    posts: [],
    account: {
      ...job.account,
      platform: 'instagram',
      integration: { instagramAuthMode: 'instagram_login' },
    },
  };
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data: name === 'lease_source_check' ? instagramJob : null,
  }));
  mocks.request.mockResolvedValue({ id: 'other-app-scoped-id', user_id: 'channel' });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.request).toHaveBeenCalledWith(
    'https://graph.instagram.com/v27.0/me?fields=user_id,username'
  );
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'complete_source_check',
    expect.objectContaining({ authorized: true })
  );
});

it('checks SUAT authorization through assigned accounts rather than comparing /me system user ID to the Instagram ID', async () => {
  vi.stubEnv('INSTAGRAM_META_APP_ID', '123456');
  vi.stubEnv('INSTAGRAM_META_APP_SECRET', 'unified-secret');
  vi.stubEnv('INSTAGRAM_LOGIN_CONFIG_ID', '4372319632985486');
  vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v27.0');
  const unified = {
    ...job,
    posts: [],
    account: {
      ...job.account,
      platform: 'instagram',
      provider_account_id: '222',
      integration: { instagramAuthMode: 'unified_login' },
    },
  };
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data: name === 'lease_source_check' ? unified : null,
  }));
  mocks.request.mockResolvedValue({ data: [{ id: '222', username: 'creator' }] });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.request).toHaveBeenCalledWith(
    expect.stringContaining('/me/assigned_instagram_accounts?')
  );
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    'complete_source_check',
    expect.objectContaining({ authorized: true })
  );
  mocks.request.mockResolvedValue({ data: [] });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.revoke).toHaveBeenCalledOnce();
});
it.each([true, false])(
  'attempts SUAT permission revocation with its own credential and records success=%s accurately',
  async (success) => {
    vi.stubEnv('INSTAGRAM_META_APP_ID', '123456');
    vi.stubEnv('INSTAGRAM_META_APP_SECRET', 'unified-secret');
    vi.stubEnv('INSTAGRAM_LOGIN_CONFIG_ID', '4372319632985486');
    vi.stubEnv('INSTAGRAM_GRAPH_VERSION', 'v27.0');
    mocks.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === 'lease_provider_revocation'
          ? {
              id: 'outbox',
              lease_token: 'lease',
              account_id: 'account',
              platform: 'instagram',
              encrypted_token: seal(
                {
                  accessToken: 'suat-private',
                  authMode: 'unified_login',
                  actorId: '333',
                  clientBusinessId: '444',
                },
                'account'
              ),
            }
          : null,
    }));
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(success ? { success: true } : { error: { code: 10 } }), {
        status: success ? 200 : 400,
      })
    );
    vi.stubGlobal('fetch', fetch);
    await processRevocation(db, Date.now() + 10000);
    expect(fetch.mock.calls[0][0]).toContain(
      'https://graph.facebook.com/v27.0/me/permissions?appsecret_proof='
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer suat-private' },
    });
    expect(fetch.mock.calls[0][0]).not.toContain('suat-private');
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'finish_provider_revocation',
      expect.objectContaining({ success })
    );
  }
);

it('refreshes channel title, handle and avatar from the existing daily identity request', async () => {
  mocks.request
    .mockResolvedValueOnce({
      items: [
        {
          id: 'channel',
          snippet: {
            title: 'Atalaya',
            customUrl: '@atalaya',
            thumbnails: { default: { url: 'https://yt3.ggpht.com/avatar' } },
          },
        },
      ],
    })
    .mockResolvedValueOnce({ items: [] });
  await checkSources(db, Date.now() + 10000);
  expect(mocks.request.mock.calls[0][0]).toContain('channels?part=id,snippet&mine=true');
  expect(mocks.rpc).toHaveBeenCalledWith(
    'store_channel_identity',
    expect.objectContaining({
      expected_channel: 'channel',
      identity: expect.objectContaining({
        title: 'Atalaya',
        handle: '@atalaya',
        avatarUrl: 'https://yt3.ggpht.com/avatar',
      }),
    })
  );
});
