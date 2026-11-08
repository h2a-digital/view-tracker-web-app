import 'server-only';
export function configuration() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    publicKey:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      '',
    secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    siteUrl: process.env.APP_URL || 'http://localhost:3000',
    adminEmail: process.env.ADMIN_EMAIL?.toLowerCase() || '',
    zernioKey: process.env.ZERNIO_API_KEY || '',
    cronSecret: process.env.CRON_SECRET || '',
  };
}
export function isConfigured() {
  const c = configuration();
  return !!(c.url && c.publicKey && c.secretKey && c.adminEmail);
}
