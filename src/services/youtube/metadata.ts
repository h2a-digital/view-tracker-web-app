import 'server-only';
import { z } from 'zod';
import type { DashboardData, SocialAccount } from '@/domain/model';
import { DirectAccess } from '@/services/tracking/direct/base';
import { providerJson } from '@/services/oauth/http';
import { channelIdentity, channelSnippet } from './identity';
const responseSchema = z.object({
  items: z.array(z.object({ id: z.string(), snippet: channelSnippet })),
});
const channelId = /^UC[A-Za-z0-9_-]{22}$/;
export type MetadataResult = {
  accountId: string;
  status: 'updated' | 'cached' | 'not_found' | 'unavailable' | 'credentials_required' | 'changed';
  identity?: ReturnType<typeof channelIdentity>;
  message?: string;
};

/** Public metadata only. This never connects an account or changes its verified identity. */
export async function lookupYouTubeMetadata(
  data: DashboardData,
  targets: SocialAccount[],
  deadline = Date.now() + 20000
): Promise<MetadataResult[]> {
  const results: MetadataResult[] = [];
  const due = targets.filter((a) => {
    const last =
      a.integration?.channelIdentityLookup?.checkedAt ||
      a.integration?.channelIdentity?.refreshedAt;
    if (last && Date.now() - Date.parse(last) < 60000) {
      results.push({ accountId: a.id, status: 'cached' });
      return false;
    }
    return true;
  });
  if (!due.length) return results;
  const key = process.env.YOUTUBE_DATA_API_KEY;
  const credential = data.accounts.find(
    (a) =>
      a.platform === 'youtube' &&
      a.provider === 'direct' &&
      a.status === 'connected' &&
      !a.archived &&
      !a.integration?.sourceErasedAt
  );
  if (!key && !credential)
    return [
      ...results,
      ...due.map((a) => ({
        accountId: a.id,
        status: 'credentials_required' as const,
        message:
          'Connect a YouTube account or configure server-only YOUTUBE_DATA_API_KEY for public metadata.',
      })),
    ];
  const access = credential ? new DirectAccess(credential, deadline) : null;
  const request = async (query: URLSearchParams) => {
    const url = `https://www.googleapis.com/youtube/v3/channels?${query}`;
    const body = key
      ? await providerJson(url, { headers: { 'X-Goog-Api-Key': key } }, deadline)
      : await access!.request(url);
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new Error('YouTube returned an invalid channel metadata response.');
    return parsed.data.items;
  };
  const ids = due.filter((a) => channelId.test(a.provider_account_id || a.username));
  if (ids.length) {
    try {
      const query = new URLSearchParams({
        part: 'id,snippet',
        id: [...new Set(ids.map((a) => a.provider_account_id || a.username))].join(','),
        maxResults: '50',
      });
      const items = await request(query);
      for (const a of ids) {
        const match = items.find((item) => item.id === (a.provider_account_id || a.username));
        const identity = match ? channelIdentity(match.snippet) : undefined;
        results.push({
          accountId: a.id,
          status: identity ? 'updated' : match ? 'unavailable' : 'not_found',
          identity,
        });
      }
    } catch {
      for (const a of ids)
        results.push({
          accountId: a.id,
          status: 'unavailable',
          message:
            'YouTube metadata request failed. Check credentials, quota and connection health, then retry.',
        });
    }
  }
  for (const a of due.filter((a) => !ids.includes(a))) {
    // A connected account must have an immutable channel ID; never reinterpret it as a handle.
    if (a.provider_account_id) {
      results.push({
        accountId: a.id,
        status: 'unavailable',
        message: 'The saved channel ID is invalid. Review the registered account.',
      });
      continue;
    }
    try {
      const items = await request(
        new URLSearchParams({ part: 'id,snippet', forHandle: a.username })
      );
      const item = items.length === 1 && channelId.test(items[0].id) ? items[0] : undefined;
      const identity = item ? channelIdentity(item.snippet) : undefined;
      results.push({
        accountId: a.id,
        status: identity ? 'updated' : item ? 'unavailable' : 'not_found',
        identity,
      });
    } catch {
      results.push({
        accountId: a.id,
        status: 'unavailable',
        message: 'Public channel metadata could not be retrieved. Verify the channel ID or handle.',
      });
    }
  }
  return results;
}
