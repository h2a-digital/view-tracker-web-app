import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { analyticsSummary } from '@/domain/analytics';
import { apiError } from '@/lib/server/http';
const ref = z.union([z.uuid(), z.literal('all')]).default('all');
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const q = z
      .object({
        app: ref,
        campaign: ref,
        creator: ref,
        platform: z.enum(['all', 'tiktok', 'instagram', 'youtube', 'facebook']).default('all'),
        start: day,
        end: day,
      })
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const { data } = await loadDashboard();
    return NextResponse.json(analyticsSummary(data, q), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return apiError(error);
  }
}
