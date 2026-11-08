import 'server-only';
import { adminDatabase } from '@/lib/server/supabase';
import type { DashboardData } from '@/domain/model';
export async function loadDashboard(): Promise<{ data: DashboardData; revision: number }> {
  const db = adminDatabase();
  const { data, error } = await db.rpc('read_dashboard');
  if (error)
    throw new Error('Could not read the database. Apply the Supabase migration and seed first.');
  if (data.schemaVersion !== 3 || data.accountingTimezone !== 'America/New_York')
    throw new Error(
      'Apply the incremental migration 202611080002_production_operations.sql before running this version. Do not rerun the original migration.'
    );
  // PostgreSQL emits +00:00 and omits milliseconds; the domain compares canonical UTC instants.
  const dates = new Set([
    'starts_at',
    'ends_at',
    'effective_at',
    'created_at',
    'published_at',
    'deadline',
    'accepted_at',
    'observed_at',
    'provider_updated_at',
    'finalized_at',
    'paid_at',
    'last_synced_at',
    'started_at',
    'finished_at',
  ]);
  const normalized = JSON.parse(JSON.stringify(data), (key, value) =>
    dates.has(key) && typeof value === 'string' ? new Date(value).toISOString() : value
  );
  return normalized as { data: DashboardData; revision: number };
}
export async function saveDashboard(data: DashboardData, revision: number) {
  const { error } = await adminDatabase().rpc('commit_dashboard', {
    expected_revision: revision,
    document: data,
  });
  if (error) {
    if (error.message.includes('CONFLICT'))
      throw new Error('Another operation changed these records. Refresh and try again.');
    throw new Error(
      'The database rejected this operation. Check the server logs and migration status.'
    );
  }
}
