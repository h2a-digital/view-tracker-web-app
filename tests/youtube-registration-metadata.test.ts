import { beforeEach, it, expect, vi } from 'vitest';
import { seedData, runCommand } from '@/domain/commands';
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
}));
vi.mock('@/repositories/dashboard', () => ({
  loadDashboard: mocks.load,
  saveDashboard: mocks.save,
}));
vi.mock('@/services/youtube/metadata', () => ({ lookupYouTubeMetadata: mocks.lookup }));
import { POST } from '@/app/api/dashboard/route';
let d = seedData();
beforeEach(() => {
  vi.resetAllMocks();
  d = runCommand(seedData(), { type: 'createCreator', name: 'Creator' });
  mocks.admin.mockResolvedValue({ email: 'admin@example.com' });
  mocks.load.mockResolvedValue({ data: d, revision: 3 });
});
const request = () =>
  new Request('https://hub.example.com/api/dashboard', {
    method: 'POST',
    body: JSON.stringify({
      type: 'registerAccount',
      creatorId: d.creators[0].id,
      platform: 'youtube',
      username: `UC${'a'.repeat(22)}`,
      provider: 'direct',
      ownership: 'creator',
    }),
  });
it('retrieves and saves public labels during registration while keeping the channel unconnected', async () => {
  mocks.lookup.mockResolvedValue([
    {
      status: 'updated',
      identity: { title: 'Atalaya', handle: '@atalaya', refreshedAt: new Date().toISOString() },
    },
  ]);
  const result = await POST(request());
  expect(result.status).toBe(200);
  const account = (await result.json()).data.accounts[0];
  expect(account.integration.channelIdentity.title).toBe('Atalaya');
  expect(account.status).toBe('registered');
  expect(account.provider_account_id).toBeNull();
  expect(mocks.save).toHaveBeenCalledOnce();
});
it('does not make successful registration depend on provider availability', async () => {
  mocks.lookup.mockResolvedValue([{ status: 'unavailable' }]);
  const result = await POST(request());
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.notice).toContain('Account registered');
  expect(body.data.accounts[0].integration?.channelIdentity).toBeUndefined();
});
