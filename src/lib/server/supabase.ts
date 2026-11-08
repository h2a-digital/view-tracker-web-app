import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { configuration, isConfigured } from './config';
import { assertLiveDeployment, hostedDeployment } from './deployment';
export function adminDatabase() {
  assertLiveDeployment();
  const c = configuration();
  if (!isConfigured()) throw new Error('Supabase is not configured. Follow the setup guide.');
  return createClient(c.url, c.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export async function sessionClient() {
  assertLiveDeployment();
  const c = configuration();
  const store = await cookies();
  return createServerClient(c.url, c.publicKey, {
    cookieOptions: { httpOnly: true, secure: hostedDeployment(), sameSite: 'lax' },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        for (const { name, value, options } of values) {
          try {
            store.set(name, value, options);
          } catch {
            /* Server Components cannot set cookies. */
          }
        }
      },
    },
  });
}
export async function requireAdmin() {
  assertLiveDeployment();
  if (!isConfigured()) throw new Error('SETUP_REQUIRED');
  const supabase = await sessionClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user || user.email?.toLowerCase() !== configuration().adminEmail)
    throw new Error('UNAUTHORIZED');
  const { data: admin } = await supabase
    .from('admin_users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!admin) throw new Error('UNAUTHORIZED');
  return user;
}
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = new URL(configuration().siteUrl).origin;
  if (!origin || origin !== expected) throw new Error('Invalid request origin.');
}
