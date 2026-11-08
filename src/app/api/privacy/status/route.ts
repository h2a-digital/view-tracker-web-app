import { deletionStatus } from '@/services/lifecycle/requests';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    return await deletionStatus(request);
  } catch {
    return NextResponse.json({ error: 'Status unavailable' }, { status: 503 });
  }
}
