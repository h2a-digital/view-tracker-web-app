import { it, expect } from 'vitest';
import { initialRatePatch } from '@/domain/initial-rate-patch';
import { activeEditorPatch } from '@/domain/rule-editor';
import { verselRules, type RulePatch, type Rules } from '@/domain/model';
import { commandSchema } from '@/domain/validation';
import { initialSetupFixture, initialCommand } from './helpers/initial-setup';
import { runCommand } from '@/domain/commands';
const tiers = [
  { upTo: 100000, cpm: '1.00' },
  { upTo: 500000, cpm: '0.50' },
  { upTo: null, cpm: '0.25' },
];
it('accepts the exact PostgreSQL fixed-payment key order after request parsing, preserving active non-rate values', () => {
  const active: Rules = {
    ...structuredClone(verselRules),
    fixedPayments: [JSON.parse('{"amount":"10","platform":"tiktok","minimumViews":1000}')],
  };
  const data = initialSetupFixture(),
    command = commandSchema.parse({ ...initialCommand(data), patch: { ...active, tiers } });
  if (command.type !== 'saveRules') throw new Error('Expected rule command');
  expect(Object.keys(active.fixedPayments[0])).toEqual(['amount', 'platform', 'minimumViews']);
  expect(Object.keys(command.patch.fixedPayments![0])).toEqual([
    'platform',
    'amount',
    'minimumViews',
  ]);
  const before = structuredClone(active),
    next = initialRatePatch(active, command.patch);
  expect(next.tiers).toEqual(tiers);
  expect({ ...next, tiers: active.tiers }).toEqual(active);
  expect(next.fixedPayments).toBe(active.fixedPayments);
  expect(active).toEqual(before);
});
it('accepts harmless money formatting and platform ordering but preserves the actual active representations', () => {
  const active = structuredClone(verselRules);
  const next = initialRatePatch(active, {
    tiers,
    monthlyCap: '3000.00',
    flatCpm: '1.500000',
    bonusPlatforms: ['youtube', 'instagram', 'tiktok'],
    fixedPayments: [{ minimumViews: 1000, amount: '10.00', platform: 'tiktok' }],
  });
  expect(next.monthlyCap).toBe('3000');
  expect(next.flatCpm).toBe('1.50');
  expect(next.fixedPayments).toEqual(active.fixedPayments);
  expect(next.bonusPlatforms).toEqual(active.bonusPlatforms);
});
it.each<[RulePatch, string]>([
  [
    { fixedPayments: [{ platform: 'tiktok', amount: '20', minimumViews: 1000 }] },
    'fixedPayments[tiktok].amount',
  ],
  [
    { fixedPayments: [{ platform: 'tiktok', amount: '10', minimumViews: 999 }] },
    'fixedPayments[tiktok].minimumViews',
  ],
  [{ fixedPayments: [] }, 'fixedPayments[tiktok]'],
  [
    {
      fixedPayments: [
        ...verselRules.fixedPayments,
        { platform: 'instagram', amount: '10', minimumViews: 1000 },
      ],
    },
    'fixedPayments[instagram]',
  ],
  [{ windowDays: 14 }, 'windowDays'],
  [{ bonusPlatforms: ['tiktok'] }, 'bonusPlatforms'],
  [{ monthlyCap: null }, 'monthlyCap'],
  [{ monthlyCap: '0' }, 'monthlyCap'],
  [{ bonusApproval: false }, 'bonusApproval'],
  [{ flatCpm: '1.00' }, 'flatCpm'],
  [{ cpmMode: 'flat' }, 'cpmMode'],
  [{ tiers: [{ upTo: 100001, cpm: '1.00' }, tiers[1], tiers[2]] }, 'tiers[0].upTo'],
  [
    { tiers: [tiers[0], { upTo: 500000, cpm: '0.50' }, { upTo: 1000000, cpm: '0.25' }] },
    'tiers[2].upTo',
  ],
  [{ tiers: [tiers[2]] }, 'tiers.length'],
])('identifies the conflicting path %s -> %s', (patch, field) => {
  expect(() => initialRatePatch(verselRules, { tiers, ...patch })).toThrow(field);
});
it('reports all conflicts with their active and submitted values', () => {
  expect(() =>
    initialRatePatch(verselRules, { tiers, windowDays: 14, monthlyCap: null, bonusApproval: false })
  ).toThrow(
    'windowDays (active: 7; submitted: 14); monthlyCap (active: "3000"; submitted: null); bonusApproval (active: true; submitted: false)'
  );
});
it('inherits missing settings rather than treating undefined as a default or null; formatting alone is not a rate change', () => {
  expect(initialRatePatch(verselRules, { tiers, monthlyCap: undefined }).monthlyCap).toBe('3000');
  expect(initialRatePatch({ ...verselRules, monthlyCap: null }, { tiers }).monthlyCap).toBeNull();
  expect(() =>
    initialRatePatch(verselRules, {
      tiers: verselRules.tiers.map((t) => ({ ...t, cpm: `${t.cpm}000` })),
    })
  ).toThrow('No CPM rate differs');
});
it('loads active settings, not scheduled changes, including when entering initial activation', () => {
  const data = initialSetupFixture(),
    future = data.ruleVersions.at(-1)!;
  future.patch = {
    ...future.patch,
    monthlyCap: '4000',
    windowDays: 14,
    fixedPayments: [{ platform: 'tiktok', amount: '20', minimumViews: 2000 }],
  };
  const active = activeEditorPatch(
    data,
    'app',
    data.apps[0].id,
    '',
    '',
    '2026-11-15T12:00:00.000Z'
  );
  expect(active).toEqual(verselRules); // $1.50 active, $1.00 scheduled.
  active.tiers![0].cpm = '1.00';
  const next = runCommand(
    data,
    { ...initialCommand(data), patch: active },
    'Administrator',
    new Date('2026-11-15T12:00:00Z')
  );
  expect(next.ruleVersions.at(-1)!.patch.fixedPayments).toEqual(verselRules.fixedPayments);
  expect(next.ruleVersions.at(-1)!.patch.monthlyCap).toBe('3000');
  expect(next.ruleVersions.at(-1)!.patch.tiers![0].cpm).toBe('1.00');
  expect(future.patch.fixedPayments![0].amount).toBe('20');
});
