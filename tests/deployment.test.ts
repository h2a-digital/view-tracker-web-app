import { describe, it, expect, vi, afterEach } from 'vitest';
import { configurationIssues, assertLiveDeployment } from '@/lib/server/deployment';
const valid = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  ADMIN_EMAIL: 'admin@example.com',
  APP_URL: 'https://ledger.example.com',
  ZERNIO_API_KEY: 'private',
  CRON_SECRET: 'x'.repeat(32),
  VERCEL_ENV: 'production',
};
afterEach(() => vi.unstubAllEnvs());
describe('production deployment configuration', () => {
  it('accepts a secure production configuration and local development origin', () => {
    expect(configurationIssues(valid, true)).toEqual([]);
    expect(
      configurationIssues(
        { ...valid, VERCEL_ENV: 'development', APP_URL: 'http://localhost:3000' },
        true
      )
    ).toEqual([]);
  });
  it.each([
    'http://example.com',
    'https://localhost',
    'https://user:password@example.com',
    'https://example.com/callback',
    'https://example.com?secret=x',
  ])('rejects unsafe APP_URL %s', (APP_URL) => {
    expect(configurationIssues({ ...valid, APP_URL })).not.toEqual([]);
  });
  it('rejects client-side secrets and short scheduler tokens', () => {
    expect(
      configurationIssues(
        { ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_wrong', CRON_SECRET: 'short' },
        true
      )
    ).toHaveLength(2);
    const jwt =
      'a.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.b';
    expect(configurationIssues({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt })).toContain(
      'The public Supabase key must not be a service-role key'
    );
  });
  it('blocks preview live database use even if production keys were mistakenly configured', () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(() => assertLiveDeployment()).toThrow('PREVIEW_DISABLED');
  });
});
