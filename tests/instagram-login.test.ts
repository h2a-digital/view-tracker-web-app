import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), load: vi.fn(), cookie: vi.fn() }));
vi.mock('@/lib/server/supabase', () => ({ adminDatabase: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
import { startOAuth, finishOAuth, oauthInvitation } from '@/services/oauth/flow';
import { instagramAuthMode, scopes } from '@/services/oauth/config';
import { seal, unseal, digest } from '@/services/oauth/crypto';
import { AccountToken, type TokenBundle } from '@/services/oauth/tokens';
import { subjectFingerprint } from '@/services/lifecycle/identity';
import { populatedDocument } from './helpers/dashboard';
const state = 'a'.repeat(64),
  browser = 'b'.repeat(64),
  ticket = 'c'.repeat(64);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let document: ReturnType<typeof populatedDocument>;
let flowMode: unknown;
let credential: TokenBundle | null;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
  for (const [key, value] of Object.entries({
    CONTEXT: 'production',
    APP_URL: 'https://hub.example.com',
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUPABASE_SECRET_KEY: 'secret',
    ADMIN_EMAIL: 'admin@example.com',
    INSTAGRAM_APP_ID: 'ig-app',
    INSTAGRAM_APP_SECRET: 'ig-secret',
    INSTAGRAM_GRAPH_VERSION: 'v27.0',
    META_APP_ID: 'fb-app',
    META_APP_SECRET: 'fb-secret',
    META_GRAPH_VERSION: 'v26.0',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'd'.repeat(64),
  }))
    vi.stubEnv(key, value);
  document = populatedDocument();
  Object.assign(document.accounts[0], {
    provider: 'direct',
    platform: 'instagram',
    username: 'creator',
    status: 'registered',
    provider_account_id: '222',
    integration: { instagramAuthMode: 'instagram_login' },
  });
  flowMode = { instagramAuthMode: 'instagram_login' };
  credential = null;
  mocks.cookie.mockReturnValue({ value: browser });
  mocks.load.mockImplementation(async () => ({ data: structuredClone(document), revision: 3 }));
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'read_oauth_flow'
        ? {
            account_id: document.accounts[0].id,
            platform: 'instagram',
            browser_hash: digest(browser),
            verifier: seal(flowMode, digest(state)),
          }
        : name === 'read_oauth_invite'
          ? { account_id: document.accounts[0].id, platform: 'instagram' }
          : name === 'read_direct_credentials' && credential
            ? { encrypted_token: seal(credential, 'account'), version: 7 }
            : true,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const callback = () =>
  finishOAuth(
    new Request(
      `https://hub.example.com/api/oauth/instagram/callback?state=${state}&code=private-code`
    ),
    'instagram'
  );
function grant(
  permissions = scopes('instagram', 'instagram_login').join(','),
  username = 'creator',
  wrapped = true
) {
  const token = { access_token: 'short-private', user_id: '111', permissions };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(wrapped ? { data: [token] } : token))
    .mockResolvedValueOnce(json({ access_token: 'long-private', expires_in: 5184000 }))
    .mockResolvedValueOnce(json({ id: '333', user_id: '222', username }))
    .mockResolvedValueOnce(
      json({
        user_id: '222',
        username,
        name: 'Creator',
        profile_picture_url: 'https://scontent.cdninstagram.com/avatar',
      })
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('Instagram Login and legacy compatibility', () => {
  it('preserves an existing Instagram Login grant without Facebook configuration and binds the selected mode to one-use state', async () => {
    vi.stubEnv('META_APP_ID', '');
    vi.stubEnv('META_APP_SECRET', '');
    vi.stubEnv('META_GRAPH_VERSION', '');
    const response = await startOAuth(
      new Request(`https://hub.example.com/api/oauth/instagram/start?ticket=${ticket}`),
      'instagram'
    );
    const url = new URL(response.headers.get('location')!);
    expect(url.origin).toBe('https://www.instagram.com');
    expect(url.searchParams.get('scope')).toBe(
      'instagram_business_basic,instagram_business_manage_insights'
    );
    expect(url.searchParams.get('enable_fb_login')).toBe('false');
    expect(url.searchParams.has('client_secret')).toBe(false);
    const saved = mocks.rpc.mock.calls.find(([n]) => n === 'start_oauth_flow')![1];
    expect(unseal(saved.encrypted_verifier, saved.state_hash)).toEqual(flowMode);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    const consent = await oauthInvitation(
      new Request(`https://hub.example.com/api/oauth/instagram/start?ticket=${ticket}`),
      'instagram'
    );
    expect(await consent.text()).toContain(
      'No Facebook account or linked Facebook Page is required'
    );
    expect(consent.headers.get('Content-Security-Policy')).toContain('https://www.instagram.com');
  });
  it('retains Facebook Login for existing remote IDs, even after disconnect, without changing their data', async () => {
    document.accounts[0].provider_account_id = 'legacy-ig';
    document.accounts[0].integration = null;
    document.accounts[0].status = 'disconnected';
    const before = structuredClone(document);
    expect(instagramAuthMode(document.accounts[0])).toBe('facebook_login');
    vi.stubEnv('INSTAGRAM_APP_ID', '');
    const response = await startOAuth(
      new Request(`https://hub.example.com/api/oauth/instagram/start?ticket=${ticket}`),
      'instagram'
    );
    const url = new URL(response.headers.get('location')!);
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.searchParams.get('scope')).toContain('pages_show_list');
    expect(document).toEqual(before);
  });
  it.each([true, false])(
    'accepts wrapped=%s exchange responses, validates scopes and keeps actor and Graph identity separate',
    async (wrapped) => {
      const fetch = grant(undefined, undefined, wrapped);
      expect((await callback()).status).toBe(200);
      expect(fetch.mock.calls.map(([u]) => new URL(String(u)).hostname)).toEqual([
        'api.instagram.com',
        'graph.instagram.com',
        'graph.instagram.com',
        'graph.instagram.com',
      ]);
      expect(fetch.mock.calls[0][1].method).toBe('POST');
      expect(String(fetch.mock.calls[0][1].body)).toContain(
        'redirect_uri=https%3A%2F%2Fhub.example.com%2Fapi%2Foauth%2Finstagram%2Fcallback'
      );
      const saved = mocks.rpc.mock.calls.find(([n]) => n === 'commit_direct_connection')![1];
      expect(saved.document.accounts[0]).toMatchObject({
        provider_account_id: '222',
        integration: {
          instagramAuthMode: 'instagram_login',
          profileMetadata: expect.objectContaining({
            avatarUrl: 'https://scontent.cdninstagram.com/avatar',
          }),
        },
      });
      expect(unseal(saved.encrypted_token, document.accounts[0].id)).toMatchObject({
        actorId: '111',
        authMode: 'instagram_login',
        accessToken: 'long-private',
      });
      expect(saved.subject_fingerprint).toBe(subjectFingerprint('instagram', '111'));
      expect(JSON.stringify(saved.document)).not.toContain('long-private');
      expect(saved.document.posts).toEqual(document.posts);
      expect(saved.document.statements).toEqual(document.statements);
    }
  );
  it('rejects missing insights permission before saving or requesting a long-lived token', async () => {
    const fetch = grant('instagram_business_basic');
    await expect(callback()).rejects.toThrow('permissions');
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.rpc.mock.calls.some(([n]) => n === 'commit_direct_connection')).toBe(false);
  });
  it('rejects another account and never commits its grant', async () => {
    grant(undefined, 'someone_else');
    await expect(callback()).rejects.toThrow('different Instagram');
    expect(mocks.rpc.mock.calls.some(([n]) => n === 'commit_direct_connection')).toBe(false);
  });
  it('does not reinterpret legacy string state as the new Instagram flow', async () => {
    flowMode = 'old-verifier';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(callback()).rejects.toThrow('method changed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a changed browser before exchanging any code', async () => {
    mocks.cookie.mockReturnValue({ value: 'f'.repeat(64) });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(callback()).rejects.toThrow('state');
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('long-lived Instagram credentials', () => {
  function nearExpiry() {
    credential = {
      accessToken: 'old-private',
      authMode: 'instagram_login',
      actorId: '111',
      issuedAt: new Date(Date.now() - 55 * 86400000).toISOString(),
      expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      scopes: scopes('instagram', 'instagram_login'),
    };
  }
  it('renews proactively without a refresh token, encrypts the result and uses compare-and-swap', async () => {
    nearExpiry();
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ access_token: 'new-private', expires_in: 5184000 }));
    vi.stubGlobal('fetch', fetch);
    expect(await new AccountToken('account', 'instagram', Date.now() + 15000).get()).toBe(
      'new-private'
    );
    expect(String(fetch.mock.calls[0][0])).toContain(
      'graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token'
    );
    const saved = mocks.rpc.mock.calls.find(([n]) => n === 'write_direct_credentials')![1];
    expect(saved.expected_version).toBe(7);
    expect(unseal(saved.encrypted_token, 'account')).toMatchObject({
      accessToken: 'new-private',
      actorId: '111',
      authMode: 'instagram_login',
    });
    expect(saved.encrypted_token).not.toContain('new-private');
  });
  it('does not renew a token younger than 24 hours or an ordinary legacy Page token', async () => {
    nearExpiry();
    credential!.issuedAt = new Date(Date.now() - 3600000).toISOString();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await new AccountToken('account', 'instagram', Date.now() + 15000).get();
    credential = { accessToken: 'page', expiresAt: null, scopes: [] };
    expect(await new AccountToken('account', 'instagram', Date.now() + 15000).get()).toBe('page');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not overwrite a concurrent reconnect during renewal', async () => {
    nearExpiry();
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (...args) =>
      args[0] === 'write_direct_credentials' ? { data: false, error: null } : original(...args)
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ access_token: 'new', expires_in: 5184000 }))
    );
    await expect(
      new AccountToken('account', 'instagram', Date.now() + 15000).get()
    ).rejects.toThrow('concurrently');
    expect(mocks.rpc.mock.calls.some(([n]) => n === 'forget_direct_credentials')).toBe(false);
  });
  it('retries temporary renewal failures without erasing authorization', async () => {
    nearExpiry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 503)));
    await expect(
      new AccountToken('account', 'instagram', Date.now() + 15000).get()
    ).rejects.toThrow('retry');
    expect(mocks.rpc.mock.calls.some(([n]) => n === 'forget_direct_credentials')).toBe(false);
  });
  it.each(['expired', 'revoked'])(
    'erases %s credentials safely and requires reconnection',
    async (kind) => {
      nearExpiry();
      if (kind === 'expired') credential!.expiresAt = new Date(Date.now() - 1).toISOString();
      const fetch = vi.fn().mockResolvedValue(json({ error: { code: 190 } }, 400));
      vi.stubGlobal('fetch', fetch);
      await expect(
        new AccountToken('account', 'instagram', Date.now() + 15000).get()
      ).rejects.toThrow(/Reconnect/);
      expect(mocks.rpc).toHaveBeenCalledWith('forget_direct_credentials', {
        target_account: 'account',
        expected_version: 7,
      });
      if (kind === 'expired') expect(fetch).not.toHaveBeenCalled();
    }
  );
});
