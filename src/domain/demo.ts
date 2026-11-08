import { seedData, runCommand } from './commands';
import { publicationMonth } from './compensation';
import type { DashboardData } from './model';
export function demoWorkspace(): DashboardData {
  let d = seedData(new Date(new Date().getFullYear() - 1, 0, 1));
  const now = new Date();
  const historical = new Date(now.getFullYear(), now.getMonth() - 1, 12, 12).toISOString();
  const app = d.apps[0].id,
    campaign = d.campaigns[0].id;
  for (const [index, name] of ['Alex Morgan', 'Sofia Chen', 'Jamie Rivera'].entries()) {
    d = runCommand(d, {
      type: 'createCreator',
      name,
      email: `${name.split(' ')[0].toLowerCase()}@example.com`,
      notes: 'Sample creator. Preview data only.',
    });
    const creator = d.creators.at(-1)!;
    d = runCommand(d, {
      type: 'assignCreator',
      creatorId: creator.id,
      campaignId: campaign,
      startsAt: `${now.getFullYear() - 1}-01-01T00:00:00.000Z`,
      endsAt: null,
    });
    const membership = d.memberships.at(-1)!;
    for (const platform of ['tiktok', 'instagram', 'youtube'] as const) {
      d = runCommand(d, {
        type: 'registerAccount',
        creatorId: creator.id,
        platform,
        username: `${name.split(' ')[0].toLowerCase()}.creates`,
        ownership: 'creator',
        provider: platform === 'tiktok' ? 'zernio' : 'manual',
      });
      const account = d.accounts.at(-1)!;
      d = runCommand(d, {
        type: 'mapAccount',
        accountId: account.id,
        membershipId: membership.id,
        startsAt: `${now.getFullYear() - 1}-01-01T00:00:00.000Z`,
        endsAt: null,
      });
      for (let n = 0; n < 3; n++) {
        const publishedAt = new Date(
          new Date(historical).getTime() + (index * 3 + n) * 86400000
        ).toISOString();
        const pid = `${7000000 + index * 100 + n}${platform === 'tiktok' ? '1' : platform === 'instagram' ? '2' : '3'}`;
        const urls = {
          tiktok: `https://www.tiktok.com/@${account.username}/video/${pid}`,
          instagram: `https://www.instagram.com/reel/${pid}`,
          youtube: `https://www.youtube.com/shorts/${pid}`,
        };
        d = runCommand(d, {
          type: 'addPost',
          input: {
            accountId: account.id,
            platformPostId: pid,
            url: urls[platform],
            caption: [
              'A little habit that changed my mornings',
              'Your next favorite app is here',
              'Three things I wish I knew sooner',
            ][n],
            publishedAt,
            campaignId: campaign,
          },
        });
        const post = d.posts.at(-1)!;
        const views =
          (index + 1) * 3400 +
          (n + 1) * 6800 +
          (platform === 'tiktok' ? 14000 : platform === 'instagram' ? 8000 : 3000);
        for (let day = 1; day <= 7; day++)
          d = runCommand(d, {
            type: 'addSnapshot',
            input: {
              postId: post.id,
              views: Math.round((views * day) / 7),
              metric: 'public_views',
              observedAt: new Date(new Date(publishedAt).getTime() + day * 86400000).toISOString(),
              source: 'manual',
              evidence: 'Sample observation for the interactive preview.',
            },
          });
        d = runCommand(d, {
          type: 'reviewPost',
          postId: post.id,
          decision: 'accepted',
          eligibleViews: views,
          note: 'Sample reviewed organic count. No real creator or earnings.',
          evidence: {
            reference: 'Sample evidence only, not a real analytics export',
            windowStart: post.published_at,
            windowEnd: post.deadline!,
            organicConfirmed: true,
            cutoffConfirmed: true,
          },
        });
      }
    }
    d = runCommand(d, {
      type: 'generateStatement',
      appId: app,
      creatorId: creator.id,
      month: publicationMonth(historical),
    });
  }
  // New app starts with its own defaults and no shared financial pool.
  d = runCommand(d, { type: 'createApp', name: 'Next app', color: '#64bda6' });
  d.audit = d.audit.slice(0, 12);
  return d;
}
