import 'server-only';
type Environment = Record<string, string | undefined>;
export function hostedPreview(env: Environment = process.env) {
  return env.VERCEL_ENV === 'preview';
}
export function hostedDeployment(env: Environment = process.env) {
  return env.VERCEL === '1' || env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
}
export function configurationIssues(env: Environment = process.env, worker = false): string[] {
  const issues: string[] = [];
  for (const name of [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'ADMIN_EMAIL',
    'APP_URL',
  ]) {
    const value =
      name === 'SUPABASE_SECRET_KEY'
        ? env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
        : env[name];
    if (!value) issues.push(`${name} is required`);
  }
  const publicKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!publicKey) issues.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required');
  if (publicKey?.startsWith('sb_secret_'))
    issues.push('The public Supabase key must not be a secret key');
  if (publicKey?.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(publicKey.split('.')[1], 'base64url').toString());
      if (payload.role === 'service_role')
        issues.push('The public Supabase key must not be a service-role key');
    } catch {
      issues.push('The public Supabase JWT key is malformed');
    }
  }
  if (env.ADMIN_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL.trim()))
    issues.push('ADMIN_EMAIL must be an email address');
  if (env.APP_URL) {
    try {
      const url = new URL(env.APP_URL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        issues.push('APP_URL must be an absolute origin without credentials, a path or query');
      if (
        hostedDeployment(env) &&
        (url.protocol !== 'https:' ||
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
          url.hostname.endsWith('.localhost'))
      )
        issues.push('Hosted APP_URL must use a public HTTPS origin');
    } catch {
      issues.push('APP_URL is invalid');
    }
  }
  if (env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).protocol !== 'https:' && hostedDeployment(env))
        issues.push('Hosted Supabase URL must use HTTPS');
    } catch {
      issues.push('Supabase URL is invalid');
    }
  }
  if (worker) {
    if (!env.ZERNIO_API_KEY) issues.push('ZERNIO_API_KEY is required');
    if (!env.CRON_SECRET || env.CRON_SECRET.length < 32 || /\s/.test(env.CRON_SECRET))
      issues.push('CRON_SECRET must contain at least 32 characters without whitespace');
  }
  return issues;
}
export function assertLiveDeployment() {
  if (hostedPreview()) throw new Error('PREVIEW_DISABLED');
  if (hostedDeployment() && configurationIssues().length) throw new Error('SETUP_REQUIRED');
}
