import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { configuration } from '@/lib/server/config';
import { configurationIssues, hostedPreview } from '@/lib/server/deployment';
import { adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
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
  if (hostedPreview() || configurationIssues(process.env, true).length)
    return NextResponse.json({ error: 'Worker configuration unavailable.' }, { status: 503 });
  const id = randomUUID();
  const source =
    request.headers.get('x-worker-source') === 'supabase-cron' ? 'supabase-cron' : 'manual';
  let job: { id: string; account_id: string; lease_token: string } | null = null;
  let db: ReturnType<typeof adminDatabase> | undefined;
  async function record(
    outcome: string,
    processed = 0,
    status = 200,
    detail: string | null = null
  ) {
    const { error } = await db!.rpc('record_worker_invocation', {
      invocation_id: id,
      invocation_source: source,
      invocation_outcome: outcome,
      processed_count: processed,
      response_status: outcome === 'running' ? null : status,
      safe_detail: detail,
    });
    if (error) throw new Error('Could not record worker health.');
    if (outcome !== 'running')
      console.info(JSON.stringify({ event: 'ugc_worker', id, source, outcome, processed, status }));
  }
  try {
    db = adminDatabase();
    await record('running');
    const { error: enqueueError } = await db.rpc('enqueue_tracking');
    if (enqueueError) throw enqueueError;
    const lease = await db.rpc('lease_tracking_job');
    if (lease.error) throw lease.error;
    job = lease.data;
    if (!job) {
      await record('idle');
      return NextResponse.json({ processed: 0, success: true, invocationId: id });
    }
    const { data, revision } = await loadDashboard();
    const account = data.accounts.find((a) => a.id === job!.account_id);
    if (!account || account.status !== 'connected') {
      const result = await db.rpc('finish_tracking_job', {
        job_id: job.id,
        success: true,
        error_message: null,
        expected_lease_token: job.lease_token,
      });
      if (result.error || !result.data) throw new Error('Lease lost.');
      await record('skipped', 1);
      return NextResponse.json({
        processed: 1,
        success: true,
        skipped: 'account_not_connected',
        invocationId: id,
      });
    }
    const next = await synchronizeAccount(data, job.account_id, new ZernioProvider());
    const run = next.syncRuns.find((r) => r.account_id === job!.account_id);
    const failed = run?.status === 'failed';
    const { error } = await db.rpc('commit_tracking_job', {
      job_id: job.id,
      expected_lease_token: job.lease_token,
      expected_revision: revision,
      document: next,
      success: !failed,
      error_message: failed ? 'Provider sync needs attention.' : null,
    });
    if (error) throw error;
    await record(
      failed ? 'failed' : 'success',
      1,
      failed ? 503 : 200,
      failed ? 'Provider failed; retry queued with backoff.' : null
    );
    return NextResponse.json(
      { processed: 1, success: !failed, invocationId: id, diagnostics: run?.diagnostics ?? null },
      { status: failed ? 503 : 200 }
    );
  } catch {
    if (db && job)
      await db.rpc('finish_tracking_job', {
        job_id: job.id,
        success: false,
        expected_lease_token: job.lease_token,
        error_message: 'Sync conflict or temporary failure. Retrying with backoff.',
      });
    try {
      if (db)
        await record(
          'failed',
          0,
          503,
          'Queue, provider, lease or database failure. Check sync diagnostics and server logs.'
        );
    } catch {
      console.error(JSON.stringify({ event: 'ugc_worker', id, outcome: 'health_record_failed' }));
    }
    return NextResponse.json(
      { processed: 0, error: 'Worker failed. Queue retries automatically.', invocationId: id },
      { status: 503 }
    );
  }
}
