import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialSetupFixture, initialCommand } from './helpers/initial-setup';
import { runCommand } from '@/domain/commands';
import { resolveRules } from '@/domain/compensation';
import { initialSetupStatus } from '@/domain/initial-setup-rules';
import { browserDashboard } from '@/domain/read-model';
import { populatedDocument } from './helpers/dashboard';
import type { DashboardData } from '@/domain/model';
const now = new Date('2026-11-13T21:00:00Z');
afterEach(() => vi.useRealTimers());
it('activates at authoritative server time, keeps every version and aligns only unearned current-month test policies', () => {
  const data = initialSetupFixture(),
    before = structuredClone(data);
  expect(initialSetupStatus(data, data.apps[0].id, now.toISOString())).toMatchObject({
    allowed: true,
    postCount: 1,
    draftCount: 1,
  });
  const next = runCommand(data, initialCommand(data), 'Setup administrator', now),
    version = next.ruleVersions.at(-1)!;
  expect(version.effective_at).toBe(now.toISOString());
  expect(version.created_at).toBe(now.toISOString());
  expect(version.patch.tiers?.[0].cpm).toBe('1.00');
  expect(next.ruleVersions.slice(0, -1)).toEqual(before.ruleVersions); // December schedule and old $1.50 remain.
  expect(
    resolveRules(next.ruleVersions, data.apps[0].id, '', '', '2026-11-13T20:59:59.999Z').rules
      .tiers[0].cpm
  ).toBe('1.50');
  expect(
    resolveRules(next.ruleVersions, data.apps[0].id, '', '', now.toISOString()).rules.tiers[0].cpm
  ).toBe('1.00');
  expect(next.posts[0]).toEqual(before.posts[0]);
  const current = next.posts[1],
    original = before.posts[1];
  expect(current.rules!.tiers[0].cpm).toBe('1.00');
  expect({
    ...current,
    rules: original.rules,
    rule_version_ids: original.rule_version_ids,
  }).toEqual(original);
  expect(current.rule_version_ids).toEqual([...original.rule_version_ids, version.id]);
  expect(next.snapshots).toEqual(before.snapshots);
  expect(next.mappings).toEqual(before.mappings);
  expect(next.statements[0]).toEqual(before.statements[0]);
  expect(next.statements[1]).toMatchObject({
    status: 'draft',
    payable_cents: 0,
    potential_bonus_cents: 0,
    approved_bonus_cents: null,
  });
  expect(next.statements[1].policy.tiers[0].cpm).toBe('1.00');
  expect(next.audit[0].detail).toContain('initial-setup CPM rates');
  expect(data).toEqual(before);
  // Discovery later in this month must not hit the mixed-month policy guard.
  expect(() =>
    runCommand(
      next,
      {
        type: 'addPost',
        input: {
          accountId: next.accounts[0].id,
          campaignId: next.campaigns[0].id,
          platformPostId: '10002',
          url: 'https://instagram.com/reel/Test2',
          publishedAt: '2026-11-13T21:05:00Z',
        },
      },
      'Worker',
      new Date('2026-11-13T22:00:00Z')
    )
  ).not.toThrow();
});
it('prevents bypassing normal monthly guards by copying a scheduled future patch', () => {
  const data = initialSetupFixture(),
    command = initialCommand(data);
  expect(() =>
    runCommand(
      data,
      { ...command, activation: 'scheduled', effectiveAt: '2026-11-13T22:00:00Z' },
      'Administrator',
      now
    )
  ).toThrow(/next month/);
  expect(() =>
    runCommand(
      data,
      { ...command, activation: 'scheduled', effectiveAt: '2026-12-15T00:00:00Z' },
      'Administrator',
      now
    )
  ).toThrow(/first day/);
  expect(() =>
    runCommand(data, { ...command, activation: 'scheduled' }, 'Administrator', now)
  ).toThrow(/backdated/);
});
describe('fail-closed financial guards', () => {
  it.each([
    [
      'accepted eligibility',
      (d: DashboardData) => {
        d.posts[1].eligibility_status = 'accepted';
        d.posts[1].eligible_views = 0;
      },
    ],
    [
      'eligible views',
      (d: DashboardData) => {
        d.posts[1].eligible_views = 1;
      },
    ],
    [
      'creator-owned account',
      (d: DashboardData) => {
        d.accounts[0].ownership = 'creator';
      },
    ],
    [
      'organic evidence',
      (d: DashboardData) => {
        d.snapshots[0].metric = 'organic_views';
      },
    ],
    [
      'earned base',
      (d: DashboardData) => {
        d.statements[0].base_cents = 1000;
      },
    ],
    [
      'earned bonus',
      (d: DashboardData) => {
        d.statements[0].potential_bonus_cents = 100;
      },
    ],
    [
      'zero bonus approved',
      (d: DashboardData) => {
        d.statements[0].approved_bonus_cents = 0;
      },
    ],
    [
      'finalized month',
      (d: DashboardData) => {
        d.statements[0].status = 'finalized';
      },
    ],
    [
      'paid month',
      (d: DashboardData) => {
        d.statements[0].status = 'paid';
      },
    ],
    [
      'campaign override',
      (d: DashboardData) => {
        d.ruleVersions.push({
          ...d.ruleVersions[0],
          id: crypto.randomUUID(),
          scope: 'campaign',
          campaign_id: d.campaigns[0].id,
        });
      },
    ],
    [
      'redacted source',
      (d: DashboardData) => {
        d.posts[1].source_erased_at = now.toISOString();
      },
    ],
  ] as const)('refuses %s without changing any record', (_label, change) => {
    const data = initialSetupFixture();
    change(data);
    const before = structuredClone(data);
    expect(initialSetupStatus(data, data.apps[0].id, now.toISOString()).allowed).toBe(false);
    expect(() => runCommand(data, initialCommand(data), 'Administrator', now)).toThrow();
    expect(data).toEqual(before);
  });
  it('preserves established paid and adjustment ledgers', () => {
    const data = populatedDocument(),
      before = structuredClone(data);
    expect(() => runCommand(data, initialCommand(data), 'Administrator', now)).toThrow();
    expect(data).toEqual(before);
  });
});
it.each([
  { fixedPayments: [{ platform: 'tiktok', amount: '20', minimumViews: 1000 }] },
  { windowDays: 14 },
  { monthlyCap: '4000' },
  { bonusApproval: false },
  { bonusPlatforms: ['instagram'] },
  { cpmMode: 'flat' },
  {
    tiers: [
      { upTo: 200000, cpm: '1.00' },
      { upTo: 500000, cpm: '0.50' },
      { upTo: null, cpm: '0.25' },
    ],
  },
])('rejects non-rate changes: %j', (extra) => {
  const data = initialSetupFixture(),
    command = initialCommand(data);
  expect(() =>
    runCommand(data, { ...command, patch: { ...command.patch, ...extra } }, 'Administrator', now)
  ).toThrow(/rates only/);
});
it('calculates eligibility from the complete server workspace rather than recent browser rows', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const data = initialSetupFixture();
  expect(browserDashboard(data).readModel!.initialSetup[data.apps[0].id].allowed).toBe(true);
  for (let index = 0; index < 3; index++)
    data.posts.push({
      ...structuredClone(data.posts[1]),
      id: crypto.randomUUID(),
      platform_post_id: `other-${index}`,
      app_id: null,
      campaign_id: null,
      rules: null,
      deadline: null,
      published_at: '2026-11-12T12:00:00.000Z',
    });
  expect(browserDashboard(data).posts.some((post) => post.id === data.posts[0].id)).toBe(false);
  data.posts[0].eligible_views = 1;
  expect(browserDashboard(data).readModel!.initialSetup[data.apps[0].id].allowed).toBe(false);
});

it.each([
  [100000, 10000],
  [500000, 30000],
  [600000, 32500],
  [1000000, 42500],
])('uses the activated rates for %i combined views -> %i bonus cents', async (views, cents) => {
  const { cpmBonusCents } = await import('@/domain/compensation');
  const data = initialSetupFixture(),
    next = runCommand(data, initialCommand(data), 'Administrator', now);
  const rules = resolveRules(next.ruleVersions, data.apps[0].id, '', '', now.toISOString()).rules;
  expect(cpmBonusCents(views, rules)).toBe(cents);
  expect(rules.fixedPayments).toEqual([{ platform: 'tiktok', amount: '10', minimumViews: 1000 }]);
  expect(rules).toMatchObject({
    windowDays: 7,
    monthlyCap: '3000',
    bonusApproval: true,
    bonusPlatforms: ['tiktok', 'instagram', 'youtube'],
  });
});
