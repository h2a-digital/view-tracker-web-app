import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ start: vi.fn(), invite: vi.fn() }));
vi.mock('@/services/oauth/flow', () => ({
  startOAuth: mocks.start,
  oauthInvitation: mocks.invite,
  oauthMessage: () => new Response('Connection unavailable', { status: 400 }),
}));
import { GET, POST } from '@/app/api/oauth/[platform]/start/route';
const params = { params: Promise.resolve({ platform: 'youtube' }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'https://hub.example.com');
  mocks.start.mockResolvedValue(new Response(null, { status: 303 }));
  mocks.invite.mockResolvedValue(new Response('Consent form'));
});
afterEach(() => vi.unstubAllEnvs());
const request = (origin: string, consent = 'accepted') =>
  new Request('https://hub.example.com/api/oauth/youtube/start', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: 'a'.repeat(64), consent }),
  });
describe('public creator invitation route', () => {
  it('renders consent on GET without starting authorization', async () => {
    expect(
      (await GET(new Request('https://hub.example.com/api/oauth/youtube/start'), params)).status
    ).toBe(200);
    expect(mocks.invite).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('requires explicit consent and a same-origin POST', async () => {
    expect((await POST(request('https://attacker.example'), params)).status).toBe(400);
    expect((await POST(request('null'), params)).status).toBe(400);
    expect(
      (
        await POST(
          new Request('https://hub.example.com/api/oauth/youtube/start', {
            method: 'POST',
            body: new URLSearchParams({ ticket: 'a'.repeat(64), consent: 'accepted' }),
          }),
          params
        )
      ).status
    ).toBe(400);
    expect((await POST(request('https://hub.example.com', ''), params)).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await POST(request('https://hub.example.com'), params)).status).toBe(303);
    expect(new URL(mocks.start.mock.calls[0][0].url).searchParams.get('ticket')).toBe(
      'a'.repeat(64)
    );
  });
  it('accepts production-origin form bodies even when the adapter supplies an internal request URL', async () => {
    const form = new Request('http://localhost:8888/api/oauth/youtube/start', {
      method: 'POST',
      headers: {
        Origin: 'https://hub.example.com',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ticket: 'b'.repeat(64), consent: 'accepted' }),
    });
    expect((await POST(form, params)).status).toBe(303);
    expect(new URL(mocks.start.mock.calls[0][0].url).searchParams.get('ticket')).toBe(
      'b'.repeat(64)
    );
  });
});
