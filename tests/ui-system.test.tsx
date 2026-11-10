import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select, Input, Textarea, Switch } from '@/components/ui/controls';
import { Analytics } from '@/components/dashboard/Analytics';
import { emptyData } from '@/domain/model';
import { demoWorkspace } from '@/domain/demo';
import { runCommand } from '@/domain/commands';
it('preserves real empty-choice form values and accessible select trigger metadata', () => {
  const html = renderToStaticMarkup(
    <Select name="campaignId" defaultValue="" aria-label="Campaign">
      <option value="">Automatic routing</option>
      <option value="campaign">Versel</option>
    </Select>
  );
  expect(html).toContain('type="hidden" name="campaignId" value=""');
  expect(html).toContain('aria-label="Campaign"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('Automatic routing');
});
it('makes large entity lists searchable and supports nested option fragments', () => {
  const html = renderToStaticMarkup(
    <Select name="creatorId" defaultValue="8" aria-label="Creator">
      <>
        {Array.from({ length: 9 }, (_, i) => (
          <option key={i} value={i}>
            Creator {i}
          </option>
        ))}
      </>
    </Select>
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('Creator 8');
  expect(html).toContain('value="8"');
});
it('standardizes native form controls and accessible Radix toggles', () => {
  expect(renderToStaticMarkup(<Input name="name" required maxLength={100} />)).toContain(
    'maxLength="100"'
  );
  expect(renderToStaticMarkup(<Textarea name="notes" />)).toContain('ui-textarea');
  expect(
    renderToStaticMarkup(<Switch label="Override rule" checked onCheckedChange={() => {}} />)
  ).toContain('role="switch"');
});
it('renders useful empty analytics without inventing performance or conversion data', () => {
  const html = renderToStaticMarkup(<Analytics data={emptyData()} appId="all" />);
  for (const text of [
    'No publications yet',
    'Verified eligible views',
    'not daily view growth',
    'No finalized statements',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('Downloads');
});
it('edits only creator administrative fields while preserving verified identities and historical relationships', () => {
  const d = demoWorkspace();
  const c = d.creators[0];
  const updated = runCommand(d, {
    type: 'updateEntity',
    entity: 'creator',
    id: c.id,
    name: 'Updated name',
    email: 'updated@example.com',
    notes: 'Updated note',
    provider_account_id: 'attempted-override',
  });
  expect(updated.creators[0]).toMatchObject({
    id: c.id,
    name: 'Updated name',
    email: 'updated@example.com',
    notes: 'Updated note',
  });
  for (const key of [
    'accounts',
    'posts',
    'snapshots',
    'memberships',
    'mappings',
    'statements',
  ] as const)
    expect(updated[key]).toEqual(d[key]);
  expect(() =>
    runCommand(d, {
      type: 'updateEntity',
      entity: 'creator',
      id: c.id,
      name: ' ',
      email: 'invalid',
    })
  ).toThrow();
});
