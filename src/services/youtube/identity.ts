import { z } from 'zod';
export const channelSnippet = z.object({
  title: z.string().optional(),
  customUrl: z.string().optional(),
  thumbnails: z
    .object({
      default: z.object({ url: z.string() }).optional(),
      medium: z.object({ url: z.string() }).optional(),
      high: z.object({ url: z.string() }).optional(),
    })
    .optional(),
});
export function channelIdentity(value: z.infer<typeof channelSnippet>) {
  if (!value.title?.trim()) return undefined;
  const avatar =
    value.thumbnails?.default?.url || value.thumbnails?.medium?.url || value.thumbnails?.high?.url;
  let avatarUrl: string | undefined;
  try {
    const u = new URL(avatar || '');
    if (
      u.protocol === 'https:' &&
      ['yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(u.hostname)
    )
      avatarUrl = avatar;
  } catch {
    /* Missing avatars use initials. */
  }
  return {
    title: value.title,
    handle: value.customUrl?.startsWith('@') ? value.customUrl : undefined,
    avatarUrl,
    refreshedAt: new Date().toISOString(),
  };
}
