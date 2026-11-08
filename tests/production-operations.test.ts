import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
describe('incremental production operations migration', () => {
  it('preserves data, fences expired leases and atomically commits only the current lease', async () => {
    const db = await createTestDatabase(true, true);
    try {
      const doc = populatedDocument();
      doc.accounts[0].status = 'connected';
      await db.query('select public.commit_dashboard(1,$1::jsonb)', [JSON.stringify(doc)]);
      const before = (await db.query<{ d: unknown }>('select public.read_dashboard() as d')).rows[0]
        .d;
      await db.exec(
        readFileSync('supabase/migrations/202611080002_production_operations.sql', 'utf8')
      );
      const after = (
        await db.query<{ d: { data: unknown; schemaVersion: number; revision: number } }>(
          'select public.read_dashboard() as d'
        )
      ).rows[0].d;
      expect(after.schemaVersion).toBe(3);
      expect(after.data).toEqual((before as { data: unknown }).data);
      await db.exec('select public.enqueue_tracking();select public.enqueue_tracking()');
      expect((await db.query('select * from private.jobs')).rows).toHaveLength(1);
      type Job = { id: string; lease_token: string; attempts: number };
      const lease = async () =>
        (await db.query<{ j: Job }>('select public.lease_tracking_job() j')).rows[0].j;
      const first = await lease();
      expect(first.lease_token).toBeTruthy();
      await db.exec("update private.jobs set leased_until=now()-interval '1 second'");
      const second = await lease();
      expect(second.id).toBe(first.id);
      expect(second.lease_token).not.toBe(first.lease_token);
      expect(
        (
          await db.query<{ ok: boolean }>('select public.finish_tracking_job($1,true,null,$2) ok', [
            first.id,
            first.lease_token,
          ])
        ).rows[0].ok
      ).toBe(false);
      await expect(
        db.query('select public.commit_tracking_job($1,$2,$3,$4::jsonb,true,null)', [
          first.id,
          first.lease_token,
          after.revision,
          JSON.stringify(doc),
        ])
      ).rejects.toThrow('LEASE_LOST');
      await expect(
        db.query('select public.finish_tracking_job($1,true)', [first.id])
      ).rejects.toThrow('Lease token required');
      await db.query('select public.commit_tracking_job($1,$2,$3,$4::jsonb,true,null)', [
        second.id,
        second.lease_token,
        after.revision,
        JSON.stringify(doc),
      ]);
      expect((await db.query<{ s: string }>('select status s from private.jobs')).rows[0].s).toBe(
        'complete'
      );
      expect(
        (await db.query<{ j: unknown }>('select public.lease_tracking_job() j')).rows[0].j
      ).toBeNull();
    } finally {
      await db.close();
    }
  });
  it('restricts operations RPCs and private tables; records idle and failed heartbeats without secrets', async () => {
    const db = await createTestDatabase(true, 3);
    try {
      for (const name of [
        'get_operations_status()',
        'record_worker_invocation(uuid,text,text,integer,integer,text)',
        'commit_tracking_job(uuid,uuid,bigint,jsonb,boolean,text)',
        'finish_tracking_job(uuid,boolean,text,uuid)',
      ]) {
        for (const role of ['anon', 'authenticated'])
          expect(
            (
              await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'EXECUTE') ok", [
                role,
                'public.' + name,
              ])
            ).rows[0].ok
          ).toBe(false);
        expect(
          (
            await db.query<{ ok: boolean }>(
              "select has_function_privilege('service_role',$1,'EXECUTE') ok",
              ['public.' + name]
            )
          ).rows[0].ok
        ).toBe(true);
      }
      await db.exec(
        "select public.record_worker_invocation('11111111-1111-4111-8111-111111111111','supabase-cron');select public.record_worker_invocation('11111111-1111-4111-8111-111111111111','supabase-cron','idle',0,200,null)"
      );
      const status = (
        await db.query<{
          s: { invocations: { outcome: string; finished_at: string }[]; schedules: unknown[] };
        }>('select public.get_operations_status() s')
      ).rows[0].s;
      expect(status.invocations).toHaveLength(1);
      expect(status.invocations[0].outcome).toBe('idle');
      expect(status.invocations[0].finished_at).toBeTruthy();
      expect(status.schedules).toEqual([]);
      await db.exec('set role authenticated');
      await expect(db.exec('select * from private.worker_invocations')).rejects.toThrow();
      await expect(db.exec('select public.get_operations_status()')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
  it('uses Vault, authenticated POST and an idempotent five-minute schedule (extension substitutes)', async () => {
    const db = await createTestDatabase(true, 3);
    try {
      await db.exec(`create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);
    create schema net;create table net.calls(url text,body jsonb,headers jsonb,timeout integer);
    create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.calls values(url,body,headers,timeout_milliseconds);return (select count(*) from net.calls);end;$$;
    create schema cron;create table cron.job(jobid bigint generated always as identity,jobname text,schedule text,command text,active boolean default true);
    create function cron.unschedule(target bigint) returns boolean language sql as $$delete from cron.job where jobid=target returning true$$;
    create function cron.schedule(name text,frequency text,sql text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values(name,frequency,sql) returning jobid$$;
   `);
      const script = readFileSync('supabase/operations/configure-production-cron.sql', 'utf8');
      await expect(db.exec('select private.dispatch_worker()')).rejects.toThrow('ugc_worker_url');
      await db.exec(
        "insert into vault.decrypted_secrets values('ugc_worker_url','https://ledger.example.com/api/internal/jobs'),('ugc_cron_secret','12345678901234567890123456789012')"
      );
      await db.exec(script);
      await db.exec(script);
      expect((await db.query('select * from net.calls')).rows).toHaveLength(0);
      const schedules = (
        await db.query<{ command: string; schedule: string }>('select * from cron.job')
      ).rows;
      expect(schedules).toHaveLength(1);
      expect(schedules[0].schedule).toBe('*/5 * * * *');
      expect(schedules[0].command).toBe('select private.dispatch_worker();');
      await db.exec('select private.dispatch_worker()');
      const call = (
        await db.query<{ headers: Record<string, string>; timeout: number }>(
          'select * from net.calls'
        )
      ).rows[0];
      expect(call.headers.Authorization).toBe('Bearer 12345678901234567890123456789012');
      expect(call.headers['X-Worker-Source']).toBe('supabase-cron');
      expect(call.timeout).toBe(70000);
    } finally {
      await db.close();
    }
  });
});
