import 'server-only';
import { deploymentEnvironment, type Environment } from '@/lib/deployment-environment';
const loopback = (hostname: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
/** A local production build is still localhost: NODE_ENV alone must not permit writes to the shared project. */
export function thumbnailPersistenceAllowed(
  env: Environment = { ...process.env, APP_DEPLOYMENT_ENV: process.env.APP_DEPLOYMENT_ENV }
): boolean {
  try {
    if (deploymentEnvironment(env) === 'preview') return false;
    const localApp = loopback(new URL(env.APP_URL || 'http://localhost:3000').hostname);
    if (localApp) return loopback(new URL(env.NEXT_PUBLIC_SUPABASE_URL || '').hostname);
    return deploymentEnvironment(env) === 'production';
  } catch {
    return false;
  }
}
