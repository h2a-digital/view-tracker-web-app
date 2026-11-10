import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextResponse } from 'next/server';
import { createTestDatabase } from './helpers/database';
import { runCommand, seedData } from '@/domain/commands';
import { loadMissingThumbnails } from '@/services/tracking/thumbnail-refresh';
import { withThumbnailOverrides } from '@/domain/thumbnail-overrides';
import { PostGrid } from '@/components/dashboard/PostGrid';
import type { DashboardData } from '@/domain/model';
import type { TrackingProvider } from '@/services/tracking/provider';
// Optional real assets are obtained by a separate read-only check; this test never calls a live service.
it('round-trips five fetched previews through isolated PostgreSQL, API JSON and actual card image markup', async () => {
  const assets: { url: string }[] = process.env.UGC_TEST_PREVIEW_MANIFEST
    ? JSON.parse(readFileSync(process.env.UGC_TEST_PREVIEW_MANIFEST, 'utf8'))
    : Array.from({ length: 5 }, (_, i) => ({
        url: `https://media.zernio.com/test-preview-${i}.jpg`,
      }));
  let data = seedData(new Date('2026-01-01T00:00:00Z'));
  const go = (command: unknown) => (data = runCommand(data, command));
  go({ type: 'createCreator', name: 'Isolated creator' });
  go({
    type: 'assignCreator',
    creatorId: data.creators[0].id,
    campaignId: data.campaigns[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'registerAccount',
    creatorId: data.creators[0].id,
    platform: 'tiktok',
    provider: 'zernio',
    ownership: 'creator',
    username: 'isolated',
  });
  go({
    type: 'mapAccount',
    accountId: data.accounts[0].id,
    membershipId: data.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  for (let i = 0; i < 5; i++)
    go({
      type: 'addPost',
      input: {
        accountId: data.accounts[0].id,
        platformPostId: String(123450 + i),
        url: `https://www.tiktok.com/@isolated/video/${123450 + i}`,
        publishedAt: '2026-10-03T00:22:21Z',
        campaignId: data.campaigns[0].id,
        caption: `Preview ${i + 1}`,
      },
    });
  data.accounts[0].status = 'connected';
  data.accounts[0].provider_account_id = 'remote';
  const provider: TrackingProvider = {
    name: 'test',
    capabilities: () => ({
      discovery: true,
      publicViews: true,
      organicViews: false,
      platforms: ['tiktok'],
    }),
    discoverPosts: async () => {
      throw Error('No discovery allowed');
    },
    fetchMetrics: async () => {
      throw Error('No metrics allowed');
    },
    fetchThumbnails: async (_id, targets) =>
      targets.map((t, i) => ({ platformPostId: t.platformPostId, thumbnailUrl: assets[i].url })),
  };
  const db = await createTestDatabase(true, 5);
  try {
    const loaded = await loadMissingThumbnails(data, data.accounts[0], provider);
    const asOf = new Date().toISOString();
    const next = withThumbnailOverrides(data, loaded.overrides, Date.parse(asOf));
    await db.query(
      "select public.commit_dashboard((public.read_dashboard()->>'revision')::bigint,$1::jsonb)",
      [JSON.stringify(next)]
    );
    const stored = (
      await db.query<{ workspace: { data: DashboardData } }>(
        'select public.read_dashboard() workspace'
      )
    ).rows[0].workspace.data;
    const response = NextResponse.json({ data: stored, asOf });
    const payload = await response.json();
    const markup = renderToStaticMarkup(
      <PostGrid
        data={payload.data}
        posts={payload.data.posts}
        now={Date.parse(payload.asOf)}
        onOpen={() => {}}
      />
    );
    expect(markup.match(/class="post-thumbnail-foreground"/g)).toHaveLength(5);
    expect(markup.match(/class="post-thumbnail-background"/g)).toHaveLength(5);
    expect(markup).not.toContain('Preview unavailable');
    for (const asset of assets.slice(0, 5))
      expect(markup).toContain(asset.url.replaceAll('&', '&amp;'));
    expect(stored.snapshots).toEqual(data.snapshots);
    expect(stored.statements).toEqual(data.statements);
    for (let i = 0; i < 5; i++) {
      expect(stored.posts[i].campaign_id).toBe(data.posts[i].campaign_id);
      expect(stored.posts[i].eligible_views).toBe(data.posts[i].eligible_views);
    }
  } finally {
    await db.close();
  }
});
