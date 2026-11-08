import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), load: vi.fn(), cookie: vi.fn() }));
vi.mock('@/lib/server/supabase', () => ({ adminDatabase: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
import { seal, unseal, digest } from '@/services/oauth/crypto';
import {
  startOAuth,
  finishOAuth,
  directConnectionAction,
  oauthInvitation,
} from '@/services/oauth/flow';
import { AccountToken, type TokenBundle } from '@/services/oauth/tokens';
import { scopes } from '@/services/oauth/config';
import { populatedDocument } from './helpers/dashboard';
const state = 'a'.repeat(64),
  browser = 'b'.repeat(64),
  ticket = 'c'.repeat(64);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let document: ReturnType<typeof populatedDocument>;
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    CONTEXT: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ADMIN_EMAIL: 'admin@example.com',
    APP_URL: 'https://hub.example.com',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    META_APP_ID: 'meta-app',
    META_APP_SECRET: 'meta-secret',
    META_GRAPH_VERSION: 'v26.0',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'd'.repeat(64),
  }))
    vi.stubEnv(key, value);
  document = populatedDocument();
  document.accounts[0].provider = 'direct';
  document.accounts[0].platform = 'youtube';
  document.accounts[0].username = 'creator';
  document.accounts[0].status = 'registered';
  mocks.cookie.mockReturnValue({ value: browser });
  mocks.load.mockImplementation(async () => ({ data: structuredClone(document), revision: 3 }));
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'read_oauth_flow'
        ? {
            account_id: document.accounts[0].id,
            platform: document.accounts[0].platform,
            browser_hash: digest(browser),
            verifier: seal('verifier', digest(state)),
          }
        : name === 'read_oauth_invite'
          ? { platform: document.accounts[0].platform }
          : true,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('shared creator OAuth', () => {
  it('blocks preview starts and callbacks before accessing credentials or invitation data', async () => {
    vi.stubEnv('CONTEXT', 'deploy-preview');
    const request = new Request('https://hub.example.com/api/oauth/youtube/start');
    await expect(startOAuth(request, 'youtube')).rejects.toThrow('PREVIEW_DISABLED');
    await expect(finishOAuth(request, 'youtube')).rejects.toThrow('PREVIEW_DISABLED');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('encrypts tokens with account binding and rejects tampering or the wrong key', () => {
    const cipher = seal({ accessToken: 'private-token' }, 'account');
    expect(cipher).not.toContain('private-token');
    expect(unseal(cipher, 'account')).toEqual({ accessToken: 'private-token' });
    expect(() => unseal(cipher, 'other')).toThrow();
    vi.stubEnv('OAUTH_TOKEN_ENCRYPTION_KEY', 'e'.repeat(64));
    expect(() => unseal(cipher, 'account')).toThrow();
  });
  it('creates a separate invitation rather than giving creators an administrator session', async () => {
    const response = await directConnectionAction(document.accounts[0], document, 3, 'connect');
    const body = await response.json();
    expect(body.authUrl).toMatch(
      /^https:\/\/hub.example.com\/api\/oauth\/youtube\/start\?ticket=[a-f0-9]{64}$/
    );
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.rpc.mock.calls[0][1].hash).not.toBe(
      new URL(body.authUrl).searchParams.get('ticket')
    );
  });
  it('starts Google with PKCE, least-privilege scopes, fixed callback and secure browser state', async () => {
    const response = await startOAuth(
      new Request(`https://hub.example.com/api/oauth/youtube/start?ticket=${ticket}`),
      'youtube'
    );
    const url = new URL(response.headers.get('location')!);
    expect(response.status).toBe(303);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://hub.example.com/api/oauth/youtube/callback'
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(scopes('youtube'));
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
  it('presents privacy/terms consent before starting provider authorization', async () => {
    const response = await oauthInvitation(
      new Request(`https://hub.example.com/api/oauth/youtube/start?ticket=${ticket}`),
      'youtube'
    );
    const html = await response.text();
    expect(html).toContain('name="consent"');
    expect(html).toContain('/integrations/privacy');
    expect(html).toContain('https://www.youtube.com/t/terms');
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalledWith('start_oauth_flow', expect.anything());
  });
  it('rejects an expired invite and incorrect browser state before calling a provider', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(
      startOAuth(
        new Request(`https://hub.example.com/api/oauth/youtube/start?ticket=${ticket}`),
        'youtube'
      )
    ).rejects.toThrow('expired');
    mocks.rpc.mockResolvedValue({
      data: { platform: 'youtube', browser_hash: 'wrong' },
      error: null,
    });
    await expect(
      finishOAuth(
        new Request(`https://hub.example.com/api/oauth/youtube/callback?state=${state}&code=code`),
        'youtube'
      )
    ).rejects.toThrow('state');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('verifies the registered YouTube identity and stores only encrypted tokens atomically', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: scopes('youtube').join(' '),
        })
      )
      .mockResolvedValueOnce(
        json({ items: [{ id: 'UCverified', snippet: { customUrl: '@creator' } }] })
      );
    vi.stubGlobal('fetch', fetch);
    const response = await finishOAuth(
      new Request(`https://hub.example.com/api/oauth/youtube/callback?state=${state}&code=code`),
      'youtube'
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('refresh');
    const committed = mocks.rpc.mock.calls.find(
      ([name]) => name === 'commit_direct_connection'
    )![1];
    expect(committed.document.accounts[0]).toMatchObject({
      provider_account_id: 'UCverified',
      status: 'connected',
      integration: { payoutsBlocked: true },
    });
    expect(JSON.stringify(committed.document)).not.toContain('refresh_token');
    expect(
      unseal<TokenBundle>(committed.encrypted_token, document.accounts[0].id).refreshToken
    ).toBe('refresh');
    expect(committed.expected_browser_hash).toBe(digest(browser));
  });
  it('rejects a different YouTube channel without committing credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json({
            access_token: 'access',
            refresh_token: 'refresh',
            scope: scopes('youtube').join(' '),
          })
        )
        .mockResolvedValueOnce(json({ items: [{ id: 'other', snippet: { customUrl: '@other' } }] }))
    );
    await expect(
      finishOAuth(
        new Request(`https://hub.example.com/api/oauth/youtube/callback?state=${state}&code=code`),
        'youtube'
      )
    ).rejects.toThrow('different');
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'commit_direct_connection')).toBe(false);
  });
  it('resolves a linked Instagram professional account and never exposes Page tokens in dashboard data', async () => {
    document.accounts[0].platform = 'instagram';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'short' }))
        .mockResolvedValueOnce(json({ access_token: 'long' }))
        .mockResolvedValueOnce(
          json({
            data: scopes('instagram').map((permission) => ({ permission, status: 'granted' })),
          })
        )
        .mockResolvedValueOnce(json({ id: 'meta-user' }))
        .mockResolvedValueOnce(
          json({
            data: [
              {
                id: 'page',
                access_token: 'private-page-token',
                tasks: ['ANALYZE'],
                instagram_business_account: { id: 'ig-id', username: 'creator' },
              },
            ],
          })
        )
    );
    expect(
      (
        await finishOAuth(
          new Request(
            `https://hub.example.com/api/oauth/instagram/callback?state=${state}&code=code`
          ),
          'instagram'
        )
      ).status
    ).toBe(200);
    const saved = mocks.rpc.mock.calls.find(([name]) => name === 'commit_direct_connection')![1];
    expect(saved.document.accounts[0].provider_account_id).toBe('ig-id');
    const pageRequest = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes('/me/accounts?'));
    expect(new URL(String(pageRequest![0])).searchParams.get('fields')).toContain('tasks');
    expect(JSON.stringify(saved.document)).not.toContain('private-page-token');
    expect(unseal<TokenBundle>(saved.encrypted_token, document.accounts[0].id).accessToken).toBe(
      'private-page-token'
    );
  });
  it('disconnects by erasing local credentials and cancelling jobs without deleting historical documents', async () => {
    const originalPosts = structuredClone(document.posts);
    expect(
      (await directConnectionAction(document.accounts[0], document, 3, 'disconnect')).status
    ).toBe(200);
    expect(document.posts).toEqual(originalPosts);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'disconnect_direct_account',
      expect.objectContaining({ target_account: document.accounts[0].id })
    );
  });
});
describe('token refresh', () => {
  function credentials() {
    return seal(
      {
        accessToken: 'expired',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        scopes: scopes('youtube'),
      },
      'account'
    );
  }
  it('refreshes server-side, retains the existing refresh token and uses compare-and-swap', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === 'read_direct_credentials' ? { encrypted_token: credentials(), version: 7 } : true,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ access_token: 'new', expires_in: 3600 }))
    );
    expect(await new AccountToken('account', 'youtube', Date.now() + 15000).get()).toBe('new');
    const saved = mocks.rpc.mock.calls.find(([name]) => name === 'write_direct_credentials')![1];
    expect(saved.expected_version).toBe(7);
    expect(unseal<TokenBundle>(saved.encrypted_token, 'account').refreshToken).toBe('refresh');
  });
  it('does not overwrite a concurrent reconnect or stale token version', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === 'read_direct_credentials' ? { encrypted_token: credentials(), version: 7 } : false,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ access_token: 'new', expires_in: 3600 }))
    );
    await expect(new AccountToken('account', 'youtube', Date.now() + 15000).get()).rejects.toThrow(
      'concurrently'
    );
  });
  it('removes revoked credentials and requires reauthorization on invalid_grant', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data:
        name === 'read_direct_credentials' ? { encrypted_token: credentials(), version: 7 } : true,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'invalid_grant' }, 400)));
    await expect(new AccountToken('account', 'youtube', Date.now() + 15000).get()).rejects.toThrow(
      'Reconnect'
    );
    expect(mocks.rpc).toHaveBeenCalledWith('forget_direct_credentials', {
      target_account: 'account',
      expected_version: 7,
    });
  });
});
