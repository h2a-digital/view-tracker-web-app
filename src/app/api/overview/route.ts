import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { overviewSummary } from '@/domain/read-model';
import { postPageSchema } from '@/domain/post-pages';
import { apiError } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const query = postPageSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { data } = await loadDashboard();
    return NextResponse.json(
      { summary: overviewSummary(data, query.app, query.search, Date.now()) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
