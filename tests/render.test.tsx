import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { Access } from '@/components/dashboard/Access';
import { RulesEditor } from '@/components/dashboard/RulesEditor';
import { demoWorkspace } from '@/domain/demo';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
describe('server-rendered dashboard surfaces', () => {
  it('renders the isolated preview with all navigation and performance rows', () => {
    const html = renderToStaticMarkup(<Dashboard initial={demoWorkspace()} preview />);
    for (const s of [
      'Local preview',
      'Apps &amp; campaigns',
      'Monthly payouts',
      'Social accounts',
      'Verified eligible views',
      'Recent posts',
    ])
      expect(html).toContain(s);
    expect(html).not.toContain('LooksUP');
  });
  it('provides a usable setup page without provider credentials', () => {
    const html = renderToStaticMarkup(<Access setup />);
    expect(html).toContain('Explore the local preview');
    expect(html).toContain('Supabase');
    expect(html).toContain('Zernio');
  });
  it('renders editable rule controls for each configurable payment type', () => {
    const d = demoWorkspace();
    const html = renderToStaticMarkup(
      <RulesEditor data={d} defaultAppId={d.apps[0].id} onSave={async () => {}} />
    );
    for (const s of [
      'Creator · this app',
      'Fixed payments',
      'Progressive rates',
      'Monthly cap',
      'Bonus approval policy',
    ])
      expect(html).toContain(s);
  });
});
