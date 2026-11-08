import { finishOAuth, oauthMessage } from '@/services/oauth/flow';
import { OAuthCallbackFailure, reportCallbackFailure } from '@/services/oauth/diagnostics';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  try {
    return await finishOAuth(request, (await params).platform);
  } catch (error) {
    const failure =
      error instanceof OAuthCallbackFailure
        ? error
        : reportCallbackFailure({ stage: 'route', platform: 'unknown' }, error);
    return oauthMessage(
      `Connection could not complete. Request a new invitation. Reference: ${failure.reference}. The administrator can find the failure stage in the server logs.`,
      400
    );
  }
}
