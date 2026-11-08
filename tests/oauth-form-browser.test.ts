import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/server/supabase', async () => ({
  ...(await vi.importActual<typeof import('@/lib/server/supabase')>('@/lib/server/supabase')),
  adminDatabase: () => ({ rpc: mocks.rpc }),
}));
import { GET, POST } from '@/app/api/oauth/[platform]/start/route';
// Opt-in real-browser regression; no browser package, live database or OAuth account is required.
const chrome = process.env.UGC_TEST_CHROME;
it.skipIf(!chrome)(
  'reproduces Origin:null with the old policy and completes consent with the fixed policy',
  async () => {
    const params = { params: Promise.resolve({ platform: 'youtube' }) },
      ticket = 'a'.repeat(64),
      seen: {
        origin: string | undefined;
        referer: string | undefined;
        status: number;
        location: string | null;
      }[] = [];
    let origin = '',
      providerOrigin = '',
      mode = 'old';
    const providerVisits: string[] = [];
    const provider = createServer((req, res) => {
      if (req.url === '/provider') providerVisits.push(mode);
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Provider reached</h1>');
    });
    mocks.rpc.mockImplementation(async (name: string) => ({
      error: null,
      data: name === 'read_oauth_invite' ? { platform: 'youtube' } : null,
    }));
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = new Request(new URL(req.url!, origin), {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await (req.method === 'POST'
          ? POST(request, params)
          : GET(request, params));
        if (req.method === 'POST')
          seen.push({
            origin: req.headers.origin,
            referer: req.headers.referer,
            status: response.status,
            location: response.headers.get('location'),
          });
        res.statusCode = response.status;
        for (const [key, value] of response.headers) res.setHeader(key, value);
        if (req.method === 'POST' && response.status === 303)
          res.setHeader('Location', providerOrigin + '/provider'); // Never contact Google.
        if (req.method === 'GET') {
          if (mode === 'old') res.setHeader('Referrer-Policy', 'no-referrer');
          const csp = response.headers.get('Content-Security-Policy')!;
          res.setHeader(
            'Content-Security-Policy',
            mode === 'fixed'
              ? csp.replace('https://accounts.google.com', providerOrigin)
              : csp.replace(' https://accounts.google.com', '')
          );
        }
        let html = await response.text();
        if (req.method === 'GET')
          html = html.replace(
            '</body>',
            '<script>document.querySelector("input[type=checkbox]").checked=true;document.querySelector("form").requestSubmit();</script></body>'
          );
        res.end(html);
      } catch {
        res.statusCode = 500;
        res.end('Fixture error');
      }
    });
    const folder = await mkdtemp(join(tmpdir(), 'creator-oauth-test-'));
    try {
      await new Promise<void>((resolve, reject) => {
        provider.once('error', reject);
        provider.listen(0, '127.0.0.1', resolve);
      });
      providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      for (const [key, value] of Object.entries({
        CONTEXT: 'dev',
        APP_DEPLOYMENT_ENV: 'development',
        APP_URL: origin,
        GOOGLE_CLIENT_ID: 'fixture-client',
        GOOGLE_CLIENT_SECRET: 'fixture-secret',
        OAUTH_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      }))
        vi.stubEnv(key, value);
      const run = promisify(execFile);
      for (const current of ['old', 'origin-only', 'fixed']) {
        mode = current;
        const output = await run(
          chrome!,
          [
            '--headless=new',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            `--user-data-dir=${join(folder, mode)}`,
            '--dump-dom',
            `${origin}/api/oauth/youtube/start?ticket=${ticket}`,
          ],
          { timeout: 20000, maxBuffer: 1000000 }
        );
        if (mode === 'fixed') expect(output.stdout).toContain('Provider reached');
        if (mode === 'origin-only') {
          expect(output.stdout).not.toContain('Provider reached');
          expect(providerVisits).not.toContain(mode);
        }
      }
      expect(providerVisits).toEqual(['fixed']);
      expect(seen[0]).toMatchObject({ origin: 'null', status: 400, location: null });
      expect(seen[1]).toMatchObject({ origin, status: 303 });
      expect(seen[2]).toMatchObject({ origin, status: 303, referer: origin + '/' });
      expect(seen[2].referer).not.toContain(ticket);
      expect(new URL(seen[2].location!).origin).toBe('https://accounts.google.com');
      expect(mocks.rpc.mock.calls.filter(([name]) => name === 'start_oauth_flow')).toHaveLength(2);
      // Optional visual-review artifact, containing fixture values only.
      if (process.env.UGC_TEST_CONSENT_HTML)
        await writeFile(
          process.env.UGC_TEST_CONSENT_HTML,
          await (
            await GET(new Request(`${origin}/api/oauth/youtube/start?ticket=${ticket}`), params)
          ).text()
        );
    } finally {
      vi.unstubAllEnvs();
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  60000
);
