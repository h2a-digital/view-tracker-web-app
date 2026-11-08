import 'server-only';
import { configuration } from '@/lib/server/config';
export type DirectPlatform = 'youtube' | 'instagram' | 'facebook';
export function directPlatform(value: string): DirectPlatform {
  if (!['youtube', 'instagram', 'facebook'].includes(value))
    throw new Error('Unsupported direct platform.');
  return value as DirectPlatform;
}
export function oauthConfig(platform: DirectPlatform) {
  const google = platform === 'youtube';
  const clientId = google ? process.env.GOOGLE_CLIENT_ID : process.env.META_APP_ID;
  const clientSecret = google ? process.env.GOOGLE_CLIENT_SECRET : process.env.META_APP_SECRET;
  const version = process.env.META_GRAPH_VERSION || '';
  if (
    !clientId ||
    !clientSecret ||
    !process.env.OAUTH_TOKEN_ENCRYPTION_KEY ||
    (!google && !/^v\d+\.0$/.test(version))
  )
    throw new Error('Configure this provider and the OAuth encryption key before connecting.');
  return {
    clientId,
    clientSecret,
    version,
    loginConfigId: process.env.META_LOGIN_CONFIG_ID,
    redirectUri: new URL(`/api/oauth/${platform}/callback`, configuration().siteUrl).toString(),
  };
}
export function youtubePolicyApproved() {
  return process.env.YOUTUBE_ANALYTICS_POLICY_APPROVED === 'true';
}
export function scopes(platform: DirectPlatform) {
  return platform === 'youtube'
    ? [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ]
    : platform === 'instagram'
      ? ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights']
      : ['pages_show_list', 'pages_read_engagement', 'read_insights'];
}
