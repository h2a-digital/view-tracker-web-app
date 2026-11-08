import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { configuration } from '@/lib/server/config';
import { configurationIssues, hostedPreview } from '@/lib/server/deployment';
import { adminDatabase } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { synchronizeAccount } from '@/services/tracking/sync';
import { trackingProvider } from '@/services/tracking/registry';
import { maintainProviders } from '@/services/lifecycle/worker';
export const runtime = 'nodejs';
export const maxDuration = 60;
const maxJobs = 8;
export async function POST(request: Request) {
  const providerDeadline = Date.now() + 45000;
  const actual = request.headers.get('authorization') || '',
    secret = configuration().cronSecret,
    expected = `Bearer ${secret}`;
  if (
    !secret ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (hostedPreview() || configurationIssues(process.env, true).length)
    return NextResponse.json({ error: 'Worker configuration unavailable.' }, { status: 503 });
  const id = randomUUID(),
    source =
      request.headers.get('x-worker-source') === 'supabase-cron' ? 'supabase-cron' : 'manual';
  let db: ReturnType<typeof adminDatabase> | undefined,
    processed = 0,
    failed = false;
  let job: { id: string; account_id: string; lease_token: string } | null = null;
  let workspace: Awaited<ReturnType<typeof loadDashboard>> | null = null;
  const results: { accountId: string; success: boolean; diagnostics: unknown; skipped?: string }[] =
    [];
  async function record(outcome: string, status = 200, detail: string | null = null) {
    const result = await db!.rpc('record_worker_invocation', {
      invocation_id: id,
      invocation_source: source,
      invocation_outcome: outcome,
      processed_count: processed,
      response_status: outcome === 'running' ? null : status,
      safe_detail: detail,
    });
    if (result.error) throw new Error('Could not record worker health.');
    if (outcome !== 'running')
      console.info(JSON.stringify({ event: 'ugc_worker', id, source, outcome, processed, status }));
  }
  async function retry() {
    if (db && job)
      await db.rpc('finish_tracking_job', {
        job_id: job.id,
        success: false,
        expected_lease_token: job.lease_token,
        error_message: 'Sync conflict or temporary failure. Retrying with backoff.',
      });
  }
  try {
    db = adminDatabase();
    await record('running');
    const lifecycle = await maintainProviders(db, Math.min(providerDeadline, Date.now() + 12000));
    const enqueue = await db.rpc('enqueue_tracking');
    if (enqueue.error) throw enqueue.error;
    while (processed < maxJobs && Date.now() < providerDeadline - 8000) {
      const lease = await db.rpc('lease_tracking_job');
      if (lease.error) throw lease.error;
      job = lease.data;
      if (!job) break;
      const current = job;
      try {
        const { data, revision }: Awaited<ReturnType<typeof loadDashboard>> =
          workspace ?? (await loadDashboard());
        const account = data.accounts.find((a) => a.id === current.account_id);
        if (!account || account.status !== 'connected') {
          const result = await db.rpc('finish_tracking_job', {
            job_id: current.id,
            success: true,
            error_message: null,
            expected_lease_token: current.lease_token,
          });
          if (result.error || !result.data) throw new Error('Lease lost.');
          processed++;
          results.push({
            accountId: current.account_id,
            success: true,
            diagnostics: null,
            skipped: 'account_not_connected',
          });
          job = null;
          continue;
        }
        const next = await synchronizeAccount(
          data,
          current.account_id,
          trackingProvider(account, providerDeadline)
        );
        const run = next.syncRuns.find((r) => r.account_id === current.account_id),
          syncFailed = run?.status === 'failed';
        const result = await db.rpc('commit_tracking_job', {
          job_id: current.id,
          expected_lease_token: current.lease_token,
          expected_revision: revision,
          document: next,
          success: !syncFailed,
          error_message: syncFailed ? 'Provider sync needs attention.' : null,
        });
        if (result.error) throw result.error;
        workspace = { data: next, revision: revision + 1 };
        failed ||= syncFailed;
        processed++;
        results.push({
          accountId: current.account_id,
          success: !syncFailed,
          diagnostics: run?.diagnostics ?? null,
        });
        job = null;
      } catch {
        workspace = null;
        failed = true;
        await retry();
        processed++;
        results.push({ accountId: current.account_id, success: false, diagnostics: null });
        job = null;
      }
    }
    await record(
      failed ? 'failed' : processed ? 'success' : 'idle',
      failed ? 503 : 200,
      failed ? 'One or more account jobs failed; inspect synchronization diagnostics.' : null
    );
    return NextResponse.json(
      {
        processed,
        success: !failed,
        invocationId: id,
        lifecycle,
        diagnostics: results.length === 1 ? results[0].diagnostics : null,
        results,
        ...(results[0]?.skipped && results.length === 1 ? { skipped: results[0].skipped } : {}),
      },
      { status: failed ? 503 : 200 }
    );
  } catch {
    try {
      await retry();
    } catch {
      /* Lease expiry is the final recovery mechanism. */
    }
    try {
      if (db)
        await record(
          'failed',
          503,
          'Queue, lease or database failure. Later Cron ticks retry automatically.'
        );
    } catch {
      console.error(JSON.stringify({ event: 'ugc_worker', id, outcome: 'health_record_failed' }));
    }
    return NextResponse.json(
      { processed, error: 'Worker failed. Queue retries automatically.', invocationId: id },
      { status: 503 }
    );
  }
}
