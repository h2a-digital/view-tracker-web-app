import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database';
import { verselRules, type DashboardData } from '@/domain/model';
import { seedData } from '@/domain/commands';
import { populatedDocument } from './helpers/dashboard';

let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});
const admin = 'a0000000-0000-4000-8000-000000000001';
const outsider = 'a0000000-0000-4000-8000-000000000002';
const applicationTables = [
  'admin_users',
  'apps',
  'campaigns',
  'creators',
  'memberships',
  'accounts',
  'mappings',
  'rule_versions',
  'posts',
  'snapshots',
  'statements',
  'audit_events',
  'sync_runs',
  'adjustments',
];
const serverFunctions = [
  'read_dashboard',
  'commit_dashboard',
  'lease_tracking_job',
  'enqueue_tracking',
  'request_tracking',
  'finish_tracking_job',
  'store_connection',
  'read_connection',
  'consume_connection',
  'commit_connection',
];
async function asRole<T>(
  role: 'anon' | 'authenticated' | 'service_role',
  userId: string,
  query: string
) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    await db.exec(`set local role ${role}`);
    return await db.query<T>(query);
  } finally {
    await db.exec('rollback');
  }
}

describe('fresh Supabase privilege profiles', () => {
  it('removes Supabase automatic write and administrative table grants', async () => {
    for (const table of applicationTables) {
      for (const role of ['anon', 'authenticated']) {
        const result = await db.query<{ can_write: boolean }>(
          `select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as can_write`,
          [role, `public.${table}`]
        );
        expect(result.rows[0].can_write, `${role} privileges on ${table}`).toBe(false);
      }
    }
  });
  it('exposes only the RLS helper to authenticated and no server RPC to browser roles', async () => {
    const functions = await db.query<{
      name: string;
      anon: boolean;
      authenticated: boolean;
      service: boolean;
      search_path: string[];
    }>(
      `select p.proname as name,has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') as service,p.proconfig as search_path from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])`,
      [['is_admin', ...serverFunctions]]
    );
    expect(functions.rows).toHaveLength(serverFunctions.length + 1);
    for (const f of functions.rows) {
      expect(f.anon, f.name).toBe(false);
      expect(f.authenticated, f.name).toBe(f.name === 'is_admin');
      if (f.name !== 'is_admin') expect(f.service, f.name).toBe(true);
      expect(f.search_path, f.name).toContain('search_path=""');
    }
  });
  it('hides private tables and connection tickets from browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(
        (
          await db.query<{ access: boolean }>(
            "select has_schema_privilege($1,'private','USAGE') as access",
            [role]
          )
        ).rows[0].access
      ).toBe(false);
    }
  });
  it('tests RLS using actual caller roles and Auth identities', async () => {
    await db.query('insert into auth.users values($1),($2)', [admin, outsider]);
    await db.query('insert into public.admin_users values($1)', [admin]);
    expect((await asRole('authenticated', admin, 'select * from public.apps')).rows).toHaveLength(
      1
    );
    expect(
      (await asRole('authenticated', outsider, 'select * from public.apps')).rows
    ).toHaveLength(0);
    expect(
      (await asRole('authenticated', admin, 'select * from public.admin_users')).rows
    ).toHaveLength(1);
    expect(
      (await asRole('authenticated', outsider, 'select * from public.admin_users')).rows
    ).toHaveLength(0);
    await expect(asRole('anon', '', 'select public.read_dashboard()')).rejects.toThrow(
      /permission denied/
    );
    await expect(
      asRole('authenticated', outsider, 'select public.read_dashboard()')
    ).rejects.toThrow(/permission denied/);
    expect((await asRole('service_role', '', 'select public.read_dashboard()')).rows).toHaveLength(
      1
    );
  });
  it('keeps evidence private and allows only administrators to read/insert it', async () => {
    const bucket = (
      await db.query<{ public: boolean }>(
        "select public from storage.buckets where id='ugc-evidence'"
      )
    ).rows[0];
    expect(bucket.public).toBe(false);
    await db.exec(
      "insert into storage.objects values('b0000000-0000-4000-8000-000000000001','ugc-evidence'),('b0000000-0000-4000-8000-000000000002','other-bucket')"
    );
    expect(
      (await asRole('authenticated', admin, 'select * from storage.objects')).rows
    ).toHaveLength(1);
    expect(
      (await asRole('authenticated', outsider, 'select * from storage.objects')).rows
    ).toHaveLength(0);
    expect((await asRole('anon', '', 'select * from storage.objects')).rows).toHaveLength(0);
    await asRole(
      'authenticated',
      admin,
      "insert into storage.objects values('b0000000-0000-4000-8000-000000000003','ugc-evidence')"
    );
    await expect(
      asRole(
        'authenticated',
        outsider,
        "insert into storage.objects values('b0000000-0000-4000-8000-000000000003','ugc-evidence')"
      )
    ).rejects.toThrow(/row-level security/);
  });
});

async function readDocument(database: PGlite) {
  return (
    await database.query<{ value: { data: DashboardData; revision: number } }>(
      'select public.read_dashboard() as value'
    )
  ).rows[0].value;
}

