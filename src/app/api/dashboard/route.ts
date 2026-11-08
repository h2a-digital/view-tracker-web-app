import { NextResponse } from 'next/server';
import { requireAdmin, requireSameOrigin } from '@/lib/server/supabase';
import { loadDashboard, saveDashboard } from '@/repositories/dashboard';
import { runCommand } from '@/domain/commands';
export const dynamic = 'force-dynamic';
import { apiError } from '@/lib/server/http';
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await loadDashboard(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAdmin();
    if (Number(request.headers.get('content-length') || 0) > 2000000)
      throw new Error('Request exceeds the 2 MB limit.');
    const raw = await request.text();
    if (raw.length > 2000000) throw new Error('Request exceeds the 2 MB limit.');
    const command = JSON.parse(raw);
    const { data, revision } = await loadDashboard();
    const next = runCommand(data, command, user.email);
    await saveDashboard(next, revision);
    return NextResponse.json(
      { data: next, revision: revision + 1 },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
