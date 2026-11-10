/** Only browser-loaded HTTPS images from platform CDNs; never proxy/download avatars. */
export function providerImageUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    const hosts = [
      'cdninstagram.com',
      'fbcdn.net',
      'tiktokcdn.com',
      'tiktokcdn-us.com',
      'tiktokcdn-eu.com',
      'tiktok.com',
      'ibytedtos.com',
      'byteoversea.com',
      'ytimg.com',
      'ggpht.com',
      'googleusercontent.com',
      'zernio.com',
      'getlate.dev',
    ];
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !['access_token', 'client_secret', 'appsecret_proof'].some((key) =>
        url.searchParams.has(key)
      ) &&
      // TikTok signed CDN images use this name for an image signature, not an OAuth token.
      (!url.searchParams.has('refresh_token') ||
        ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com'].some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
        )) &&
      hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    )
      return value;
  } catch {
    /* Invalid URLs use a local fallback. */
  }
  return undefined;
}
