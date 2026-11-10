import { runCommand, seedData } from '@/domain/commands';
import type { DashboardData, Post } from '@/domain/model';
import { trackingState } from '@/domain/tracking';
export function paginationFixture(trackedAtPublication = false): DashboardData {
  const clock = new Date('2026-11-10T12:00:00Z');
  let data = seedData(clock);
  const go = (command: unknown) => {
    data = runCommand(data, command, 'test admin', clock);
  };
  go({ type: 'createCreator', name: 'First creator' });
  const creatorId = data.creators[0].id,
    campaignId = data.campaigns[0].id;
  go({ type: 'assignCreator', creatorId, campaignId, startsAt: '2026-01-01T00:00:00Z' });
  go({
    type: 'registerAccount',
    creatorId,
    platform: 'tiktok',
    username: 'versel',
    ownership: 'creator',
    provider: 'zernio',
  });
  const tiktok = data.accounts[0];
  go({
    type: 'mapAccount',
    accountId: tiktok.id,
    membershipId: data.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'addPost',
    input: {
      accountId: tiktok.id,
      platformPostId: '123456789',
      url: 'https://www.tiktok.com/@versel/video/123456789',
      publishedAt: '2026-10-12T12:00:00Z',
      campaignId,
    },
  });
  const template = data.posts[0];
  data.posts = [];
  go({
    type: 'registerAccount',
    creatorId,
    platform: 'instagram',
    username: 'looksup_app',
    ownership: 'company',
    provider: 'zernio',
  });
  const instagram = data.accounts.find((a) => a.platform === 'instagram')!;
  for (let i = 0; i < 54; i++) {
    const unmapped = i < 49;
    const post: Post = {
      ...structuredClone(template),
      id: crypto.randomUUID(),
      account_id: unmapped ? instagram.id : tiktok.id,
      platform: unmapped ? 'instagram' : 'tiktok',
      platform_post_id: String(100000000 + i),
      url: `https://example.com/post/${i}`,
      caption: `Video ${String(i).padStart(2, '0')}`,
      published_at: `2026-10-${String(1 + Math.floor(i / 3)).padStart(2, '0')}T12:00:00.000Z`,
      ...(unmapped
        ? {
            app_id: null,
            campaign_id: null,
            deadline: null,
            rules: null,
            rule_version_ids: [],
            tracking: null,
          }
        : {}),
    };
    data.posts.push(post);
    if (unmapped && trackedAtPublication)
      post.tracking = {
        ...trackingState(data, post, clock.toISOString()),
        firstSeenAt: post.published_at,
      };
    data.snapshots.push({
      id: crypto.randomUUID(),
      post_id: post.id,
      views: i * 100,
      metric: 'public_views',
      source: 'api',
      observed_at: '2026-11-10T12:00:00Z',
      provider_updated_at: null,
      evidence: null,
      quality: 'reported',
      provider: 'zernio',
    });
  }
  return data;
}
