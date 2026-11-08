import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
const migration = readFileSync('supabase/migrations/202611080004_provider_lifecycle.sql', 'utf8');
async function fixture(direct = true) {
  const db = await createTestDatabase(true, 4),
    d = populatedDocument();
  if (direct) {
    d.accounts[0].provider = 'direct';
    d.accounts[0].platform = 'youtube';
    d.posts[0].platform = 'youtube';
    d.accounts[0].username = 'sensitive-handle';
    d.posts[0].caption = 'private-api-caption';
    d.statements[0].fingerprint = 'private-api-caption';
  }
  const rev = (
    await db.query<{ r: number }>("select (public.read_dashboard()->>'revision')::int r")
  ).rows[0].r;
  await db.query('select public.commit_dashboard($1,$2::jsonb)', [rev, JSON.stringify(d)]);
  await db.exec(migration);
  return { db, d };
}
describe('provider lifecycle migration and erasure', () => {
  it('upgrades v4 without changing TikTok history, money, connections or rules', async () => {
    const { db, d } = await fixture(false);
    try {
      const after = (
        await db.query<{ d: { schemaVersion: number; data: typeof d } }>(
          'select public.read_dashboard() d'
        )
      ).rows[0].d;
      expect(after.schemaVersion).toBe(5);
      expect(after.data.snapshots).toHaveLength(d.snapshots.length);
      expect(after.data.statements[0].payable_cents).toBe(d.statements[0].payable_cents);
      expect(after.data.accounts[0].provider).toBe('zernio');
      expect(after.data.ruleVersions.map((v) => v.patch)).toEqual(
        d.ruleVersions.map((v) => v.patch)
      );
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege('service_role','public.sweep_provider_retention()','EXECUTE') ok"
          )
        ).rows[0].ok
      ).toBe(true);
      await db.query('select public.sweep_provider_retention()');
      expect((await db.query('select * from public.snapshots')).rows).toHaveLength(
        d.snapshots.length
      );
      for (const role of ['anon', 'authenticated'])
        expect(
          (
            await db.query<{ ok: boolean }>(
              "select has_function_privilege($1,'public.erase_direct_account(uuid,text,bigint,boolean)','EXECUTE') ok",
              [role]
            )
          ).rows[0].ok
        ).toBe(false);
    } finally {
      await db.close();
    }
  });
  it('removes source copies from settled records, preserves money, invalidates stale writes and forbids restoration', async () => {
    const { db, d } = await fixture();
    try {
      const old = (
        await db.query<{ r: number }>("select (public.read_dashboard()->>'revision')::int r")
      ).rows[0].r;
      await db.query('select public.erase_direct_account($1,$2)', [d.accounts[0].id, 'receipt']);
      const after = (await db.query<{ d: { data: typeof d } }>('select public.read_dashboard() d'))
        .rows[0].d.data;
      expect(JSON.stringify(after)).not.toContain('private-api-caption');
      expect(JSON.stringify(after)).not.toContain('sensitive-handle');
      expect(after.snapshots).toHaveLength(0);
      expect(after.posts[0].eligible_views).toBeNull();
      expect(after.posts[0].source_erased_at).toBeTruthy();
      expect(after.statements[0].payable_cents).toBe(d.statements[0].payable_cents);
      expect(after.statements[0].payment_reference).toBe(d.statements[0].payment_reference);
      expect(after.statements[0].lines[0].views).toBeNull();
      expect(after.adjustments[0].eligible_views).toBeNull();
      await expect(
        db.query('select public.commit_dashboard($1,$2::jsonb)', [old, JSON.stringify(d)])
      ).rejects.toThrow('CONFLICT');
      await expect(
        db.query('update public.posts set caption=$1 where id=$2', ['restored', d.posts[0].id])
      ).rejects.toThrow('Erased source');
      await expect(
        db.query('update public.statements set payable_cents=payable_cents+1 where id=$1', [
          d.statements[0].id,
        ])
      ).rejects.toThrow('immutable');
      const receipt = (
        await db.query<{ d: unknown }>('select public.read_deletion_receipt($1) d', ['receipt'])
      ).rows[0].d;
      expect(receipt).toMatchObject({ status: 'complete' });
      expect(JSON.stringify(receipt)).not.toContain(d.accounts[0].id);
    } finally {
      await db.close();
    }
  });
  it('expires source data conservatively while leaving TikTok untouched and rejects late source leases', async () => {
    const { db, d } = await fixture();
    try {
      await db.query("update private.source_checks set verified_at=now()-interval '30 days'");
      await db.query('select public.sweep_provider_retention()');
      expect((await db.query('select * from public.snapshots')).rows).toHaveLength(0);
      await expect(
        db.query('select public.complete_source_check($1,$2,$3,true)', [
          d.accounts[0].id,
          crypto.randomUUID(),
          '[]',
        ])
      ).rejects.toThrow('LEASE_LOST');
    } finally {
      await db.close();
    }
  });
  it('uses single-use deletion links, cancels tracking leases and does not erase a newer grant on CAS revocation', async () => {
    const { db, d } = await fixture();
    try {
      const id = d.accounts[0].id;
      await db.query(
        "insert into private.oauth_credentials(account_id,encrypted_token,version) values($1,'encrypted',2)",
        [id]
      );
      await db.query('select public.forget_direct_credentials($1,1)', [id]);
      expect((await db.query('select * from public.snapshots')).rows).toHaveLength(
        d.snapshots.length
      );
      await db.query('select public.create_deletion_link($1,$2)', [id, 'link']);
      await db.query('select public.request_tracking($1)', [id]);
      const lease = (
        await db.query<{ j: { id: string; lease_token: string } }>(
          'select public.lease_tracking_job() j'
        )
      ).rows[0].j;
      await db.query('select public.redeem_deletion_link($1,$2)', ['link', 'receipt']);
      await expect(
        db.query('select public.redeem_deletion_link($1,$2)', ['link', 'again'])
      ).rejects.toThrow('expired');
      expect(
        (
          await db.query<{ ok: boolean }>('select public.finish_tracking_job($1,true,null,$2) ok', [
            lease.id,
            lease.lease_token,
          ])
        ).rows[0].ok
      ).toBe(false);
      expect((await db.query('select * from private.provider_revocations')).rows).toHaveLength(1);
      await db.query(
        "update private.provider_revocations set created_at=now()-interval '25 hours'"
      );
      await db.query('select public.sweep_provider_retention()');
      expect(
        (
          await db.query<{ encrypted_token: null; status: string }>(
            'select encrypted_token,status from private.provider_revocations'
          )
        ).rows[0]
      ).toEqual({ encrypted_token: null, status: 'failed' });
    } finally {
      await db.close();
    }
  });
  it('commits v5 OAuth atomically and performs source checks on the real SQL path', async () => {
    const { db, d } = await fixture();
    try {
      const id = d.accounts[0].id;
      await db.query('select public.create_oauth_invite($1,$2,$3)', ['invite', id, 'youtube']);
      await db.query('select public.start_oauth_flow($1,$2,$3,$4)', [
        'invite',
        'state',
        'browser',
        'verifier',
      ]);
      const current = (
        await db.query<{ d: { data: typeof d; revision: number } }>(
          'select public.read_dashboard() d'
        )
      ).rows[0].d;
      current.data.accounts[0].status = 'connected';
      current.data.accounts[0].provider_account_id = 'channel';
      await db.query('select public.commit_direct_connection($1,$2,$3,$4::jsonb,$5,$6,$7)', [
        'state',
        'browser',
        current.revision,
        JSON.stringify(current.data),
        'encrypted',
        'subject',
        'deletion',
      ]);
      expect(
        (await db.query<{ ok: boolean }>('select public.read_deletion_link($1) ok', ['deletion']))
          .rows[0].ok
      ).toBe(true);
      await db.query("update private.source_checks set verified_at=now()-interval '2 days'");
      const job = (
        await db.query<{ j: { leaseToken: string; posts: unknown[] } }>(
          'select public.lease_source_check() j'
        )
      ).rows[0].j;
      expect(job.posts).toHaveLength(1);
      await db.query('select public.complete_source_check($1,$2,$3,true)', [
        id,
        job.leaseToken,
        JSON.stringify([{ id: d.posts[0].id, status: 'available', caption: 'Updated metadata' }]),
      ]);
      expect(
        (
          await db.query<{ caption: string }>('select caption from public.posts where id=$1', [
            d.posts[0].id,
          ])
        ).rows[0].caption
      ).toBe('Updated metadata');
      // A consumed invitation can be cleaned without violating the flow foreign key.
      await db.query('select public.sweep_provider_retention()');
    } finally {
      await db.close();
    }
  });
  it('ignores an old Meta revocation after reauthorization, then erases the current signed subject', async () => {
    const { db, d } = await fixture();
    try {
      await db.query("update public.accounts set platform='instagram' where id=$1", [
        d.accounts[0].id,
      ]);
      await db.query(
        "insert into private.oauth_credentials(account_id,encrypted_token,subject_hash,authorized_at) values($1,'encrypted','subject',now())",
        [d.accounts[0].id]
      );
      await db.query("select public.erase_meta_subject('subject',now()-interval '1 day','old')");
      expect((await db.query('select * from public.snapshots')).rows).toHaveLength(
        d.snapshots.length
      );
      await db.query("select public.erase_meta_subject('subject',now(),'current')");
      expect((await db.query('select * from public.snapshots')).rows).toHaveLength(0);
      await db.query("select public.erase_meta_subject('subject',now(),'replay')");
      expect(
        (await db.query<{ n: number }>('select count(*)::int n from private.oauth_credentials'))
          .rows[0].n
      ).toBe(0);
    } finally {
      await db.close();
    }
  });
  it('enforces the 90-day source maximum even when metadata was just verified', async () => {
    const { db, d } = await fixture();
    try {
      const oldPost = {
        ...d.posts[0],
        id: crypto.randomUUID(),
        platform_post_id: 'old-source',
        url: 'https://www.youtube.com/watch?v=old-source',
        published_at: new Date(Date.now() - 91 * 86400000).toISOString(),
        app_id: null,
        campaign_id: null,
        rules: null,
        deadline: null,
        eligibility_status: 'excluded',
        eligible_views: null,
      };
      await db.query(
        'insert into public.posts select (jsonb_populate_record(null::public.posts,$1::jsonb)).*',
        [JSON.stringify(oldPost)]
      );
      await db.query('select public.sweep_provider_retention()');
      expect(
        (
          await db.query<{ erased: string }>(
            'select source_erased_at erased from public.posts where id=$1',
            [oldPost.id]
          )
        ).rows[0].erased
      ).toBeTruthy();
      expect(
        (
          await db.query<{ erased: null }>(
            'select source_erased_at erased from public.posts where id=$1',
            [d.posts[0].id]
          )
        ).rows[0].erased
      ).toBeNull();
    } finally {
      await db.close();
    }
  });
});
