import { startOAuth, oauthInvitation, oauthMessage } from '@/services/oauth/flow';
import { instagramBrowserHandoff } from '@/services/oauth/browser-handoff';
import { requireSameOrigin } from '@/lib/server/supabase';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  try {
    return await oauthInvitation(request, (await params).platform);
  } catch {
    return oauthMessage(
      'Connection could not start. Ask the administrator to check configuration and send a new invitation.',
      400
    );
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    requireSameOrigin(request);
    const form = await request.formData();
    if (form.get('consent') !== 'accepted' || typeof form.get('ticket') !== 'string')
      throw new Error('Consent required.');
    const url = new URL(request.url);
    url.search = '';
    url.searchParams.set('ticket', String(form.get('ticket')));
    const platform = (await params).platform;
    const response = await startOAuth(new Request(url), platform);
    return platform === 'instagram' ? instagramBrowserHandoff(response) : response;
  } catch {
    return oauthMessage(
      'Connection could not start. Accept the privacy policy using a valid invitation and try again.',
      400
    );
  }
}
