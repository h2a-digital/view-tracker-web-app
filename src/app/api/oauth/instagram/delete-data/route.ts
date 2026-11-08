import { metaRemoval } from '@/services/lifecycle/requests';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    return await metaRemoval(request, 'instagram');
  } catch (error) {
    return NextResponse.json(
      { error: 'Deletion callback could not complete. Retry with a valid signed request.' },
      {
        status:
          error instanceof Error && error.message === 'Could not complete deletion.' ? 503 : 400,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
