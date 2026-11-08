import { describe, it, expect } from 'vitest';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';

describe('unattended account scheduling', () => {
  it('enqueues due connected accounts without request_tracking or a UI Sync click', async () => {
    const db = await createTestDatabase(true, true);
    try {
      const d = populatedDocument();
      d.accounts[0].status = 'connected';
      d.accounts[0].provider_account_id = 'remote-account';
      await db.query('select public.commit_dashboard(1,$1::jsonb)', [JSON.stringify(d)]);
      // A recently synced account is not due on every five-minute HTTP invocation.
      await db.exec('update public.accounts set last_synced_at=now()');
      await db.exec('select public.enqueue_tracking()');
      expect(
        (await db.query<{ job: unknown }>('select public.lease_tracking_job() as job')).rows[0].job
      ).toBeNull();
      await db.exec("update public.accounts set last_synced_at=now()-interval '61 minutes'");
      await db.exec('select public.enqueue_tracking();select public.enqueue_tracking()');
      expect((await db.query('select * from private.jobs')).rows).toHaveLength(1);
      const job = (
        await db.query<{ job: { id: string; account_id: string; attempts: number } }>(
          'select public.lease_tracking_job() as job'
        )
      ).rows[0].job;
      expect(job.account_id).toBe(d.accounts[0].id);
      expect(job.attempts).toBe(1);
      await db.query('select public.finish_tracking_job($1,true)', [job.id]);
      // The next successful sync updates last_synced_at; another tick does not create a job.
      await db.exec(
        'update public.accounts set last_synced_at=now();select public.enqueue_tracking()'
      );
      expect(
        (await db.query<{ job: unknown }>('select public.lease_tracking_job() as job')).rows[0].job
      ).toBeNull();
      // A later hourly tick can schedule another combined sync without manual intervention.
      await db.exec(
        "update public.accounts set last_synced_at=now()-interval '61 minutes';select public.enqueue_tracking()"
      );
      expect(
        (
          await db.query<{ job: { account_id: string } }>(
            'select public.lease_tracking_job() as job'
          )
        ).rows[0].job.account_id
      ).toBe(d.accounts[0].id);
    } finally {
      await db.close();
    }
  });
  it('excludes disconnected/attention accounts until authorization is restored', async () => {
    const db = await createTestDatabase(true, true);
    try {
      const d = populatedDocument();
      d.accounts[0].status = 'attention';
      await db.query('select public.commit_dashboard(1,$1::jsonb)', [JSON.stringify(d)]);
      await db.exec('select public.enqueue_tracking()');
      expect((await db.query('select * from private.jobs')).rows).toHaveLength(0);
      await db.exec(
        "update public.accounts set status='connected',last_synced_at=null;select public.enqueue_tracking()"
      );
      expect((await db.query('select * from private.jobs')).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
