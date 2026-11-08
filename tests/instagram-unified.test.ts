import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), load: vi.fn(), cookie: vi.fn() }));
vi.mock('@/lib/server/supabase', () => ({ adminDatabase: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
import { startOAuth, finishOAuth, oauthInvitation } from '@/services/oauth/flow';
import { instagramAuthMode, scopes } from '@/services/oauth/config';
import { assignedInstagramAccounts } from '@/services/oauth/instagram-unified';
import { seal, unseal, digest } from '@/services/oauth/crypto';
import { AccountToken, type TokenBundle } from '@/services/oauth/tokens';
import { subjectFingerprint } from '@/services/lifecycle/identity';
import { populatedDocument } from './helpers/dashboard';
const state = 'a'.repeat(64),
  browser = 'b'.repeat(64),
  ticket = 'c'.repeat(64),
  configId = '4372319632985486';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let document: ReturnType<typeof populatedDocument>;
let boundConfig: string;
let credential: TokenBundle;
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
    INSTAGRAM_META_APP_ID: '123456',
    INSTAGRAM_META_APP_SECRET: 'unified-secret',
    INSTAGRAM_LOGIN_CONFIG_ID: configId,
    INSTAGRAM_GRAPH_VERSION: 'v27.0',
    META_APP_ID: '',
    META_APP_SECRET: '',
    META_GRAPH_VERSION: '',
    INSTAGRAM_APP_ID: '',
    INSTAGRAM_APP_SECRET: '',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'd'.repeat(64),
  }))
    vi.stubEnv(key, value);
  document = populatedDocument();
  Object.assign(document.accounts[0], {
    provider: 'direct',
    platform: 'instagram',
    username: 'creator',
    status: 'registered',
    provider_account_id: null,
    integration: null,
  });
  boundConfig = configId;
  credential = {
    accessToken: 'suat-private',
    authMode: 'unified_login',
    expiresAt: null,
    scopes: scopes('instagram', 'unified_login'),
    actorId: '333',
    clientBusinessId: '444',
    configId,
  };
  mocks.cookie.mockReturnValue({ value: browser });
  mocks.load.mockImplementation(async () => ({ data: structuredClone(document), revision: 3 }));
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'read_oauth_invite'
        ? { account_id: document.accounts[0].id, platform: 'instagram' }
        : name === 'read_oauth_flow'
          ? {
              account_id: document.accounts[0].id,
              platform: 'instagram',
              browser_hash: digest(browser),
              verifier: seal(
                { instagramAuthMode: 'unified_login', configId: boundConfig, clientId: '123456' },
                digest(state)
              ),
            }
          : name === 'read_direct_credentials'
            ? { encrypted_token: seal(credential, 'account'), version: 7 }
            : true,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const callback = () =>
  finishOAuth(
    new Request(
      `https://hub.example.com/api/oauth/instagram/callback?state=${state}&code=private-code`
    ),
    'instagram'
  );
