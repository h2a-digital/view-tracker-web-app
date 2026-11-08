import 'server-only';
import type { SocialAccount } from '@/domain/model';
import type { TrackingProvider } from './provider';
import { ZernioProvider } from './zernio';
import { YouTubeProvider } from './direct/youtube';
import { MetaProvider } from './direct/meta';
export function trackingProvider(account: SocialAccount, deadline: number): TrackingProvider {
  if (account.provider === 'zernio' && account.platform === 'tiktok')
    return new ZernioProvider(deadline);
  if (account.provider === 'direct' && account.platform === 'youtube')
    return new YouTubeProvider(account, deadline);
  if (account.provider === 'direct' && ['instagram', 'facebook'].includes(account.platform))
    return new MetaProvider(account, deadline);
  throw new Error('No automated provider for this account.');
}
