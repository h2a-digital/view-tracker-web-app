'use client';
import { useEffect, useState } from 'react';
import { formatTimestamp } from '@/domain/time';
type Health = {
  checkedAt: string;
  lifecycle?: {
    pendingRevocations: number;
    failedRevocations: number;
    pendingSourceChecks: number;
    sourceCheckErrors: number;
    oldestSuccessfulCheck: string | null;
    lastDeletion: string | null;
  };
  integrations?: Record<string, boolean>;
  configurationIssues: string[];
  queue: Record<string, number>;
  schedules: { active: boolean; schedule: string }[];
  invocations: {
    id: string;
    source: string;
    started_at: string;
    outcome: string;
    processed: number;
    http_status: number | null;
    detail: string | null;
  }[];
  httpRequests: {
    request_id: number;
    status_code: number | null;
    timed_out: boolean | null;
    has_error: boolean | null;
  }[];
  cronRuns: { status: string; start_time: string }[];
};
export function OperationsHealth({ preview }: { preview: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    fetch('/api/operations', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Health check failed.');
        setHealth(data);
        setError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [preview, refresh]);
  const latest = health?.invocations[0];
  const stale =
    health &&
    (!latest || Date.parse(health.checkedAt) - Date.parse(latest.started_at) > 15 * 60 * 1000);
  return (
    <section className="card">
      <div className="section-heading">
        <h2>Automation health</h2>
        <button className="button" onClick={() => setRefresh((v) => v + 1)} disabled={preview}>
          Check now
        </button>
      </div>
      <div className="padded subtle">
        {preview ? (
          <p>Worker monitoring is available after administrator sign-in.</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : !health ? (
          <p>Checking worker and scheduler…</p>
        ) : (
          <>
            {health.configurationIssues.map((issue) => (
              <p role="alert" key={issue}>
                {issue}
              </p>
            ))}
            <p>
              {health.schedules.some((s) => s.active && s.schedule === '*/5 * * * *')
                ? 'Five-minute Supabase Cron schedule is active.'
                : 'No active five-minute Cron schedule found. Configure Supabase Cron before relying on unattended tracking.'}
            </p>
            <p>
              {stale
                ? 'No authenticated worker call in the last 15 minutes. Check Cron, HTTPS access and CRON_SECRET.'
                : `Last worker call: ${formatTimestamp(latest!.started_at)} · ${latest!.outcome} · ${latest!.source}`}
            </p>
            <p>
              Queue:{' '}
              {Object.entries(health.queue)
                .map(([status, count]) => `${status}: ${count}`)
                .join(' · ') || 'empty'}
            </p>
            {latest?.outcome === 'running' &&
              Date.parse(health.checkedAt) - Date.parse(latest.started_at) > 3 * 60 * 1000 && (
                <p role="alert">
                  Worker did not finish. Its lease expires automatically; the next Cron call can
                  retry.
                </p>
              )}
            <p>
              An idle worker is healthy. Account polling is hourly; snapshots are daily, with closer
              sampling near the cutoff. A successful request does not guarantee fresh provider
              metrics.
            </p>
            {health.lifecycle && (
              <p
                role={
                  health.lifecycle.failedRevocations || health.lifecycle.sourceCheckErrors
                    ? 'alert'
                    : undefined
                }
              >
                Provider maintenance: {health.lifecycle.pendingSourceChecks} checks due ·{' '}
                {health.lifecycle.sourceCheckErrors} checks awaiting retry ·{' '}
                {health.lifecycle.pendingRevocations} revocations pending ·{' '}
                {health.lifecycle.failedRevocations} revocations requiring provider-side
                confirmation. Source data is erased independently of remote revocation retries.
              </p>
            )}
            <details>
              <summary>Worker and Cron diagnostics</summary>
              <pre className="diagnostics">
                {JSON.stringify(
                  {
                    invocations: health.invocations,
                    httpRequests: health.httpRequests,
                    cronRuns: health.cronRuns,
                    integrations: health.integrations,
                    lifecycle: health.lifecycle,
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
