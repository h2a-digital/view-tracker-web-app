import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { publicationMonth } from '@/domain/compensation';
import { apiError } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const id = z.uuid().parse(new URL(request.url).searchParams.get('id'));
    const { data } = await loadDashboard();
    const statement = data.statements.find((s) => s.id === id);
    if (!statement) throw new Error('Statement not found.');
    const posts = data.posts
      .filter(
        (p) =>
          p.app_id === statement.app_id &&
          p.creator_id === statement.creator_id &&
          publicationMonth(p.published_at) === statement.month
      )
      .map((p) => ({
        id: p.id,
        caption: p.caption,
        platform_post_id: p.platform_post_id,
        published_at: p.published_at,
        deadline: p.deadline,
      }));
    return NextResponse.json({ posts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
