import type { ProfileMetadata } from '@/domain/model';
import { providerImageUrl as profileAvatar } from '@/lib/provider-images';
export { providerImageUrl as profileAvatar } from '@/lib/provider-images';
export function profileIdentity(
  name: unknown,
  username: unknown,
  avatar: unknown
): ProfileMetadata {
  return {
    name: typeof name === 'string' && name.trim() ? name : undefined,
    username:
      typeof username === 'string' && username.trim() ? username.replace(/^@/, '') : undefined,
    avatarUrl: profileAvatar(avatar),
    refreshedAt: new Date().toISOString(),
  };
}

export function mergeProfile(
  previous: ProfileMetadata | undefined,
  next: ProfileMetadata
): ProfileMetadata {
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
  } as ProfileMetadata;
}
