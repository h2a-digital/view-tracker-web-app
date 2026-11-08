import { deletionForm, deleteFromLink } from '@/services/lifecycle/requests';
import { oauthMessage } from '@/services/oauth/flow';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    return await deletionForm(request);
  } catch {
    return oauthMessage(
      'Deletion link is invalid or expired. Request a new deletion link from the administrator.',
      400
    );
  }
}
export async function POST(request: Request) {
  try {
    return await deleteFromLink(request);
  } catch {
    return oauthMessage(
      'Deletion did not complete. Confirm the request using a valid link or contact the administrator.',
      400
    );
  }
}
