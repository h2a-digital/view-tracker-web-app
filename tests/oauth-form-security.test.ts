import { describe, it, expect } from 'vitest';
import config from '../next.config';
import { oauthFormSecurity, oauthPlatforms } from '@/lib/oauth-form-security';
describe('OAuth native-form response policies', () => {
  it.each(oauthPlatforms)(
    'keeps %s form Origin usable and restricts redirect destinations',
    (platform) => {
      const headers = oauthFormSecurity(platform);
      expect(headers['Referrer-Policy']).toBe('strict-origin');
      const csp = headers['Content-Security-Policy'];
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain(
        platform === 'youtube' ? 'https://accounts.google.com' : 'https://www.facebook.com'
      );
      expect(csp).not.toContain(platform === 'youtube' ? 'facebook.com' : 'accounts.google.com');
      expect(csp).not.toContain('*');
    }
  );
  it('overrides Netlify/Next global headers only for the three direct consent paths', async () => {
    const rules = await config.headers!();
    const global = rules.find((r) => r.source === '/:path*')!;
    expect(global.headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
    expect(global.headers.find((h) => h.key === 'Content-Security-Policy')?.value).toContain(
      "form-action 'self'"
    );
    const formRules = rules.filter((r) => r.source.startsWith('/api/oauth/'));
    expect(formRules.map((r) => r.source)).toEqual(
      oauthPlatforms.map((p) => `/api/oauth/${p}/start`)
    );
    for (const [i, platform] of oauthPlatforms.entries()) {
      expect(Object.fromEntries(formRules[i].headers.map((h) => [h.key, h.value]))).toEqual(
        oauthFormSecurity(platform)
      );
      expect(rules.indexOf(formRules[i])).toBeGreaterThan(rules.indexOf(global));
    }
  });
});
