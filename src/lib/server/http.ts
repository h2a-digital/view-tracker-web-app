import { NextResponse } from 'next/server';
export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Request failed.';
  const status = message === 'UNAUTHORIZED' ? 401 : message === 'SETUP_REQUIRED' ? 503 : 400;
  return NextResponse.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}
