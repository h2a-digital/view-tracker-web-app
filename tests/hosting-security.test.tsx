import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createClient: vi.fn(),
  getAll: vi.fn(),
  set: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: mocks.getAll, set: mocks.set }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { sessionClient, adminDatabase } from '@/lib/server/supabase';
import Page from '@/app/page';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('Netlify security protections', () => {
  it('sets secure HTTP-only session cookies on production Netlify', async () => {
    vi.stubEnv('CONTEXT', 'production');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test');
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.stubEnv('APP_URL', 'https://hub.example.com');
    await sessionClient();
    expect(mocks.createServerClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'sb_publishable_test',
      expect.objectContaining({ cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax' } })
    );
  });
  it.each(['deploy-preview', 'branch-deploy', 'staging'])(
    'rejects live clients and public demo on %s',
    async (context) => {
      vi.stubEnv('CONTEXT', context);
      expect(() => adminDatabase()).toThrow('PREVIEW_DISABLED');
      await expect(sessionClient()).rejects.toThrow('PREVIEW_DISABLED');
      const html = renderToStaticMarkup(
        await Page({ searchParams: Promise.resolve({ preview: '1' }) })
      );
      expect(html).toContain('Live access is disabled on preview deployments.');
      expect(html).not.toContain('LOCAL PREVIEW');
      expect(mocks.createServerClient).not.toHaveBeenCalled();
      expect(mocks.createClient).not.toHaveBeenCalled();
    }
  );
  it('builds HSTS and safe context metadata for Netlify production', async () => {
    vi.stubEnv('CONTEXT', 'production');
    vi.resetModules();
    const { default: config } = await import('../next.config');
    expect(config.env).toEqual({ APP_DEPLOYMENT_ENV: 'production' });
    const rules = await config.headers!();
    expect(rules.find((r) => r.source === '/:path*')?.headers).toContainEqual({
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000',
    });
    expect(rules.find((r) => r.source === '/api/:path*')?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'no-store',
    });
  });
});
