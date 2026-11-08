import 'server-only';
import { randomUUID } from 'node:crypto';
import { ProviderError } from './http';
export type CallbackStage =
  | 'configuration'
  | 'request_validation'
  | 'browser_cookie'
  | 'flow_lookup'
  | 'flow_validation'
  | 'dashboard_load'
  | 'registered_account'
  | 'verifier_decryption'
  | 'google_token_exchange'
  | 'google_scope_validation'
  | 'google_channel_lookup'
  | 'google_handle_resolution'
  | 'google_channel_match'
  | 'meta_authorization'
  | 'dashboard_reload'
  | 'account_revalidation'
  | 'token_encryption'
  | 'database_commit'
  | 'response'
  | 'route';
export type CallbackTrace = {
  stage: CallbackStage;
  platform: 'youtube' | 'instagram' | 'facebook' | 'unknown';
  reason?: string;
  databaseCode?: string;
  youtubeReadGranted?: boolean;
  youtubeAnalyticsGranted?: boolean;
  authorizedChannelCount?: number;
};
class CallbackRejection extends Error {}
export function rejectCallback(trace: CallbackTrace, reason: string, message: string): never {
  trace.reason = reason;
  throw new CallbackRejection(message);
}
export function callbackDatabaseError(
  trace: CallbackTrace,
  error: { code?: string; message?: string }
) {
  if (error.code && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(error.code))
    trace.databaseCode = error.code;
  // Inspect known patterns locally; NEVER log PostgREST messages, details, hints or SQL payloads.
  trace.reason = error.message?.includes('CONFLICT')
    ? 'workspace_revision_conflict'
    : /OAuth flow expired/.test(error.message || '')
      ? 'flow_expired_or_consumed'
      : error.code === '42501'
        ? 'database_permission_denied'
        : ['PGRST202', '42883'].includes(error.code || '')
          ? 'database_function_missing_or_schema_cache_stale'
          : error.code === 'PGRST203'
            ? 'database_function_signature_ambiguous'
            : error.code === '42702'
              ? 'database_sql_reference_ambiguous'
              : error.code === '23505'
                ? 'database_unique_constraint'
                : 'database_request_failed';
}
export class OAuthCallbackFailure extends Error {
  constructor(
    readonly reference: string,
    message: string
  ) {
    super(message);
  }
}
export function reportCallbackFailure(trace: CallbackTrace, error: unknown) {
  const reference = randomUUID();
  const provider = error instanceof ProviderError ? error : undefined;
  const configurationFailure =
    error instanceof Error && ['PREVIEW_DISABLED', 'SETUP_REQUIRED'].includes(error.message)
      ? error.message
      : undefined;
  const reason =
    trace.reason ||
    (configurationFailure
      ? configurationFailure.toLowerCase()
      : trace.stage === 'verifier_decryption'
        ? 'encryption_key_changed_or_invalid_state'
        : error instanceof Error && error.name === 'ZodError'
          ? 'unexpected_provider_response_shape'
          : (trace.stage === 'dashboard_load' || trace.stage === 'dashboard_reload') &&
              error instanceof Error &&
              error.message.includes('202611080004_provider_lifecycle.sql')
            ? 'database_schema_version_mismatch'
            : provider
              ? 'provider_request_failed'
              : 'operation_failed');
  // Construct an allow-list record; never spread request, error, trace or provider objects.
  console.error(
    JSON.stringify({
      event: 'oauth_callback_failed',
      reference,
      platform: trace.platform,
      stage: trace.stage,
      reason,
      ...(trace.databaseCode ? { databaseCode: trace.databaseCode } : {}),
      ...(provider
        ? {
            providerKind: provider.kind,
            providerStatus: provider.diagnostic?.status,
            providerReason: provider.diagnostic?.reason,
          }
        : {}),
      ...(trace.youtubeReadGranted !== undefined
        ? { youtubeReadGranted: trace.youtubeReadGranted }
        : {}),
      ...(trace.youtubeAnalyticsGranted !== undefined
        ? { youtubeAnalyticsGranted: trace.youtubeAnalyticsGranted }
        : {}),
      ...(trace.authorizedChannelCount !== undefined
        ? { authorizedChannelCount: trace.authorizedChannelCount }
        : {}),
    })
  );
  return new OAuthCallbackFailure(
    reference,
    error instanceof CallbackRejection
      ? error.message
      : configurationFailure ||
        (trace.stage === 'google_handle_resolution'
          ? 'A different YouTube channel was authorized or its registered handle could not be resolved.'
          : `OAuth callback failed during ${trace.stage}.`)
  );
}
