import { runCommand, seedData } from '@/domain/commands';
import { nextMonthStart } from '@/domain/compensation';
import type { DashboardData } from '@/domain/model';
const now = new Date('2026-11-13T21:00:00Z');
export function initialSetupFixture() {
  let data = seedData(new Date('2026-01-01T00:00:00Z'));
  const go = (raw: unknown) => (data = runCommand(data, raw, 'Setup administrator', now));
  go({ type: 'createCreator', name: 'Company test identity' });
  go({
    type: 'assignCreator',
    creatorId: data.creators[0].id,
    campaignId: data.campaigns[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'registerAccount',
    creatorId: data.creators[0].id,
    platform: 'instagram',
    username: 'companytest',
    ownership: 'company',
    provider: 'zernio',
  });
  for (const [index, publishedAt] of ['2026-10-01T12:00:00Z', '2026-11-10T17:27:32Z'].entries()) {
    go({
      type: 'addPost',
      input: {
        accountId: data.accounts[0].id,
        campaignId: data.campaigns[0].id,
        platformPostId: String(10000 + index),
        url: `https://instagram.com/reel/Test${index}`,
        publishedAt,
      },
    });
    go({
      type: 'addSnapshot',
      input: {
        postId: data.posts.at(-1)!.id,
        views: 140,
        metric: 'public_views',
        observedAt: index ? '2026-11-11T18:00:00Z' : '2026-10-02T12:00:00Z',
      },
    });
    go({
      type: 'generateStatement',
      appId: data.apps[0].id,
      creatorId: data.creators[0].id,
      month: index ? '2026-11' : '2026-10',
    });
  }
  go({
    type: 'saveRules',
    scope: 'app',
    appId: data.apps[0].id,
    campaignId: null,
    creatorId: null,
    effectiveAt: nextMonthStart(now),
    patch: {
      ...data.ruleVersions[0].patch,
      tiers: [
        { upTo: 100000, cpm: '1.00' },
        { upTo: 500000, cpm: '0.50' },
        { upTo: null, cpm: '0.25' },
      ],
    },
  });
  return data;
}
export function initialCommand(data: DashboardData) {
  return {
    type: 'saveRules',
    activation: 'initial_setup_now',
    scope: 'app',
    appId: data.apps[0].id,
    campaignId: null,
    creatorId: null,
    effectiveAt: '2000-01-01T00:00:00Z',
    patch: data.ruleVersions.at(-1)!.patch,
  };
}
