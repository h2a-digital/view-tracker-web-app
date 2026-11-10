import { thumbnailPersistenceAllowed } from '@/lib/server/thumbnail-policy';
import { browserDashboard } from '@/domain/read-model';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { Access } from '@/components/dashboard/Access';
import { hostedDeployment, hostedPreview } from '@/lib/server/deployment';
import { isConfigured } from '@/lib/server/config';
import { requireAdmin } from '@/lib/server/supabase';
import { loadDashboard } from '@/repositories/dashboard';
import { demoWorkspace } from '@/domain/demo';
export const dynamic = 'force-dynamic';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string }>;
}) {
  const params = await searchParams;
  if (hostedPreview()) return <Access notice="Live access is disabled on preview deployments." />;
  if (!hostedDeployment() && params.preview === '1')
    return <Dashboard initial={demoWorkspace()} preview />;
  if (!isConfigured()) return <Access setup={!hostedDeployment()} />;
  let state;
  let failure = '';
  try {
    await requireAdmin();
    state = await loadDashboard();
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Database is unavailable.';
  }
  if (!state) return <Access notice={failure === 'UNAUTHORIZED' ? '' : failure} />;
  return (
    <Dashboard
      initial={browserDashboard(state.data)}
      thumbnailPreviewOnly={!thumbnailPersistenceAllowed()}
      initialAsOf={new Date().toISOString()}
    />
  );
}
