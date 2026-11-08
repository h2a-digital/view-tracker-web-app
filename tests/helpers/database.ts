import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

export const migrationPath = 'supabase/migrations/202611070001_ugc.sql';
export const migration = readFileSync(migrationPath, 'utf8');

/** Managed schemas are substitutes; pg_cron/pg_net are verified against Supabase docs. */
export async function createTestDatabase(automaticGrants = true, upgraded: boolean | 3 = false) {
  const db = new PGlite();
  await db.exec(readFileSync('tests/fixtures/supabase-bootstrap.sql', 'utf8'));
  await db.exec(`
    ${
      automaticGrants
        ? `
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    `
        : ''
    }
  `);
  try {
    // These managed extensions are not distributed with PGlite. Keep every other statement.
    await db.exec(migration.replace(/^create extension[^;]*;$/gm, ''));
    if (upgraded) {
      await db.exec(
        readFileSync('supabase/migrations/202611080001_tracking_and_new_york.sql', 'utf8')
      );
    }
    if (upgraded === 3)
      await db.exec(
        readFileSync('supabase/migrations/202611080002_production_operations.sql', 'utf8')
      );
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
