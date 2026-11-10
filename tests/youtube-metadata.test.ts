import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { seedData } from '@/domain/commands';
import type { SocialAccount } from '@/domain/model';
const mocks = vi.hoisted(() => ({ request: vi.fn(), public: vi.fn() }));
vi.mock('@/services/tracking/direct/base', () => ({
  DirectAccess: class {
    request = mocks.request;
  },
}));
vi.mock('@/services/oauth/http', () => ({ providerJson: mocks.public }));
import { lookupYouTubeMetadata } from '@/services/youtube/metadata';
const first = `UC${'a'.repeat(22)}`,
  second = `UC${'b'.repeat(22)}`;
const account = (id: string, remote: string | null): SocialAccount => ({
  id,
  creator_id: 'creator',
  platform: 'youtube',
  username: id === 'one' ? first : second,
  provider: 'direct',
  ownership: 'creator',
  provider_account_id: remote,
  provider_profile_id: null,
  status: remote ? 'connected' : 'registered',
  last_synced_at: null,
  error: null,
});
const item = (id: string, title: string) => ({
  id,
  snippet: {
    title,
    customUrl: `@${title.toLowerCase()}`,
    thumbnails: { default: { url: 'https://yt3.ggpht.com/avatar' } },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('YOUTUBE_DATA_API_KEY', '');
});
afterEach(() => vi.unstubAllEnvs());
it('backfills connected and registered channel IDs in one public read using existing OAuth, without connecting or changing identity', async () => {
  const d = seedData();
  d.accounts = [account('one', first), account('two', null)];
  const before = JSON.stringify(d);
  mocks.request.mockResolvedValue({ items: [item(first, 'Atalaya'), item(second, 'Studio')] });
  const results = await lookupYouTubeMetadata(d, d.accounts);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  const url = new URL(mocks.request.mock.calls[0][0]);
  expect(url.searchParams.get('id')).toBe(`${first},${second}`);
  expect(url.searchParams.has('mine')).toBe(false);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        accountId: 'one',
        status: 'updated',
        identity: expect.objectContaining({ title: 'Atalaya', handle: '@atalaya' }),
      }),
      expect.objectContaining({
        accountId: 'two',
        status: 'updated',
        identity: expect.objectContaining({ title: 'Studio' }),
      }),
    ])
  );
  expect(JSON.stringify(d)).toBe(before);
});
it('supports registered accounts with a restricted server key and never puts the key in URLs', async () => {
  vi.stubEnv('YOUTUBE_DATA_API_KEY', 'private-key');
  const d = seedData();
  d.accounts = [account('two', null)];
  mocks.public.mockResolvedValue({ items: [item(second, 'Studio')] });
  expect((await lookupYouTubeMetadata(d, d.accounts))[0].identity?.title).toBe('Studio');
  expect(mocks.public.mock.calls[0][0]).not.toContain('private-key');
  expect(mocks.public.mock.calls[0][1]).toEqual({ headers: { 'X-Goog-Api-Key': 'private-key' } });
  expect(mocks.request).not.toHaveBeenCalled();
});
it('explains missing credentials without requesting new OAuth or inventing metadata', async () => {
  const d = seedData();
  d.accounts = [account('two', null)];
  expect((await lookupYouTubeMetadata(d, d.accounts))[0].status).toBe('credentials_required');
  expect(mocks.public).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
it('never attaches a different returned channel to the registered immutable ID', async () => {
  const d = seedData();
  d.accounts = [account('one', first)];
  mocks.request.mockResolvedValue({ items: [item(second, 'Wrong')] });
  expect((await lookupYouTubeMetadata(d, d.accounts))[0]).toMatchObject({
    status: 'not_found',
    identity: undefined,
  });
});
it('avoids repeat calls for a recently cached identity', async () => {
  const d = seedData();
  d.accounts = [account('one', first)];
  d.accounts[0].integration = {
    channelIdentity: { title: 'Cached', refreshedAt: new Date().toISOString() },
  };
  expect((await lookupYouTubeMetadata(d, d.accounts))[0].status).toBe('cached');
  expect(mocks.request).not.toHaveBeenCalled();
});
it('handles unavailable or malformed metadata without exposing provider payloads', async () => {
  const d = seedData();
  d.accounts = [account('one', first)];
  mocks.request.mockResolvedValue({ secret: 'DO_NOT_EXPOSE' });
  const result = await lookupYouTubeMetadata(d, d.accounts);
  expect(result[0].status).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
});
