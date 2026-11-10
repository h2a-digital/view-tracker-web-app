import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  rpc: vi.fn(),
  load: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
  adminDatabase: () => ({ rpc: mocks.rpc }),
}));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('@/services/youtube/metadata', () => ({ lookupYouTubeMetadata: mocks.lookup }));
import { POST } from '@/app/api/accounts/youtube/metadata/route';
const id = 'b2000000-0000-4000-8000-000000000001';
const account = {
  id,
  platform: 'youtube',
  username: 'UC_REGISTERED',
  provider_account_id: null,
  status: 'registered',
};
const request = () =>
  new Request('https://hub.example.com/api/accounts/youtube/metadata', {
    method: 'POST',
    body: JSON.stringify({ accountIds: [id] }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ data: { accounts: [account] }, revision: 5 });
  mocks.lookup.mockResolvedValue([
    {
      accountId: id,
      status: 'updated',
      identity: { title: 'Atalaya', refreshedAt: new Date().toISOString() },
    },
  ]);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});
it('requires same-origin administrator authorization before reading accounts or calling Google', async () => {
  mocks.admin.mockRejectedValue(new Error('UNAUTHORIZED'));
  expect((await POST(request())).status).toBe(401);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it('rejects cross-origin mutations before provider or database access', async () => {
  mocks.origin.mockImplementation(() => {
    throw new Error('Invalid origin');
  });
  expect((await POST(request())).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it('persists with identity binding and returns dashboard metadata without exposing credentials', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith(
    'cache_youtube_channel_identity',
    expect.objectContaining({
      target_account: id,
      expected_username: 'UC_REGISTERED',
      expected_channel: null,
      lookup_status: 'updated',
    })
  );
});
it('rejects unavailable/erased accounts instead of restoring deleted provider data', async () => {
  mocks.load.mockResolvedValue({
    data: { accounts: [{ ...account, integration: { sourceErasedAt: new Date().toISOString() } }] },
    revision: 5,
  });
  expect((await POST(request())).status).toBe(400);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it('does not report an update when persistence fails or the account changed concurrently', async () => {
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'missing function' } });
  expect((await POST(request())).status).toBe(400);
  mocks.rpc.mockResolvedValue({ data: false, error: null });
  const body = await (await POST(request())).json();
  expect(body.results[0].status).toBe('changed');
});
