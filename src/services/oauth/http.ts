import 'server-only';
const knownProviderReasons = [
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'redirect_uri_mismatch',
  'access_denied',
  'invalid_scope',
  'invalid_request',
  'insufficientPermissions',
  'accessNotConfigured',
  'serviceDisabled',
  'SERVICE_DISABLED',
  'PERMISSION_DENIED',
  'quotaExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'youtubeSignupRequired',
] as const;
type DiagnosticReason = (typeof knownProviderReasons)[number] | 'unrecognized';
export class ProviderError extends Error {
  constructor(
    public readonly kind: 'authorization' | 'rate_limit' | 'temporary' | 'configuration',
    message: string,
    public readonly retryAfterSeconds = 60,
    public readonly diagnostic?: { status: number; reason: DiagnosticReason }
  ) {
    super(message);
  }
}
export async function providerJson(
  url: string,
  init: RequestInit = {},
  deadline = Date.now() + 15000
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining < 500) throw new ProviderError('temporary', 'Provider time budget exhausted.');
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(10000, remaining)),
    });
  } catch {
    throw new ProviderError('temporary', 'Provider network failure or timeout.');
  }
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: number; status?: string; errors?: { reason?: string }[] } | string;
  } | null;
  const code = typeof body?.error === 'object' ? body.error?.code : null;
  const reason = typeof body?.error === 'object' ? body.error.errors?.[0]?.reason : null;
  const candidate =
    typeof body?.error === 'string'
      ? body.error
      : reason || (typeof body?.error === 'object' ? body.error?.status : undefined);
  const diagnostic = {
    status: response.status,
    reason: knownProviderReasons.includes(candidate as (typeof knownProviderReasons)[number])
      ? (candidate as DiagnosticReason)
      : ('unrecognized' as const),
  };
  if (
    response.status === 429 ||
    [4, 17, 32, 613, 80001, 80002].includes(code ?? 0) ||
    ['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(
      reason ?? ''
    )
  ) {
    const raw = response.headers.get('retry-after');
    const seconds =
      raw && /^\d+$/.test(raw)
        ? Number(raw)
        : raw
          ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
          : 60;
    throw new ProviderError(
      'rate_limit',
      'Provider rate limit; automatic retry scheduled.',
      Math.max(60, Math.min(Number.isFinite(seconds) ? seconds : 60, 86400)),
      diagnostic
    );
  }
  if (response.status === 401 || code === 190 || body?.error === 'invalid_grant')
    throw new ProviderError(
      'authorization',
      'Provider authorization needs attention. Reconnect this account.',
      60,
      diagnostic
    );
  if (!response.ok || body?.error)
    throw new ProviderError(
      response.status === 403 ? 'configuration' : 'temporary',
      response.status === 403
        ? 'Provider permission or API approval is missing. Check app configuration.'
        : `Provider request failed (${response.status}); retry scheduled.`,
      60,
      diagnostic
    );
  return body;
}
