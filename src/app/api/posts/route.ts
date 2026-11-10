import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/server/supabase';
import { postPageSchema } from '@/domain/post-pages';
import { readPostPage } from '@/repositories/post-pages';
import { apiError } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const query = postPageSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(
      { ...(await readPostPage(query)), asOf: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
