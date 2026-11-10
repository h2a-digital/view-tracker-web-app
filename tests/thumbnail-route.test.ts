import { beforeEach, it, expect, vi } from 'vitest';
import { populatedDocument } from './helpers/dashboard';
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  provider: vi.fn(),
  refresh: vi.fn(),
  allow: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
}));
vi.mock('@/repositories/dashboard', () => ({
  loadDashboard: mocks.load,
  saveDashboard: mocks.save,
}));
vi.mock('@/services/tracking/registry', () => ({ trackingProvider: mocks.provider }));
vi.mock('@/services/tracking/thumbnail-refresh', () => ({ loadMissingThumbnails: mocks.refresh }));
vi.mock('@/lib/server/thumbnail-policy', () => ({ thumbnailPersistenceAllowed: mocks.allow }));
import { POST } from '@/app/api/accounts/thumbnails/route';
let data: ReturnType<typeof populatedDocument>;
const request = (extra = {}) =>
  new Request('https://hub.example.com/api/accounts/thumbnails', {
    method: 'POST',
    body: JSON.stringify({ accountId: data.accounts[0].id, ...extra }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  data = populatedDocument();
  data.accounts[0].status = 'connected';
  data.accounts[0].provider_account_id = 'remote';
  mocks.load.mockResolvedValue({ data, revision: 5 });
  mocks.allow.mockReturnValue(false);
  mocks.refresh.mockResolvedValue({
    overrides: [
      {
        postId: data.posts[0].id,
        accountId: data.accounts[0].id,
        providerAccountId: 'remote',
        platformPostId: data.posts[0].platform_post_id,
        thumbnail: {
          url: 'https://media.zernio.com/cover.jpg',
          capturedAt: new Date().toISOString(),
        },
      },
    ],
    requested: 1,
    unavailable: 0,
    deferred: false,
  });
});
it('requires admin and same-origin before loading providers', async () => {
  mocks.admin.mockRejectedValue(new Error('UNAUTHORIZED'));
  expect((await POST(request())).status).toBe(401);
  expect(mocks.provider).not.toHaveBeenCalled();
  mocks.admin.mockResolvedValue({});
  mocks.origin.mockImplementation(() => {
    throw new Error('Invalid request origin.');
  });
  expect((await POST(request())).status).toBe(400);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it('returns usable session previews without writing remote production data', async () => {
  const result = await POST(request()),
    body = await result.json();
  expect(result.status).toBe(200);
  expect(body.result.mode).toBe('session');
  expect(body.data.posts[0].tracking.thumbnail.url).toContain('media.zernio.com');
  expect(mocks.save).not.toHaveBeenCalled();
  expect(body.asOf).toMatch(/Z$/);
  expect(result.headers.get('cache-control')).toBe('no-store');
});
it('persists only media changes when permitted and reports a failed revision save as failure', async () => {
  mocks.allow.mockReturnValue(true);
  expect((await POST(request())).status).toBe(200);
  const next = mocks.save.mock.calls[0][0];
  expect(next.snapshots).toEqual(data.snapshots);
  expect(next.statements).toEqual(data.statements);
  expect(next.mappings).toEqual(data.mappings);
  expect(next.posts[0].eligible_views).toBe(data.posts[0].eligible_views);
  mocks.save.mockRejectedValue(
    new Error('Another operation changed these records. Refresh and try again.')
  );
  expect((await POST(request())).status).toBe(400);
});
it('rejects erased accounts and cannot be switched into write mode through client parameters', async () => {
  expect((await POST(request({ persist: true }))).status).toBe(400);
  expect(mocks.refresh).not.toHaveBeenCalled();
  data.accounts[0].integration = { sourceErasedAt: '2026-11-10T12:00:00Z' };
  expect((await POST(request())).status).toBe(400);
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('revalidates source and connection state after retrieval instead of reintroducing erased previews', async () => {
  const current = structuredClone(data);
  current.accounts[0].status = 'disconnected';
  current.accounts[0].integration = { sourceErasedAt: new Date().toISOString() };
  mocks.load
    .mockResolvedValueOnce({ data, revision: 5 })
    .mockResolvedValueOnce({ data: current, revision: 6 });
  const result = await POST(request());
  expect(result.status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});
