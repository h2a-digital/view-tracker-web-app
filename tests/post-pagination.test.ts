import { expect, it } from 'vitest';
import { paginationFixture } from './helpers/pagination';
import { populatedDocument } from './helpers/dashboard';
import { paginatePosts, postPageSchema } from '@/domain/post-pages';
import { groupReviews } from '@/domain/review-groups';
import { browserDashboard } from '@/domain/read-model';
import { runCommand } from '@/domain/commands';
import { calculateProvisional } from '@/domain/compensation';
const clock = new Date('2026-11-10T12:00:00Z');
it('paginates 54 posts with stable ordering, accurate counts and page clamping', () => {
  const data = paginationFixture();
  const pages = [1, 2, 3].map((page) => paginatePosts(data, postPageSchema.parse({ page })));
  expect(pages.map((p) => p.posts.length)).toEqual([24, 24, 6]);
  expect(new Set(pages.flatMap((p) => p.posts.map((r) => r.id))).size).toBe(54);
  expect(pages.map((p) => p.total)).toEqual([54, 54, 54]);
  expect(paginatePosts(data, postPageSchema.parse({ page: 999 })).page).toBe(3);
  for (const size of [12, 24, 48])
    expect(paginatePosts(data, postPageSchema.parse({ pageSize: size })).posts).toHaveLength(size);
  expect(() => postPageSchema.parse({ pageSize: 1000 })).toThrow();
  expect(paginatePosts(data, postPageSchema.parse({ campaign: data.campaigns[0].id })).total).toBe(
    5
  );
  expect(paginatePosts(data, postPageSchema.parse({ search: 'First creator' })).total).toBe(54);
  expect(paginatePosts(data, postPageSchema.parse({ search: 'Video 00' })).total).toBe(1);
  expect(paginatePosts(data, postPageSchema.parse({ search: '%' })).total).toBe(0);
  expect(paginatePosts(data, postPageSchema.parse({ sort: 'views' })).posts[0].caption).toBe(
    'Video 53'
  );
});
it('groups 49 late-discovered imports as historical without assigning a compensation window', () => {
  const data = paginationFixture(),
    account = data.accounts.find((a) => a.platform === 'instagram')!;
  const groups = groupReviews(data, 'all', clock.toISOString());
  expect(groups.find((g) => g.accountId === account.id)).toMatchObject({
    cause: 'historical',
    count: 49,
  });
  expect(groups.filter((g) => g.accountId === account.id)).toHaveLength(1);
  expect(
    groupReviews(data, data.apps[0].id, clock.toISOString()).some((g) => g.accountId === account.id)
  ).toBe(false);
  expect(groups.find((g) => g.accountId !== account.id)?.cause).toBe('historical');
  expect(data.posts.filter((p) => !p.campaign_id).every((p) => p.eligible_views === null)).toBe(
    true
  );
});
it('only sends recent cards and server totals to the browser, preserving full-data finance', () => {
  const data = paginationFixture(),
    before = structuredClone(data),
    view = browserDashboard(data);
  expect(view.posts).toHaveLength(3);
  expect(view.snapshots.length).toBeLessThanOrEqual(3);
  expect(view.readModel?.overview.all.report.postCount).toBe(54);
  expect(view.readModel?.groups.find((g) => g.cause === 'historical')?.count).toBe(49);
  expect(data).toEqual(before);
  const finance = populatedDocument(),
    projected = browserDashboard(finance),
    s = finance.statements[0];
  expect(projected.readModel?.statementResults[s.id].provisional.payableCents).toBe(
    calculateProvisional(finance, s.app_id, s.creator_id, s.month, s.policy).payableCents
  );
  expect(projected.statements[0].fingerprint).toBe('');
  expect(finance.statements[0].fingerprint).not.toBe('');
});
it('requires explicit company routing consent and never retroattributes imported posts', () => {
  const data = paginationFixture(),
    account = data.accounts.find((a) => a.platform === 'instagram')!;
  const command = {
    type: 'mapAccount',
    accountId: account.id,
    membershipId: data.memberships[0].id,
    startsAt: clock.toISOString(),
  };
  expect(() => runCommand(data, command, 'admin', clock)).toThrow(/confirm/);
  const routed = runCommand(data, { ...command, confirmCompanyCompensation: true }, 'admin', clock);
  expect(routed.mappings).toHaveLength(data.mappings.length + 1);
  expect(routed.posts).toEqual(data.posts);
  expect(routed.snapshots).toEqual(data.snapshots);
  expect(routed.statements).toEqual(data.statements);
});
it('explicit exclusion retains sources and is atomic, refuses attributed/paid records', () => {
  const data = paginationFixture(),
    ids = data.posts.filter((p) => !p.campaign_id).map((p) => p.id);
  const command = {
    type: 'excludeUnattributedPosts',
    postIds: ids,
    note: 'Confirmed brand test content, exclude from program',
  };
  const next = runCommand(data, command, 'admin', clock);
  expect(
    next.posts
      .filter((p) => !p.campaign_id)
      .every((p) => p.eligibility_status === 'excluded' && p.eligible_views === 0)
  ).toBe(true);
  expect(next.snapshots).toEqual(data.snapshots);
  expect(next.mappings).toEqual(data.mappings);
  expect(groupReviews(next, 'all', clock.toISOString()).some((g) => g.cause === 'mapping')).toBe(
    false
  );
  expect(() =>
    runCommand(data, { ...command, postIds: [ids[0], data.posts[53].id] }, 'admin', clock)
  ).toThrow();
  expect(data.posts[0].eligibility_status).not.toBe('excluded');
  const paid = populatedDocument(),
    original = structuredClone(paid);
  expect(() =>
    runCommand(paid, { ...command, postIds: [paid.posts[0].id] }, 'admin', clock)
  ).toThrow();
  expect(paid).toEqual(original);
});
