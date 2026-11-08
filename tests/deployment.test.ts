import { describe, it, expect, vi, afterEach } from 'vitest';
import { configurationIssues, assertLiveDeployment } from '@/lib/server/deployment';
import {
  deploymentEnvironment,
  hostedDeployment,
  hostedPreview,
  type Environment,
} from '@/lib/deployment-environment';
const valid = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  ADMIN_EMAIL: 'admin@example.com',
  APP_URL: 'https://ledger.example.com',
  ZERNIO_API_KEY: 'private',
  CRON_SECRET: 'x'.repeat(32),
  CONTEXT: 'production',
};
afterEach(() => vi.unstubAllEnvs());
describe('production deployment configuration', () => {
  it('accepts a secure production configuration and local development origin', () => {
    expect(configurationIssues(valid, true)).toEqual([]);
    expect(
      configurationIssues({ ...valid, CONTEXT: 'dev', APP_URL: 'http://localhost:3000' }, true)
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
    vi.stubEnv('CONTEXT', 'deploy-preview');
    expect(() => assertLiveDeployment()).toThrow('PREVIEW_DISABLED');
  });
});

describe('portable hosting detection', () => {
  it.each<[Environment, string]>([
    [{ CONTEXT: 'production', NETLIFY: 'true' }, 'production'],
    [{ CONTEXT: 'deploy-preview', APP_DEPLOYMENT_ENV: 'production' }, 'preview'],
    [{ CONTEXT: 'branch-deploy', APP_DEPLOYMENT_ENV: 'production' }, 'preview'],
    [{ CONTEXT: 'staging' }, 'preview'],
    [{ CONTEXT: 'production', APP_DEPLOYMENT_ENV: 'preview' }, 'preview'],
    [{ APP_DEPLOYMENT_ENV: 'preview', NODE_ENV: 'production' }, 'preview'],
    [{ APP_DEPLOYMENT_ENV: 'production', NODE_ENV: 'production' }, 'production'],
    [{ APP_DEPLOYMENT_ENV: 'unexpected' }, 'preview'],
    [{ NETLIFY: 'true' }, 'preview'],
    [{ CONTEXT: 'dev', NODE_ENV: 'development' }, 'development'],
    [{ NODE_ENV: 'development' }, 'development'],
    [{ NODE_ENV: 'production' }, 'production'],
    [{}, 'development'],
  ])('classifies %j as %s', (env, expected) => {
    expect(deploymentEnvironment(env)).toBe(expected);
    expect(hostedDeployment(env)).toBe(expected !== 'development');
    expect(hostedPreview(env)).toBe(expected === 'preview');
  });
  it('blocks a preview artifact when the runtime has no Netlify context', () => {
    vi.stubEnv('CONTEXT', '');
    vi.stubEnv('APP_DEPLOYMENT_ENV', 'preview');
    expect(() => assertLiveDeployment()).toThrow('PREVIEW_DISABLED');
  });
});
