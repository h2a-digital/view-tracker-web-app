import { NextResponse } from 'next/server';
import { requireAdmin, adminDatabase } from '@/lib/server/supabase';
import { apiError } from '@/lib/server/http';
import { configurationIssues } from '@/lib/server/deployment';
export async function GET() {
  try {
    await requireAdmin();
    const { data, error } = await adminDatabase().rpc('get_operations_status');
    if (error)
      throw new Error('Operations monitoring unavailable. Check the production migration.');
    return NextResponse.json(
      { ...data, configurationIssues: configurationIssues(process.env, true) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return apiError(error);
  }
}
