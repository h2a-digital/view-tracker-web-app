import 'server-only';
import { z } from 'zod';
import { adminDatabase } from '@/lib/server/supabase';
import { seal, unseal } from './crypto';
import { oauthConfig } from './config';
import { providerJson, ProviderError } from './http';
import { instagramLongToken } from './instagram';
import { rejectCallback, type CallbackTrace } from './diagnostics';
export type TokenBundle = {
  accessToken: string;
  authMode?: 'instagram_login' | 'unified_login';
  clientBusinessId?: string;
  configId?: string;
  deletionSubjectId?: string;
  issuedAt?: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopes: string[];
  actorId?: string;
  revocationToken?: string;
};
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});
export async function exchangeGoogle(
  code: string,
  verifier: string,
  deadline = Date.now() + 45000,
  trace?: CallbackTrace
) {
  const c = oauthConfig('youtube');
  const token = tokenResponse.parse(
    await providerJson(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: c.redirectUri,
        }).toString(),
      },
      deadline
    )
  );
  if (!token.refresh_token) {
    if (trace)
      rejectCallback(
        trace,
        'offline_refresh_token_missing',
        'Offline authorization was not granted. Request a new invitation and consent again.'
      );
    throw new Error(
      'Offline authorization was not granted. Request a new invitation and consent again.'
    );
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    scopes: (token.scope || '').split(' '),
  } satisfies TokenBundle;
}
export class AccountToken {
  private row: { encrypted_token: string; version: number } | null = null;
  private bundle: TokenBundle | null = null;
  constructor(
    readonly accountId: string,
    readonly platform: 'youtube' | 'instagram' | 'facebook',
    private deadline: number
  ) {}
  async get(force = false) {
    if (this.bundle && !force) return this.bundle.accessToken;
    const db = adminDatabase();
    const result = await db.rpc('read_direct_credentials', { target_account: this.accountId });
    if (result.error) throw new ProviderError('temporary', 'Credential store is unavailable.');
    if (!result.data)
      throw new ProviderError(
        'authorization',
        'Provider authorization needs attention. Reconnect this account.'
      );
    this.row = result.data;
    this.bundle = unseal<TokenBundle>(result.data.encrypted_token, this.accountId);
    if (
      this.platform === 'instagram' &&
      this.bundle.authMode === 'unified_login' &&
      this.bundle.expiresAt &&
      (!Number.isFinite(Date.parse(this.bundle.expiresAt)) ||
        Date.parse(this.bundle.expiresAt) <= Date.now())
    ) {
      await this.revoke();
      throw new ProviderError(
        'authorization',
        'Instagram authorization expired. Reconnect this account.'
      );
    }
    if (this.platform === 'instagram' && this.bundle.authMode === 'instagram_login') {
      const expires = this.bundle.expiresAt ? Date.parse(this.bundle.expiresAt) : NaN;
      const issued = this.bundle.issuedAt ? Date.parse(this.bundle.issuedAt) : NaN;
      if (!Number.isFinite(expires) || !Number.isFinite(issued) || expires <= Date.now()) {
        await this.revoke();
        throw new ProviderError(
          'authorization',
          'Instagram authorization expired. Reconnect this account.'
        );
      }
      if (expires < Date.now() + 7 * 86400000 && issued <= Date.now() - 86400000) {
        try {
          const query = new URLSearchParams({
            grant_type: 'ig_refresh_token',
            access_token: this.bundle.accessToken,
          });
          const token = instagramLongToken.parse(
            await providerJson(
              `https://graph.instagram.com/refresh_access_token?${query}`,
              {},
              this.deadline
            )
          );
          this.bundle = {
            ...this.bundle,
            accessToken: token.access_token,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
          };
          const saved = await db.rpc('write_direct_credentials', {
            target_account: this.accountId,
            encrypted_token: seal(this.bundle, this.accountId),
            expected_version: this.row!.version,
          });
          if (saved.error || !saved.data) {
            this.bundle = null;
            throw new ProviderError(
              'temporary',
              'Credential refresh changed concurrently. Retry safely.'
            );
          }
          this.row!.version++;
        } catch (error) {
          if (error instanceof ProviderError && error.kind === 'authorization') await this.revoke();
          throw error;
        }
      }
    }
    if (
      this.platform === 'youtube' &&
      (force || (this.bundle.expiresAt && Date.parse(this.bundle.expiresAt) < Date.now() + 120000))
    ) {
      if (!this.bundle.refreshToken) {
        await this.revoke();
        throw new ProviderError(
          'authorization',
          'Provider authorization needs attention. Reconnect this account.'
        );
      }
      const c = oauthConfig('youtube');
      try {
        const token = tokenResponse.parse(
          await providerJson(
            'https://oauth2.googleapis.com/token',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: c.clientId,
                client_secret: c.clientSecret,
                refresh_token: this.bundle.refreshToken,
                grant_type: 'refresh_token',
              }).toString(),
            },
            this.deadline
          )
        );
        this.bundle = {
          ...this.bundle,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? this.bundle.refreshToken,
          expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
        };
        const saved = await db.rpc('write_direct_credentials', {
          target_account: this.accountId,
          encrypted_token: seal(this.bundle, this.accountId),
          expected_version: this.row!.version,
        });
        if (saved.error || !saved.data) {
          this.bundle = null;
          throw new ProviderError(
            'temporary',
            'Credential refresh changed concurrently. Retry safely.'
          );
        }
        this.row!.version++;
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'authorization') await this.revoke();
        throw error;
      }
    }
    return this.bundle.accessToken;
  }
  async revoke() {
    if (this.row) {
      const result = await adminDatabase().rpc('forget_direct_credentials', {
        target_account: this.accountId,
        expected_version: this.row.version,
      });
      if (result.error)
        throw new ProviderError(
          'temporary',
          'Could not erase revoked authorization. Retry pending.'
        );
    }
    this.bundle = null;
  }
}
