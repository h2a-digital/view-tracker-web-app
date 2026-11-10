import { seedData } from '@/domain/commands';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  rpc: vi.fn(),
  load: vi.fn(),
  remote: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
  adminDatabase: () => ({ rpc: mocks.rpc }),
}));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('@/services/tracking/zernio', () => ({
  ZernioProvider: class {
    listAccounts = mocks.remote;
  },
}));
import { POST, GET } from '@/app/api/manage/route';
const id = 'b1000000-0000-4000-8000-000000000001';
const request = () =>
  new Request('https://hub.example.com/api/manage', {
    method: 'POST',
    body: JSON.stringify({ entity: 'account', id, operation: 'remove' }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ data: { ...seedData(), accounts: [] }, revision: 5 });
  mocks.rpc.mockResolvedValue({ data: [], error: null });
});
afterEach(() => vi.unstubAllEnvs());
it('requires an administrator before reading data or issuing a mutation', async () => {
  mocks.admin.mockRejectedValue(new Error('UNAUTHORIZED'));
  expect((await POST(request())).status).toBe(401);
  expect(
    (await GET(new Request(`https://hub.example.com/api/manage?accountId=${id}`))).status
  ).toBe(401);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});
it('rejects cross-origin mutation attempts before database access', async () => {
  mocks.origin.mockImplementation(() => {
    throw new Error('Invalid origin');
  });
  expect((await POST(request())).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('uses an atomic revision-checked management operation', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith('manage_dashboard_record', {
    expected_revision: 5,
    entity: 'account',
    target: id,
    operation: 'remove',
  });
});
it('refuses to strand a still-connected remote Zernio identity', async () => {
  mocks.load.mockResolvedValue({
    data: {
      accounts: [{ id, provider: 'zernio', provider_profile_id: 'profile', platform: 'instagram' }],
    },
    revision: 5,
  });
  mocks.remote.mockResolvedValue([{ platform: 'instagram', profileId: 'profile' }]);
  expect((await POST(request())).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
