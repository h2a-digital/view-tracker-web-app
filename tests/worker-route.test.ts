import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  database: vi.fn(),
  load: vi.fn(),
  sync: vi.fn(),
  admin: vi.fn(),
  provider: vi.fn(),
}));
vi.mock('@/lib/server/supabase', () => ({
  adminDatabase: mocks.database,
  requireAdmin: mocks.admin,
}));
vi.mock('@/repositories/dashboard', () => ({ loadDashboard: mocks.load }));
vi.mock('@/services/tracking/sync', () => ({ synchronizeAccount: mocks.sync }));
vi.mock('@/services/tracking/zernio', () => ({
  ZernioProvider: class {
    constructor(deadline: number) {
      mocks.provider(deadline);
    }
  },
}));
import { POST } from '@/app/api/internal/jobs/route';
import { GET } from '@/app/api/operations/route';
const secret = 'random-test-secret-'.repeat(3);
const job = { id: 'job', account_id: 'account', lease_token: 'unique-lease' };
function request(auth = `Bearer ${secret}`) {
  return new Request('https://ledger.example.com/api/internal/jobs', {
    method: 'POST',
    headers: { Authorization: auth, 'X-Worker-Source': 'supabase-cron' },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    CONTEXT: 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ADMIN_EMAIL: 'admin@example.com',
    APP_URL: 'https://ledger.example.com',
    ZERNIO_API_KEY: 'test-provider',
    CRON_SECRET: secret,
  }))
    vi.stubEnv(key, value);
  mocks.database.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === 'lease_tracking_job' ? job : true,
    error: null,
  }));
  mocks.load.mockResolvedValue({
    data: { accounts: [{ id: 'account', status: 'connected' }] },
    revision: 3,
  });
  mocks.sync.mockResolvedValue({
    syncRuns: [{ account_id: 'account', status: 'success', diagnostics: { postsFetched: 5 } }],
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('authenticated scheduled worker', () => {
  it.each(['', 'Bearer wrong', 'Basic invalid'])(
    'rejects invalid authorization without touching the database (%s)',
    async (auth) => {
      expect((await POST(request(auth))).status).toBe(401);
      expect(mocks.database).not.toHaveBeenCalled();
    }
  );
  it('does not run on previews or with an insecure production origin', async () => {
    vi.stubEnv('CONTEXT', 'deploy-preview');
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv('CONTEXT', 'production');
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    expect((await POST(request())).status).toBe(503);
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it('records a healthy idle invocation without calling the provider', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === 'lease_tracking_job' ? null : true,
      error: null,
    }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 0, success: true });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      'record_worker_invocation',
      expect.objectContaining({
        invocation_source: 'supabase-cron',
        invocation_outcome: 'idle',
        response_status: 200,
      })
    );
  });
  it('saves sync diagnostics and completes the current lease in one database transaction', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      processed: 1,
      success: true,
      diagnostics: { postsFetched: 5 },
    });
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      'commit_tracking_job',
      expect.objectContaining({
        job_id: 'job',
        expected_lease_token: 'unique-lease',
        expected_revision: 3,
        success: true,
      })
    );
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'commit_dashboard')).toBe(false);
  });
  it('records temporary provider failures and lets the queue back off', async () => {
    mocks.sync.mockResolvedValue({ syncRuns: [{ account_id: 'account', status: 'failed' }] });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'commit_tracking_job',
      expect.objectContaining({ success: false })
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      'record_worker_invocation',
      expect.objectContaining({ invocation_outcome: 'failed', response_status: 503 })
    );
  });
  it('handles an optimistic conflict or lost lease without unfenced completion', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === 'lease_tracking_job' ? job : false,
      error: name === 'commit_tracking_job' ? { message: 'LEASE_LOST' } : null,
    }));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'finish_tracking_job',
      expect.objectContaining({ expected_lease_token: 'unique-lease', success: false })
    );
  });
  it('keeps queue failures visible in health diagnostics', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: null,
      error: name === 'enqueue_tracking' ? { message: 'unavailable' } : null,
    }));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      'record_worker_invocation',
      expect.objectContaining({ invocation_outcome: 'failed' })
    );
  });
  it('deducts startup latency from the provider budget', async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    mocks.load.mockImplementation(async () => {
      clock.mockReturnValue(started + 10000);
      return { data: { accounts: [{ id: 'account', status: 'connected' }] }, revision: 3 };
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.provider).toHaveBeenCalledWith(started + 45000);
    expect(mocks.provider.mock.calls[0][0] - Date.now()).toBe(35000);
  });
  it('blocks baked preview deployments without runtime CONTEXT', async () => {
    vi.stubEnv('CONTEXT', '');
    vi.stubEnv('APP_DEPLOYMENT_ENV', 'preview');
    expect((await POST(request())).status).toBe(503);
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it('requires administrator authorization before returning operations data', async () => {
    mocks.admin.mockRejectedValue(new Error('UNAUTHORIZED'));
    expect((await GET()).status).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
  });
});
