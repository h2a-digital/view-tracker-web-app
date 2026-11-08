import { NextResponse } from 'next/server';
import { requireAdmin, adminDatabase } from '@/lib/server/supabase';
import { apiError } from '@/lib/server/http';
import { configurationIssues } from '@/lib/server/deployment';
export async function GET() {
  try {
    await requireAdmin();
    const { data, error } = await adminDatabase().rpc('get_operations_status');
    if (error)
      throw new Error('Operations monitoring unavailable. Check the production migration.');
    return NextResponse.json(
      {
        ...data,
        configurationIssues: configurationIssues(process.env, true),
        integrations: {
          youtubeConfigured: !!(
            process.env.GOOGLE_CLIENT_ID &&
            process.env.GOOGLE_CLIENT_SECRET &&
            process.env.OAUTH_TOKEN_ENCRYPTION_KEY
          ),
          instagramConfigured: !!(
            process.env.INSTAGRAM_META_APP_ID &&
            process.env.INSTAGRAM_META_APP_SECRET &&
            process.env.INSTAGRAM_LOGIN_CONFIG_ID &&
            process.env.INSTAGRAM_GRAPH_VERSION &&
            process.env.OAUTH_TOKEN_ENCRYPTION_KEY
          ),
          metaConfigured: !!(
            process.env.META_APP_ID &&
            process.env.META_APP_SECRET &&
            process.env.META_GRAPH_VERSION &&
            process.env.OAUTH_TOKEN_ENCRYPTION_KEY
          ),
          youtubeCompensationApproved: process.env.YOUTUBE_ANALYTICS_POLICY_APPROVED === 'true',
          instagramOrganicDefinitionVerified:
            process.env.INSTAGRAM_ORGANIC_VIEWS_VERIFIED === 'true',
          facebookOrganicDefinitionVerified: process.env.FACEBOOK_ORGANIC_VIEWS_VERIFIED === 'true',
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
