import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database';
import { initialSetupFixture, initialCommand } from './helpers/initial-setup';
import { runCommand } from '@/domain/commands';
let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabase(true, 5);
}, 30000);
afterAll(async () => {
  await db?.close();
});
it('persists the guarded setup activation under existing schema v5 without rewriting old versions, observations or historical money', async () => {
  const before = initialSetupFixture();
  const revision = (
    await db.query<{ revision: number }>(
      "select (public.read_dashboard()->>'revision')::integer revision"
    )
  ).rows[0].revision;
  await db.query('select public.commit_dashboard($1,$2::jsonb)', [
    revision,
    JSON.stringify(before),
  ]);
  const originalVersions = (await db.query('select * from public.rule_versions order by id')).rows;
  const originalSnapshots = (await db.query('select * from public.snapshots order by id')).rows;
  const next = runCommand(
    before,
    initialCommand(before),
    'Setup administrator',
    new Date('2026-11-13T21:00:00Z')
  );
  await db.query('select public.commit_dashboard($1,$2::jsonb)', [
    revision + 1,
    JSON.stringify(next),
  ]);
  const versions = (
    await db.query<{ id: string }>('select * from public.rule_versions order by id')
  ).rows;
  expect(versions).toHaveLength(3);
  expect(
    versions.filter((version) => before.ruleVersions.some((old) => old.id === version.id))
  ).toEqual(originalVersions);
  expect((await db.query('select * from public.snapshots order by id')).rows).toEqual(
    originalSnapshots
  );
  const rows = (
    await db.query<{ month: string; cpm: string; payable_cents: number }>(
      "select month,policy->'tiers'->0->>'cpm' cpm,payable_cents from public.statements order by month"
    )
  ).rows;
  expect(rows.map((row) => ({ ...row, payable_cents: Number(row.payable_cents) }))).toEqual([
    { month: '2026-10', cpm: '1.50', payable_cents: 0 },
    { month: '2026-11', cpm: '1.00', payable_cents: 0 },
  ]);
  await expect(
    db.query('select public.commit_dashboard($1,$2::jsonb)', [revision + 1, JSON.stringify(next)])
  ).rejects.toThrow(/CONFLICT/);
});
