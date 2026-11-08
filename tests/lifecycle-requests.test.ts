import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/server/supabase', async () => ({
  ...(await vi.importActual<typeof import('@/lib/server/supabase')>('@/lib/server/supabase')),
  adminDatabase: () => ({ rpc: mocks.rpc }),
}));
import {
  verifyMetaRequest,
  metaRemoval,
  deleteFromLink,
  deletionStatus,
  deletionForm,
} from '@/services/lifecycle/requests';
const ticket = 'a'.repeat(64);
function signed(body: Record<string, unknown> = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      algorithm: 'HMAC-SHA256',
      user_id: '12345',
      issued_at: Math.floor(Date.now() / 1000),
      ...body,
    })
  ).toString('base64url');
  return createHmac('sha256', 'meta-secret').update(payload).digest('base64url') + '.' + payload;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CONTEXT', 'dev');
  vi.stubEnv('APP_URL', 'https://hub.example.com');
  vi.stubEnv('META_APP_SECRET', 'meta-secret');
  vi.stubEnv('OAUTH_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());
it('authenticates Meta deletion signatures and rejects tampering, wrong algorithms and future timestamps', () => {
  expect(verifyMetaRequest(signed()).subject).toMatch(/^[a-f0-9]{64}$/);
  expect(() => verifyMetaRequest(signed() + 'x')).toThrow();
  expect(() => verifyMetaRequest(signed({ algorithm: 'none' }))).toThrow();
  expect(() => verifyMetaRequest(signed({ issued_at: Date.now() / 1000 + 3600 }))).toThrow();
  expect(() => verifyMetaRequest(signed({ user_id: 'not-a-user' }))).toThrow();
});
it('processes authenticated Meta removals synchronously with an opaque confirmation code', async () => {
  const response = await metaRemoval(
    new Request('https://hub.example.com/api/oauth/meta/delete-data', {
      method: 'POST',
      body: new URLSearchParams({ signed_request: signed() }),
    })
  );
  const body = await response.json();
  expect(body.confirmation_code).toMatch(/^[a-f0-9]{64}$/);
  expect(body.url).toContain('/api/privacy/status?code=');
  expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain('12345');
  expect(mocks.rpc.mock.calls[0][0]).toBe('erase_meta_subject');
});
it('does not acknowledge deletion when database erasure failed', async () => {
  mocks.rpc.mockResolvedValue({ error: { message: 'failed' }, data: null });
  await expect(
    metaRemoval(
      new Request('https://hub.example.com', {
        method: 'POST',
        body: new URLSearchParams({ signed_request: signed() }),
      })
    )
  ).rejects.toThrow('Could not complete');
});
it('requires a valid private link, explicit confirmation and same-origin POST', async () => {
  const response = await deletionForm(
    new Request(`https://hub.example.com/integrations/delete-data/request?ticket=${ticket}`)
  );
  expect(await response.text()).toContain('does not delete any content');
  expect(response.headers.get('Referrer-Policy')).toBe('strict-origin');
  const req = (origin: string, confirm = 'delete') =>
    new Request('https://hub.example.com/integrations/delete-data/request', {
      method: 'POST',
      headers: { Origin: origin },
      body: new URLSearchParams({ ticket, confirm }),
    });
  await expect(deleteFromLink(req('https://attacker.example'))).rejects.toThrow('origin');
  await expect(deleteFromLink(req('https://hub.example.com', ''))).rejects.toThrow('Confirmation');
  expect((await deleteFromLink(req('https://hub.example.com'))).status).toBe(303);
  expect(mocks.rpc.mock.calls.at(-1)![0]).toBe('redeem_deletion_link');
});
it('does not expose account information through receipt lookup and rejects unknown receipts', async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  expect(
    (await deletionStatus(new Request('https://hub.example.com/api/privacy/status?code=guess')))
      .status
  ).toBe(404);
  expect(
    (await deletionStatus(new Request(`https://hub.example.com/api/privacy/status?code=${ticket}`)))
      .status
  ).toBe(404);
});

it('isolates Instagram signed callbacks by app secret and actor namespace from legacy Facebook grants', async () => {
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'instagram-secret');
  const payload = signed().split('.')[1];
  const instagram =
    createHmac('sha256', 'instagram-secret').update(payload).digest('base64url') + '.' + payload;
  expect(() => verifyMetaRequest(instagram)).toThrow();
  expect(() => verifyMetaRequest(signed(), 'instagram')).toThrow();
  expect(verifyMetaRequest(instagram, 'instagram').subject).not.toBe(
    verifyMetaRequest(signed()).subject
  );
  const response = await metaRemoval(
    new Request('https://hub.example.com/api/oauth/instagram/delete-data', {
      method: 'POST',
      body: new URLSearchParams({ signed_request: instagram }),
    }),
    'instagram'
  );
  expect(response.status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith(
    'erase_meta_subject',
    expect.objectContaining({
      subject_fingerprint: verifyMetaRequest(instagram, 'instagram').subject,
    })
  );
});

it('isolates Unified Login signed removals from both legacy Meta app secrets and fingerprint namespaces', async () => {
  vi.stubEnv('INSTAGRAM_META_APP_SECRET', 'unified-secret');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'instagram-secret');
  const payload = signed().split('.')[1];
  const request =
    createHmac('sha256', 'unified-secret').update(payload).digest('base64url') + '.' + payload;
  expect(() => verifyMetaRequest(request, 'meta')).toThrow();
  expect(() => verifyMetaRequest(request, 'instagram')).toThrow();
  expect(() => verifyMetaRequest(signed(), 'instagram_unified')).toThrow();
  const verified = verifyMetaRequest(request, 'instagram_unified');
  expect(verified.subject).not.toBe(verifyMetaRequest(signed()).subject);
  const response = await metaRemoval(
    new Request('https://hub.example.com/api/oauth/instagram/unified/delete-data', {
      method: 'POST',
      body: new URLSearchParams({ signed_request: request }),
    }),
    'instagram_unified'
  );
  expect(response.status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith(
    'erase_meta_subject',
    expect.objectContaining({ subject_fingerprint: verified.subject })
  );
});
