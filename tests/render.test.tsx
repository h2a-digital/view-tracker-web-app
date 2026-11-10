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
      'Pending reviews',
      'Top creators',
      'Performance by platform',
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
      'Rule level',
      'Fixed payments',
      'Progressive rates',
      'Monthly cap',
      'Bonus approval policy',
    ])
      expect(html).toContain(s);
  });
});

it('exposes accessible disabled loading controls and skeleton status', async () => {
  const { AsyncButton } = await import('@/components/dashboard/AsyncButton');
  const { default: Loading } = await import('@/app/loading');
  const html = renderToStaticMarkup(
    <AsyncButton busy className="button">
      Save changes
    </AsyncButton>
  );
  expect(html).toContain('disabled');
  expect(html).toContain('aria-busy="true"');
  expect(renderToStaticMarkup(<Loading />)).toContain('role="status"');
});

it('uses circular platform-specific avatar fallbacks without remote image scraping', async () => {
  const { AccountAvatar } = await import('@/components/dashboard/Primitives');
  for (const platform of ['tiktok', 'instagram', 'youtube']) {
    const html = renderToStaticMarkup(<AccountAvatar name="Creator" platform={platform} />);
    expect(html).toContain(`platform-avatar ${platform}`);
    expect(html).not.toContain('<img');
  }
});

it('keeps overview previews searchable without reintroducing tables or technical audit logs', async () => {
  const { Overview } = await import('@/components/dashboard/Overview');
  const data = demoWorkspace();
  const html = renderToStaticMarkup(
    <Overview
      data={data}
      appId="all"
      query="no-matching-publication-xyz"
      now={Date.now()}
      onNavigate={() => {}}
      onOpenPost={() => {}}
    />
  );
  expect(html).toContain('No posts to show');
  expect(html).not.toContain('<table');
  expect(html).not.toContain('createCreator');
  expect(html).not.toContain('updateEntity');
});
