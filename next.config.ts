import type { NextConfig } from 'next';
import { deploymentEnvironment } from './src/lib/deployment-environment';
import { oauthPlatforms, oauthFormSecurity } from './src/lib/oauth-form-security';
const environment = deploymentEnvironment(process.env);
const config: NextConfig = {
  reactCompiler: true,
  // Safe build metadata only. Never add credentials to Next.js `env`.
  env: { APP_DEPLOYMENT_ENV: environment },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
          },
          ...(environment !== 'development'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
            : []),
        ],
      },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      // Override the global policies only for creator OAuth forms. Netlify applies
      // next.config headers too, so keep them aligned with the route response.
      ...oauthPlatforms.map((platform) => ({
        source: `/api/oauth/${platform}/start`,
        headers: Object.entries(oauthFormSecurity(platform)).map(([key, value]) => ({
          key,
          value,
        })),
      })),
    ];
  },
};
export default config;
