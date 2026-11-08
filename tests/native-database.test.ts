import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { populatedDocument } from './helpers/dashboard';

// Opt-in: point this ONLY at an isolated, disposable PostgreSQL instance, with TCP disabled.
// The test creates its own database and drops it afterward. It leaves test roles in that cluster.
const socket = process.env.UGC_TEST_PG_SOCKET;
it.skipIf(!socket)(
  'validates migration, both INSERT paths, replay and ACLs on native PostgreSQL',
  () => {
    const port = process.env.UGC_TEST_PG_PORT || '55437';
    const database = `ugc_migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const args = ['-X', '-h', socket!, '-p', port, '-v', 'ON_ERROR_STOP=1', '-qAt'];
    const sql = (query: string, db = database) =>
      execFileSync('psql', [...args, '-d', db], {
        input: query,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    sql(`create database ${database};`, 'postgres');
    try {
      const bootstrap = readFileSync('tests/fixtures/supabase-bootstrap.sql', 'utf8').replace(
        /create role (anon|authenticated|service_role)( bypassrls)?;/g,
        (_, name: string, bypass: string) =>
          `do $$begin if not exists(select 1 from pg_roles where rolname='${name}') then create role ${name}${bypass || ''};end if;end$$;`
      );
      sql(
        bootstrap +
          `alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`
      );
      const migration = readFileSync('supabase/migrations/202611070001_ugc.sql', 'utf8').replace(
        /^create extension[^;]*;$/gm,
        ''
      );
      sql(migration);
      const document = populatedDocument();
      const literal = JSON.stringify(document).replaceAll("'", "''");
      const result = sql(
        `set role service_role;select public.commit_dashboard(0,'${literal}'::jsonb);select public.read_dashboard();`
      )
        .trim()
        .split('\n')
        .at(-1)!;
      const roundtrip = JSON.parse(result);
      expect(roundtrip.revision).toBe(1);
      expect(roundtrip.data.statements[0].payable_cents).toBe(1300);
      for (const key of Object.keys(document) as (keyof typeof document)[])
        expect(roundtrip.data[key].length, key).toBe(document[key].length);
      sql(
        `set role service_role;select public.commit_dashboard(1,(public.read_dashboard()->'data'));`
      );
      // The original unaliased form also works, including with the function's empty search path.
      expect(
        sql(
          `begin;set local search_path='';insert into public.creators(id,name,email,notes) select id,name,email,notes from jsonb_populate_recordset(null::public.creators,'[{"id":"c0000000-0000-4000-8000-000000000001","name":"Original SELECT","email":"","notes":""}]') returning name;rollback;`
        ).trim()
      ).toBe('Original SELECT');
      sql(readFileSync('supabase/migrations/202611080001_tracking_and_new_york.sql', 'utf8'));
      const upgraded = JSON.parse(
        sql('set role service_role;select public.read_dashboard();').trim()
      );
      expect(upgraded.schemaVersion).toBe(2);
      expect(upgraded.data.statements[0].payable_cents).toBe(1300);
      sql(
        `set role service_role;select public.commit_dashboard(${upgraded.revision},public.read_dashboard()->'data');`
      );
      const privileges = sql(
        `select has_function_privilege('anon','public.is_admin()','EXECUTE'),has_function_privilege('authenticated','public.commit_dashboard(bigint,jsonb)','EXECUTE'),has_table_privilege('authenticated','public.apps','TRUNCATE');`
      ).trim();
      expect(privileges).toBe('f|f|f');
      sql(readFileSync('supabase/migrations/202611080002_production_operations.sql', 'utf8'));
      const production = JSON.parse(
        sql('set role service_role;select public.read_dashboard();').trim()
      );
      expect(production.schemaVersion).toBe(3);
      expect(production.data).toEqual(upgraded.data);
      expect(
        JSON.parse(sql('set role service_role;select public.get_operations_status();').trim())
          .invocations
      ).toEqual([]);
      expect(
        sql(
          "select has_function_privilege('anon','public.get_operations_status()','EXECUTE'),has_function_privilege('authenticated','public.record_worker_invocation(uuid,text,text,integer,integer,text)','EXECUTE'),has_function_privilege('service_role','public.commit_tracking_job(uuid,uuid,bigint,jsonb,boolean,text)','EXECUTE');"
        ).trim()
      ).toBe('f|f|t');
      sql(readFileSync('supabase/migrations/202611080003_direct_integrations.sql', 'utf8'));
      const direct = JSON.parse(
        sql('set role service_role;select public.read_dashboard();').trim()
      );
      expect(direct.schemaVersion).toBe(4);
      expect(direct.data.statements).toEqual(production.data.statements);
      expect(direct.data.accounts[0].provider).toBe(production.data.accounts[0].provider);
      expect(
        sql(
          "select has_function_privilege('anon','public.read_direct_credentials(uuid)','EXECUTE'),has_function_privilege('authenticated','public.read_oauth_flow(text)','EXECUTE');"
        ).trim()
      ).toBe('f|f');
      sql(readFileSync('supabase/migrations/202611080004_provider_lifecycle.sql', 'utf8'));
      const lifecycle = JSON.parse(
        sql('set role service_role;select public.read_dashboard();').trim()
      );
      expect(lifecycle.schemaVersion).toBe(5);
      expect(lifecycle.data.statements[0].payable_cents).toBe(
        direct.data.statements[0].payable_cents
      );
      expect(lifecycle.data.snapshots).toEqual(direct.data.snapshots);
      sql(
        'set role service_role;select public.sweep_provider_retention();select public.lease_source_check();select public.lease_provider_revocation();select public.get_operations_status();'
      );
      const nativeDirect = populatedDocument();
      nativeDirect.accounts[0].provider = 'direct';
      nativeDirect.accounts[0].platform = 'youtube';
      nativeDirect.posts[0].platform = 'youtube';
      nativeDirect.posts[0].caption = 'source-to-erase';
      const directLiteral = JSON.stringify(nativeDirect).replaceAll("'", "''");
      sql(
        `set role service_role;select public.commit_dashboard(${lifecycle.revision},'${directLiteral}'::jsonb);select public.erase_direct_account('${nativeDirect.accounts[0].id}','native-receipt');`
      );
      const erasedNative = JSON.parse(
        sql('set role service_role;select public.read_dashboard();').trim()
      );
      expect(JSON.stringify(erasedNative)).not.toContain('source-to-erase');
      expect(erasedNative.data.snapshots).toHaveLength(direct.data.snapshots.length);
      expect(
        erasedNative.data.statements.find(
          (s: { id: string }) => s.id === nativeDirect.statements[0].id
        ).payable_cents
      ).toBe(nativeDirect.statements[0].payable_cents);
    } finally {
      sql(`drop database ${database};`, 'postgres');
    }
  },
  30000
);
