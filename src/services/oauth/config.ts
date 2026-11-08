import 'server-only';
import type { SocialAccount } from '@/domain/model';
import { configuration } from '@/lib/server/config';
export type DirectPlatform = 'youtube' | 'instagram' | 'facebook';
export function directPlatform(value: string): DirectPlatform {
  if (!['youtube', 'instagram', 'facebook'].includes(value))
    throw new Error('Unsupported direct platform.');
  return value as DirectPlatform;
}
export type InstagramAuthMode = 'instagram_login' | 'facebook_login' | 'unified_login';
/** Missing mode on an existing remote identity means the original Facebook grant. */
export function instagramAuthMode(account: SocialAccount): InstagramAuthMode {
  const mode = account.integration?.instagramAuthMode;
  // Unconnected registrations made before Unified Login have no grant to preserve.
  if (!account.provider_account_id && (!mode || mode === 'instagram_login')) return 'unified_login';
  return mode ?? 'facebook_login';
}
export function metaGraphOrigin(account: SocialAccount) {
  const mode = account.platform === 'instagram' ? instagramAuthMode(account) : 'facebook_login';
  const c = oauthConfig(account.platform as 'instagram' | 'facebook', mode);
  return `https://${mode === 'instagram_login' ? 'graph.instagram.com' : 'graph.facebook.com'}/${c.version}`;
}
export function oauthConfig(platform: DirectPlatform, mode: InstagramAuthMode = 'facebook_login') {
  const google = platform === 'youtube';
  const instagram = platform === 'instagram' && mode === 'instagram_login';
  const unified = platform === 'instagram' && mode === 'unified_login';
  const clientId = google
    ? process.env.GOOGLE_CLIENT_ID
    : instagram
      ? process.env.INSTAGRAM_APP_ID
      : unified
        ? process.env.INSTAGRAM_META_APP_ID
        : process.env.META_APP_ID;
  const clientSecret = google
    ? process.env.GOOGLE_CLIENT_SECRET
    : instagram
      ? process.env.INSTAGRAM_APP_SECRET
      : unified
        ? process.env.INSTAGRAM_META_APP_SECRET
        : process.env.META_APP_SECRET;
  const version =
    (instagram || unified ? process.env.INSTAGRAM_GRAPH_VERSION : process.env.META_GRAPH_VERSION) ||
    '';
  if (
    !clientId ||
    !clientSecret ||
    !process.env.OAUTH_TOKEN_ENCRYPTION_KEY ||
    (!google && !/^v\d+\.0$/.test(version)) ||
    (unified && !/^\d+$/.test(process.env.INSTAGRAM_LOGIN_CONFIG_ID || ''))
  )
    throw new Error('Configure this provider and the OAuth encryption key before connecting.');
  return {
    clientId,
    clientSecret,
    version,
    loginConfigId: unified
      ? process.env.INSTAGRAM_LOGIN_CONFIG_ID
      : process.env.META_LOGIN_CONFIG_ID,
    redirectUri: new URL(`/api/oauth/${platform}/callback`, configuration().siteUrl).toString(),
  };
}
export function youtubePolicyApproved() {
  return process.env.YOUTUBE_ANALYTICS_POLICY_APPROVED === 'true';
}
export function scopes(platform: DirectPlatform, mode: InstagramAuthMode = 'facebook_login') {
  if (platform === 'instagram' && mode === 'unified_login')
    return ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_insights'];
  if (platform === 'instagram' && mode === 'instagram_login')
    return ['instagram_business_basic', 'instagram_business_manage_insights'];
  return platform === 'youtube'
    ? [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ]
    : platform === 'instagram'
      ? ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights']
      : ['pages_show_list', 'pages_read_engagement', 'read_insights'];
}
