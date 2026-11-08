/** Native POST forms need a non-opaque Origin; never send invitation paths as referrers. */
export const oauthFormReferrerPolicy = 'strict-origin';
export const oauthPlatforms = ['youtube', 'instagram', 'facebook'] as const;
export function oauthFormSecurity(platform: (typeof oauthPlatforms)[number]) {
  // Chromium also checks the destination of a POST's 303 redirect against form-action.
  // Limit this exception to the consent page and the selected provider's fixed host.
  const provider =
    platform === 'youtube' ? 'https://accounts.google.com' : 'https://www.facebook.com';
  return {
    'Referrer-Policy': oauthFormReferrerPolicy,
    'Content-Security-Policy': `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self' ${provider}`,
  };
}
