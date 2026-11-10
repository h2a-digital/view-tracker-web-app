import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  load: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
  adminDatabase: () => ({}),
}));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('@/services/profiles/metadata', () => ({ refreshProfile: mocks.refresh }));
import { POST } from '@/app/api/accounts/profile/route';
const id = 'b2000000-0000-4000-8000-000000000001';
const request = () =>
  new Request('https://hub.example.com/api/accounts/profile', {
    method: 'POST',
    body: JSON.stringify({ accountId: id }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({
    data: { accounts: [{ id, platform: 'instagram', provider: 'direct', status: 'connected' }] },
    revision: 5,
  });
  mocks.refresh.mockResolvedValue({ status: 'updated', processed: true });
});
it('authorizes admin and origin before touching profile providers', async () => {
  mocks.admin.mockRejectedValue(new Error('UNAUTHORIZED'));
  expect((await POST(request())).status).toBe(401);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it('rejects source-erased accounts instead of restoring their metadata', async () => {
  mocks.load.mockResolvedValue({
    data: {
      accounts: [
        {
          id,
          platform: 'instagram',
          provider: 'direct',
          status: 'connected',
          integration: { sourceErasedAt: 'erased' },
        },
      ],
    },
    revision: 5,
  });
  expect((await POST(request())).status).toBe(400);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it('returns the confirmed metadata result and refreshed dashboard', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect((await response.json()).result.status).toBe('updated');
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