describe('dynamic INSERT statements and transactional behavior', () => {
  it('confirms the original unaliased composite SELECT is legal PostgreSQL', async () => {
    await db.exec('begin');
    try {
      const result = await db.query<{ id: string; name: string }>(
        `insert into public.creators(id,name,email,notes) select id,name,email,notes from jsonb_populate_recordset(null::public.creators,$1) returning id,name`,
        [
          JSON.stringify([
            { id: outsider, name: 'Unaliased composite source', email: '', notes: '' },
          ]),
        ]
      );
      expect(result.rows[0]).toEqual({ id: outsider, name: 'Unaliased composite source' });
    } finally {
      await db.exec('rollback');
    }
  });
  it('inserts nonempty rows into every dashboard collection and replays them safely', async () => {
    const isolated = await createTestDatabase();
    try {
      const document = populatedDocument();
      await isolated.query('select public.commit_dashboard($1,$2::jsonb)', [
        0,
        JSON.stringify(document),
      ]);
      const first = await readDocument(isolated);
      expect(first.revision).toBe(1);
      for (const key of Object.keys(document) as Exclude<keyof DashboardData, 'readModel'>[]) {
        expect(document[key].length, key).toBeGreaterThan(0);
        expect(first.data[key].length, key).toBe(document[key].length);
      }
      expect(first.data.statements[0]).toMatchObject({
        status: 'paid',
        payment_reference: 'external-bank-1',
        payable_cents: 1300,
      });
      expect(first.data.snapshots[0]).toMatchObject({ views: 2000, metric: 'organic_views' });
      first.data.creators[0].name = 'Updated creator';
      // The append-only path must not rewrite financial evidence on replay.
      first.data.snapshots[0].views = 999999;
      await isolated.query('select public.commit_dashboard($1,$2::jsonb)', [
        1,
        JSON.stringify(first.data),
      ]);
      const replay = await readDocument(isolated);
      expect(replay.revision).toBe(2);
      expect(replay.data.creators[0].name).toBe('Updated creator');
      expect(replay.data.snapshots[0].views).toBe(2000);
      expect(replay.data.audit).toHaveLength(document.audit.length);
    } finally {
      await isolated.close();
    }
  });
  it('rolls back earlier inserts and the revision when a later collection fails', async () => {
    const isolated = await createTestDatabase();
    try {
      const document = populatedDocument();
      document.apps[0].name = 'Should roll back';
      document.snapshots[0].post_id = outsider;
      await expect(
        isolated.query('select public.commit_dashboard($1,$2::jsonb)', [
          0,
          JSON.stringify(document),
        ])
      ).rejects.toThrow(/foreign key/);
      const saved = await readDocument(isolated);
      expect(saved.revision).toBe(0);
      expect(saved.data.apps[0].name).toBe('Versel');
      expect(saved.data.creators).toHaveLength(0);
    } finally {
      await isolated.close();
    }
  });
  it('rejects null revisions and malformed dashboard collections', async () => {
    const document = seedData(new Date('2026-11-07'));
    await expect(
      db.query('select public.commit_dashboard($1,$2::jsonb)', [null, JSON.stringify(document)])
    ).rejects.toThrow(/CONFLICT/);
    for (const invalid of [
      null,
      [],
      {},
      { ...document, snapshots: null },
      { ...document, posts: {} },
    ]) {
      await expect(
        db.query('select public.commit_dashboard($1,$2::jsonb)', [0, JSON.stringify(invalid)])
      ).rejects.toThrow(/JSON (object|array)/);
    }
    expect((await readDocument(db)).revision).toBe(0);
  });
  it('works with opt-in permissions without Supabase automatic table/function grants', async () => {
    const isolated = await createTestDatabase(false);
    try {
      const document = populatedDocument();
      await isolated.exec('set role service_role');
      await isolated.query('select public.commit_dashboard($1,$2::jsonb)', [
        0,
        JSON.stringify(document),
      ]);
      expect((await readDocument(isolated)).data.creators[0].name).toBe('Round trip creator');
      await isolated.exec('reset role; set role authenticated');
      expect((await isolated.query('select * from public.apps')).rows).toHaveLength(0);
    } finally {
      await isolated.close();
    }
  });
  it('retains the exact initial Versel compensation defaults', async () => {
    const document = (await readDocument(db)).data;
    expect(document.ruleVersions[0].patch).toEqual(verselRules);
    expect(document.ruleVersions[0]).toMatchObject({
      scope: 'app',
      campaign_id: null,
      creator_id: null,
      app_id: document.apps[0].id,
    });
    expect(document.campaigns[0]).toMatchObject({
      name: 'Creator partnerships',
      status: 'active',
      app_id: document.apps[0].id,
    });
    expect(document.creators).toHaveLength(0);
    expect(document.statements).toHaveLength(0);
  });
  it('requires a recorded exact amount before a statement can be marked paid', async () => {
    const isolated = await createTestDatabase();
    try {
      const document = populatedDocument();
      document.statements[0].payment_amount_cents = null;
      await expect(
        isolated.query('select public.commit_dashboard($1,$2::jsonb)', [
          0,
          JSON.stringify(document),
        ])
      ).rejects.toThrow(/check constraint/);
    } finally {
      await isolated.close();
    }
  });
});