function grant(
  options: {
    scopes?: string[];
    username?: string;
    app?: string;
    expiry?: number;
    assigned?: unknown;
  } = {}
) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ access_token: 'suat-private' }))
    .mockResolvedValueOnce(
      json({
        data: {
          app_id: options.app ?? '123456',
          type: 'SYSTEM_USER',
          is_valid: true,
          user_id: '333',
          scopes: options.scopes ?? scopes('instagram', 'unified_login'),
          expires_at: options.expiry ?? 0,
          data_access_expires_at: 0,
        },
      })
    )
    .mockResolvedValueOnce(json({ id: '333', client_business_id: '444' }))
    .mockResolvedValueOnce(
      json(
        options.assigned ?? {
          data: [
            { id: '111', username: 'other' },
            { id: '222', username: options.username ?? 'creator' },
          ],
        }
      )
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('Unified Login creator authorization', () => {
  it('defaults new and previously unconnected registrations to the configured Facebook SUAT dialog without scope overrides', async () => {
    expect(instagramAuthMode(document.accounts[0])).toBe('unified_login');
    document.accounts[0].integration = { instagramAuthMode: 'instagram_login' };
    expect(instagramAuthMode(document.accounts[0])).toBe('unified_login');
    const response = await startOAuth(
      new Request(`https://hub.example.com/api/oauth/instagram/start?ticket=${ticket}`),
      'instagram'
    );
    const url = new URL(response.headers.get('location')!);
    expect(url.hostname).toBe('www.facebook.com');
    expect(url.searchParams.get('client_id')).toBe('123456');
    expect(url.searchParams.get('config_id')).toBe(configId);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('client_secret')).toBe(false);
    const flow = mocks.rpc.mock.calls.find(([name]) => name === 'start_oauth_flow')![1];
    expect(unseal(flow.encrypted_verifier, flow.state_hash)).toEqual({
      instagramAuthMode: 'unified_login',
      configId,
      clientId: '123456',
    });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });
  it('discloses the messaging grant without claiming strictly read-only authorization', async () => {
    const response = await oauthInvitation(
      new Request(`https://hub.example.com/api/oauth/instagram/start?ticket=${ticket}`),
      'instagram'
    );
    const html = await response.text();
    expect(html).toContain('instagram_manage_messages');
    expect(html).toContain('does not read, send, subscribe to, or store your messages');
    expect(html).toContain('business portfolio');
    expect(html).toContain('A linked Facebook Page is not required');
    expect(html).not.toContain('Read-only connection');
    expect(response.headers.get('Content-Security-Policy')).toContain('https://www.facebook.com');
  });
  it('exchanges once, validates grants, selects the registered assigned account and encrypts the never-expiring SUAT', async () => {
    const fetch = grant();
    expect((await callback()).status).toBe(200);
    const paths = fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual([
      '/v27.0/oauth/access_token',
      '/v27.0/debug_token',
      '/v27.0/me',
      '/v27.0/me/assigned_instagram_accounts',
    ]);
    expect(paths.join(',')).not.toMatch(/messages|conversations|accounts\?/);
    const exchange = new URL(String(fetch.mock.calls[0][0]));
    expect(exchange.searchParams.get('redirect_uri')).toBe(
      'https://hub.example.com/api/oauth/instagram/callback'
    );
    expect(exchange.searchParams.has('grant_type')).toBe(false);
    const saved = mocks.rpc.mock.calls.find(([name]) => name === 'commit_direct_connection')![1];
    expect(saved.document.accounts[0]).toMatchObject({
      provider_account_id: '222',
      integration: { instagramAuthMode: 'unified_login', tokenExpiresAt: null },
    });
    expect(unseal(saved.encrypted_token, document.accounts[0].id)).toMatchObject({
      authMode: 'unified_login',
      accessToken: 'suat-private',
      expiresAt: null,
      clientBusinessId: '444',
      configId,
      actorId: '333',
      deletionSubjectId: '333',
    });
    expect(saved.subject_fingerprint).toBe(subjectFingerprint('instagram_unified', '333'));
    expect(JSON.stringify(saved.document)).not.toContain('suat-private');
    expect(JSON.stringify(saved.document)).not.toContain('"444"');
    expect(saved.document.posts).toEqual(document.posts);
    expect(saved.document.statements).toEqual(document.statements);
  });
  it.each([
    'missing scope',
    'wrong app',
    'unshared account',
    'unexpected permission',
    'expired grant',
  ])('does not save %s', async (kind) => {
    grant({
      ...(kind === 'missing scope'
        ? { scopes: ['instagram_basic', 'instagram_manage_messages'] }
        : {}),
      ...(kind === 'wrong app' ? { app: '999' } : {}),
      ...(kind === 'unshared account' ? { username: 'someone' } : {}),
      ...(kind === 'unexpected permission'
        ? { scopes: [...scopes('instagram', 'unified_login'), 'ads_management'] }
        : {}),
      ...(kind === 'expired grant' ? { expiry: 1 } : {}),
    });
    await expect(callback()).rejects.toThrow();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'commit_direct_connection')).toBe(false);
  });
  it('rejects configuration changes while consent is in flight before contacting Meta', async () => {
    boundConfig = '999';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(callback()).rejects.toThrow('configuration changed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires the existing immutable Instagram ID on reconnect, not merely a recycled handle', async () => {
    document.accounts[0].provider_account_id = '555';
    document.accounts[0].integration = { instagramAuthMode: 'unified_login' };
    grant();
    await expect(callback()).rejects.toThrow('not shared');
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'commit_direct_connection')).toBe(false);
  });
  it('paginates assigned accounts using fixed-host cursors and fails incomplete pagination', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: '111', username: 'other' }],
        paging: { next: 'https://attacker.example/never', cursors: { after: 'cursor' } },
      })
      .mockResolvedValueOnce({ data: [{ id: '222', username: 'creator' }] });
    expect(
      await assignedInstagramAccounts('https://graph.facebook.com/v27.0', request)
    ).toHaveLength(2);
    expect(request.mock.calls[1][0]).toContain(
      'https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?'
    );
    expect(request.mock.calls[1][0]).toContain('after=cursor');
    request.mockResolvedValue({ data: [], paging: { next: 'next' } });
    await expect(
      assignedInstagramAccounts('https://graph.facebook.com/v27.0', request)
    ).rejects.toThrow('incomplete');
  });
  it('never refreshes a non-expiring SUAT through Instagram or requests business_management', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await new AccountToken('account', 'instagram', Date.now() + 10000).get()).toBe(
      'suat-private'
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(credential.scopes).not.toContain('business_management');
    credential.expiresAt = '2026-01-01T00:00:00Z';
    await expect(
      new AccountToken('account', 'instagram', Date.now() + 10000).get()
    ).rejects.toThrow('expired');
    expect(mocks.rpc).toHaveBeenCalledWith('forget_direct_credentials', {
      target_account: 'account',
      expected_version: 7,
    });
  });
});
