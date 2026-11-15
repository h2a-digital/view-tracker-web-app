import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CurrentAppRules } from '@/components/dashboard/CurrentAppRules';
import { RulesEditor } from '@/components/dashboard/RulesEditor';
import { runCommand } from '@/domain/commands';
import { initialSetupFixture, initialCommand } from './helpers/initial-setup';
it('shows active CPM instead of a later scheduled version, immediately reflecting confirmed activation', () => {
  const data = initialSetupFixture();
  const render = (versions: typeof data.ruleVersions, asOf: string) =>
    renderToStaticMarkup(<CurrentAppRules app={data.apps[0]} versions={versions} asOf={asOf} />);
  const before = render(data.ruleVersions, '2026-11-13T20:59:59.999Z');
  expect(before).toContain('Active now');
  expect(before).toContain('$1.50 CPM');
  expect(before).not.toContain('$1.00 CPM');
  const next = runCommand(
    data,
    initialCommand(data),
    'Administrator',
    new Date('2026-11-13T21:00:00Z')
  );
  const after = render(next.ruleVersions, '2026-11-13T21:00:00.000Z');
  expect(after).toContain('$1.00 CPM');
  expect(after).not.toContain('$1.50 CPM');
  expect(after).toContain('$10');
  expect(after).toContain('7-day window');
  expect(after).toContain('3000');
  expect(after).toContain('Bonus approval required');
  expect(after).toContain('Active as of');
});
it('keeps scheduled activation as the default and explains the server-side setup check', () => {
  const data = initialSetupFixture();
  const html = renderToStaticMarkup(
    <RulesEditor data={data} defaultAppId={data.apps[0].id} onSave={async () => {}} />
  );
  expect(html).toContain('Scheduled rule version');
  expect(html).toContain('Activation');
  expect(html).toContain('zero-value, unapproved drafts');
  expect(html).toContain('Save new rule version');
  expect(html).not.toContain('Activate initial CPM rates now');
});

it('initializes the form with active values even when the December version changes nested settings', () => {
  const data = initialSetupFixture();
  data.ruleVersions.at(-1)!.patch.fixedPayments = [
    { platform: 'tiktok', amount: '20', minimumViews: 2000 },
  ];
  data.ruleVersions.at(-1)!.patch.monthlyCap = '4000';
  const html = renderToStaticMarkup(
    <RulesEditor data={data} defaultAppId={data.apps[0].id} onSave={async () => {}} />
  );
  expect(html).toMatch(/aria-label="Tier 1 rate"[^>]*value="1.50"/);
  expect(html).toMatch(/aria-label="Monthly cap in USD"[^>]*value="3000"/);
  expect(html).not.toContain('value="20"');
  expect(html).not.toContain('value="4000"');
});
