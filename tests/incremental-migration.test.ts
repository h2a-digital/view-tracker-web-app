import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
const upgrade = readFileSync('supabase/migrations/202611080001_tracking_and_new_york.sql', 'utf8');
describe('safe incremental tracking upgrade', () => {
  it('preserves existing account IDs, OAuth links, posts and observations', async () => {
    const db = await createTestDatabase();
    try {
      const d = populatedDocument();
      d.accounts[0].provider_account_id = 'existing-connected-account';
      d.accounts[0].status = 'connected';
      await db.query('select public.commit_dashboard(0,$1::jsonb)', [JSON.stringify(d)]);
      await db.exec(upgrade);
      const r = (
        await db.query<{ v: { data: typeof d; revision: number } }>(
          'select public.read_dashboard() as v'
        )
      ).rows[0].v;
      expect(r.data.accounts[0]).toMatchObject({
        id: d.accounts[0].id,
        provider_account_id: 'existing-connected-account',
        status: 'connected',
      });
      expect(r.data.posts[0].published_at).toBe('2026-10-12T12:00:00+00:00');
      expect(r.data.snapshots[0].views).toBe(2000);
      expect(r.data.statements[0]).toMatchObject({
        status: 'paid',
        payable_cents: 1300,
        accounting_timezone: 'America/New_York',
      });
      // The RPC must successfully replay all columns added by the incremental migration.
      await db.query('select public.commit_dashboard($1,$2::jsonb)', [
        r.revision,
        JSON.stringify(r.data),
      ]);
      await expect(db.exec('update public.posts set eligible_views=999999')).rejects.toThrow(
        /immutable/
      );
      await db.exec('update public.posts set tracking=\'{"status":"review"}\'::jsonb');
      await expect(db.exec('update public.statements set payable_cents=999999')).rejects.toThrow(
        /immutable/
      );
    } finally {
      await db.close();
    }
  });
  it('aborts atomically when the timezone conversion would move existing statements', async () => {
    const db = await createTestDatabase();
    try {
      const d = populatedDocument();
      d.posts[0].published_at = '2026-11-01T01:00:00Z';
      d.statements[0].month = '2026-11';
      await db.query('select public.commit_dashboard(0,$1::jsonb)', [JSON.stringify(d)]);
      await expect(db.exec(upgrade)).rejects.toThrow(/timezone change affects existing statements/);
      await db.exec('rollback');
      expect(
        (
          await db.query(
            "select 1 from information_schema.columns where table_schema='public' and table_name='posts' and column_name='tracking'"
          )
        ).rows
      ).toHaveLength(0);
      expect(
        (await db.query<{ month: string }>('select month from public.statements')).rows[0].month
      ).toBe('2026-11');
    } finally {
      await db.close();
    }
  });
  it('protects finalized New York month inputs even when Rome would assign another month', async () => {
    const db = await createTestDatabase(true, true);
    try {
      const d = populatedDocument();
      d.posts[0].published_at = '2026-11-01T01:00:00Z';
      d.posts[0].deadline = '2026-11-08T01:00:00Z';
      d.statements[0].month = '2026-10';
      await db.query('select public.commit_dashboard(1,$1::jsonb)', [JSON.stringify(d)]);
      await expect(
        db.exec("update public.posts set review_note='Changed after finalization'")
      ).rejects.toThrow(/immutable/);
      const allowed = (
        await db.query<{ v: boolean }>(
          "select has_function_privilege('authenticated','public.commit_dashboard(bigint,jsonb)','execute') as v"
        )
      ).rows[0].v;
      expect(allowed).toBe(false);
    } finally {
      await db.close();
    }
  });
});
