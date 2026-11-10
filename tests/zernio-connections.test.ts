import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  admin: vi.fn(),
  origin: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  adminDatabase: () => ({ rpc: mocks.rpc }),
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
}));
vi.mock('@/repositories/dashboard', () => ({
  loadDashboard: mocks.load,
  saveDashboard: mocks.save,
}));
vi.mock('@/services/oauth/flow', () => ({ directConnectionAction: vi.fn() }));
import { GET } from '@/app/api/connections/callback/route';
import { POST } from '@/app/api/connections/route';
const ticket = 'a'.repeat(64);
const callback = () =>
  new Request(`https://hub.example.com/api/connections/callback?ticket=${ticket}&accountId=remote`);
const account = () => ({
  id: 'local',
  platform: 'instagram',
  provider: 'zernio',
  username: 'creator',
  status: 'disconnected',
  provider_account_id: null,
  provider_profile_id: 'profile',
});
const remote = () => ({
  _id: 'remote',
  platform: 'instagram',
  username: 'creator',
  profileId: 'profile',
  isActive: true,
});
function accounts(value = remote()) {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ accounts: [value] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ZERNIO_API_KEY', 'test-key');
  vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('APP_URL', 'https://hub.example.com');
  mocks.load.mockResolvedValue({ data: { accounts: [account()], audit: [] }, revision: 7 });
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === 'read_connection' ? { account_id: 'local', profile_id: 'profile' } : true,
    error: null,
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('Instagram Zernio identity binding', () => {
  it('commits only the server-verified platform, profile and username, then queues tracking', async () => {
    accounts();
    expect((await GET(callback())).status).toBe(200);
    const commit = mocks.rpc.mock.calls.find(([name]) => name === 'commit_connection');
    expect(commit?.[1].document.accounts[0].provider_account_id).toBe('remote');
    expect(commit?.[1].document.accounts[0].status).toBe('connected');
    expect(mocks.rpc).toHaveBeenCalledWith('request_tracking', { target_account: 'local' });
  });
  it.each([
    { platform: 'tiktok' },
    { username: 'impostor' },
    { profileId: 'wrong' },
    { isActive: false },
  ])('rejects an unexpected account (%j)', async (patch) => {
    accounts({ ...remote(), ...patch });
    expect((await GET(callback())).status).toBe(400);
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'commit_connection')).toBe(false);
  });
  it('rejects replacing the immutable identity during reconnection', async () => {
    mocks.load.mockResolvedValue({
      data: { accounts: [{ ...account(), provider_account_id: 'original' }], audit: [] },
      revision: 7,
    });
    accounts();
    expect((await GET(callback())).status).toBe(400);
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'commit_connection')).toBe(false);
  });
  it('rejects replayed/expired tickets before provider access', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const fetch = accounts();
    expect((await GET(callback())).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('blocks disabled callbacks and connection starts before creating provider resources', async () => {
    vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'false');
    const fetch = accounts();
    expect((await GET(callback())).status).toBe(400);
    expect(
      (
        await POST(
          new Request('https://hub.example.com/api/connections', {
            method: 'POST',
            body: JSON.stringify({ accountId: 'local', action: 'connect' }),
          })
        )
      ).status
    ).toBeGreaterThanOrEqual(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('permits disconnection with the pilot disabled and preserves local history', async () => {
    vi.stubEnv('ZERNIO_INSTAGRAM_ENABLED', 'false');
    mocks.load.mockResolvedValue({
      data: {
        accounts: [{ ...account(), provider_account_id: 'remote' }],
        posts: [{ id: 'historical' }],
        snapshots: [{ id: 'snapshot' }],
        audit: [],
      },
      revision: 7,
    });
    const fetch = accounts();
    expect(
      (
        await POST(
          new Request('https://hub.example.com/api/connections', {
            method: 'POST',
            body: JSON.stringify({ accountId: 'local', action: 'disconnect' }),
          })
        )
      ).status
    ).toBe(200);
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
    expect(mocks.save.mock.calls[0][0].posts).toEqual([{ id: 'historical' }]);
    expect(mocks.save.mock.calls[0][0].snapshots).toEqual([{ id: 'snapshot' }]);
  });
});
