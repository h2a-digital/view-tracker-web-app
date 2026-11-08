import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { configuration } from '@/lib/server/config';
import { adminDatabase } from '@/lib/server/supabase';
import { loadDashboard, saveDashboard } from '@/repositories/dashboard';
import { synchronizeAccount } from '@/services/tracking/sync';
import { ZernioProvider } from '@/services/tracking/zernio';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  const actual = request.headers.get('authorization') || '';
  const secret = configuration().cronSecret;
  const expected = `Bearer ${secret}`;
  if (
    !secret ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = adminDatabase();
  const { error: enqueueError } = await db.rpc('enqueue_tracking');
  if (enqueueError)
    return NextResponse.json({ error: 'Could not schedule tracking.' }, { status: 503 });
  const { data: job, error } = await db.rpc('lease_tracking_job');
  if (error) return NextResponse.json({ error: 'Queue unavailable' }, { status: 503 });
  if (!job) return NextResponse.json({ processed: 0 });
  try {
    const { data, revision } = await loadDashboard();
    const account = data.accounts.find((a) => a.id === job.account_id);
    if (!account || account.status !== 'connected') {
      const { error } = await db.rpc('finish_tracking_job', { job_id: job.id, success: true });
      if (error) throw error;
      return NextResponse.json({ processed: 1, success: true, skipped: 'account_not_connected' });
    }
    const next = await synchronizeAccount(data, job.account_id, new ZernioProvider());
    await saveDashboard(next, revision);
    const run = next.syncRuns.find((r) => r.account_id === job.account_id);
    const failed = run?.status === 'failed';
    const { error: finishError } = await db.rpc('finish_tracking_job', {
      job_id: job.id,
      success: !failed,
      error_message: failed ? 'Provider sync needs attention.' : null,
    });
    if (finishError) throw new Error('Could not complete the tracking job.');
    return NextResponse.json({
      processed: 1,
      success: !failed,
      diagnostics: run?.diagnostics ?? null,
    });
  } catch {
    await db.rpc('finish_tracking_job', {
      job_id: job.id,
      success: false,
      error_message: 'Sync conflict or provider failure. Retrying with backoff.',
    });
    return NextResponse.json({ processed: 0, error: 'Job will retry.' }, { status: 503 });
  }
}
