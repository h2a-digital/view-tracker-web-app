import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { groupReviews, reviewCause } from '@/domain/review-groups';
import { isLocked } from '@/domain/compensation';
import { apiError } from '@/lib/server/http';
const schema = z.object({
  app: z.union([z.uuid(), z.literal('all')]).default('all'),
  accountId: z.uuid().optional(),
  cause: z
    .enum(['mapping', 'historical', 'policy', 'promotion', 'format', 'evidence', 'data'])
    .optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  action: z.literal('selection').optional(),
});
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const q = schema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { data } = await loadDashboard();
    const now = new Date().toISOString();
    if (!q.accountId || !q.cause)
      return NextResponse.json(
        { groups: groupReviews(data, q.app, now) },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    const rows = data.posts
      .filter(
        (p) =>
          (q.app === 'all' || p.app_id === q.app) &&
          p.account_id === q.accountId &&
          reviewCause(data, p, now) === q.cause
      )
      .sort((a, b) => b.published_at.localeCompare(a.published_at) || b.id.localeCompare(a.id));
    if (q.action) {
      if (!['mapping', 'historical'].includes(q.cause))
        throw new Error('This issue needs individual review.');
      const ids = rows
        .filter((p) => !isLocked(data, p) && p.eligibility_status !== 'accepted')
        .slice(0, 100)
        .map((p) => p.id);
      return NextResponse.json(
        { ids, cause: q.cause, total: rows.length },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const page = Math.max(1, Math.min(q.page, Math.ceil(rows.length / 12))),
      posts = rows.slice((page - 1) * 12, page * 12);
    return NextResponse.json(
      {
        posts: posts.map((p) => ({
          id: p.id,
          caption: p.caption,
          published_at: p.published_at,
          platform: p.platform,
        })),
        page,
        pageSize: 12,
        total: rows.length,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
