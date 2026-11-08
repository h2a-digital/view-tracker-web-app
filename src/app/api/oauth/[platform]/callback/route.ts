import { finishOAuth, oauthMessage } from '@/services/oauth/flow';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  try {
    return await finishOAuth(request, (await params).platform);
  } catch {
    return oauthMessage(
      'Connection could not complete. Check the registered account, required permissions and browser cookies, then request a new invitation.',
      400
    );
  }
}
