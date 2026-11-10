import { afterEach, it, expect, vi } from 'vitest';
import { requestJson } from '@/lib/client/request';
import { channelIdentity } from '@/services/youtube/identity';
afterEach(() => vi.unstubAllGlobals());
it('does not report success when the server rejects a mutation', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Conflict. Refresh first.' }), { status: 400 })
      )
  );
  await expect(requestJson('/api/dashboard', { method: 'POST' })).rejects.toThrow(/Conflict/);
});
it('provides actionable timeout feedback without implying rollback', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timeout', 'TimeoutError')));
  await expect(requestJson('/api/dashboard')).rejects.toThrow(/server may still finish/);
});
it('keeps missing channel metadata optional and rejects unsafe avatar hosts', () => {
  expect(channelIdentity({ customUrl: 'legacy-alias' })).toBeUndefined();
  expect(
    channelIdentity({
      title: 'Atalaya',
      customUrl: '@atalaya',
      thumbnails: { default: { url: 'https://attacker.example/avatar' } },
    })
  ).toMatchObject({ title: 'Atalaya', handle: '@atalaya', avatarUrl: undefined });
});
