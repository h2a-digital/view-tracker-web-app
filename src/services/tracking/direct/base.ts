import 'server-only';
import { createHmac } from 'node:crypto';
import type { SocialAccount } from '@/domain/model';
import { AccountToken } from '@/services/oauth/tokens';
import { ProviderError, providerJson } from '@/services/oauth/http';
import { oauthConfig, instagramAuthMode } from '@/services/oauth/config';
export class DirectAccess {
  readonly token: AccountToken;
  readonly patch: NonNullable<SocialAccount['integration']> = {};
  constructor(
    readonly account: SocialAccount,
    readonly deadline: number
  ) {
    this.token = new AccountToken(
      account.id,
      account.platform as 'youtube' | 'instagram' | 'facebook',
      deadline
    );
  }
  async request(url: string, retried = false): Promise<unknown> {
    const mode =
      this.account.platform === 'instagram' ? instagramAuthMode(this.account) : 'facebook_login';
    if (mode === 'unified_login') {
      const parsed = new URL(url),
        c = oauthConfig('instagram', mode);
      // Permit only the exact fields used for tracking, never Graph field expansion
      // into messages/conversations or unrelated assets, even with a broad grant.
      const prefix = `/${c.version}/`;
      const path = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : '';
      const assigned = path === 'me/assigned_instagram_accounts';
      const media = /^[0-9]+\/media$/.test(path);
      const insights = /^[0-9]+\/insights$/.test(path);
      const identity = /^[0-9]+$/.test(path);
      const fields = parsed.searchParams.get('fields');
      const profile =
        path === this.account.provider_account_id &&
        fields === 'id,username,name,profile_picture_url';
      const allowed = insights
        ? ['metric', 'period']
        : identity
          ? ['fields']
          : ['fields', 'limit', 'after'];
      if (
        parsed.origin !== 'https://graph.facebook.com' ||
        !(assigned || media || insights || identity) ||
        [...parsed.searchParams.keys()].some((key) => !allowed.includes(key)) ||
        (assigned && fields !== 'id,username') ||
        (media &&
          ![
            'id,caption,timestamp,permalink,media_product_type',
            'id,caption,timestamp,permalink,media_product_type,thumbnail_url',
          ].includes(fields || '')) ||
        (identity && fields !== 'id,caption' && !profile) ||
        (insights &&
          (parsed.searchParams.get('metric') !== 'views' ||
            parsed.searchParams.get('period') !== 'lifetime'))
      )
        throw new ProviderError(
          'configuration',
          'This Instagram endpoint is not permitted for tracking.'
        );
    }
    const token = await this.token.get();
    let target = url;
    if (
      this.account.platform !== 'youtube' &&
      !(
        this.account.platform === 'instagram' &&
        instagramAuthMode(this.account) === 'instagram_login'
      )
    ) {
      const c = oauthConfig(this.account.platform as 'instagram' | 'facebook', mode),
        parsed = new URL(url);
      parsed.searchParams.set(
        'appsecret_proof',
        createHmac('sha256', c.clientSecret).update(token).digest('hex')
      );
      target = parsed.toString();
    }
    try {
      return await providerJson(
        target,
        { headers: { Authorization: `Bearer ${token}` } },
        this.deadline
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.kind === 'rate_limit')
          this.patch.retryAfterAt = new Date(
            Date.now() + error.retryAfterSeconds * 1000
          ).toISOString();
        if (error.kind === 'authorization') {
          if (this.account.platform === 'youtube' && !retried) {
            await this.token.get(true);
            return this.request(url, true);
          }
          await this.token.revoke();
        }
      }
      throw error;
    }
  }
}
export function safeCounter(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
export function durationSeconds(value: string) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  return match
    ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)
    : Infinity;
}
/** Exact reporting-day boundaries, including 23/25-hour Pacific DST days. */
export function pacificDayBounds(day: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error('Invalid Analytics reporting date.');
  const startOf = (value: string) => {
    const base = Date.parse(value + 'T00:00:00Z');
    let candidate = base;
    for (let n = 0; n < 3; n++) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(candidate));
      const get = (type: string) => parts.find((p) => p.type === type)!.value;
      const local = Date.parse(
        `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`
      );
      candidate = base - (local - candidate);
    }
    return new Date(candidate).toISOString();
  };
  const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  return { periodStart: startOf(day), periodEnd: startOf(next) };
}
