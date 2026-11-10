import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { paginationFixture } from './helpers/pagination';
import { ReviewGroups } from '@/components/dashboard/ReviewGroups';
import { PagedPosts } from '@/components/dashboard/PagedPosts';
import { postPageSchema } from '@/domain/post-pages';
import { MappingPanel } from '@/components/dashboard/MappingPanel';
import { readFileSync } from 'node:fs';
it('renders one unmapped account issue with count instead of 49 post entries', () => {
  const data = paginationFixture(true);
  const html = renderToStaticMarkup(
    <ReviewGroups
      data={data}
      appId="all"
      onPost={() => {}}
      onRoute={() => {}}
      onExclude={async () => {}}
    />
  );
  expect(html).toContain('@looksup_app');
  expect(html).toContain('49 posts');
  expect(html).toContain('missing campaign attribution');
  expect(html).toContain('Route posts');
  expect(html).not.toContain('View post</button>');
  expect(html).not.toContain('Video 00');
});
it('supports both views with identical bounded totals and accessible page-size controls', () => {
  const data = paginationFixture();
  for (const view of ['grid', 'table'] as const) {
    const html = renderToStaticMarkup(
      <PagedPosts
        data={data}
        query={postPageSchema.parse({})}
        view={view}
        onPage={() => {}}
        onSize={() => {}}
        onOpen={() => {}}
        overrides={[]}
        now={Date.parse('2026-11-10T12:00:00Z')}
      />
    );
    expect(html).toContain('of 54');
    expect(html).toContain('Page 1 of 3');
    expect(html).toContain('Posts per page');
    expect(html).not.toContain('Video 00');
    if (view === 'grid') expect(html.match(/class="post-card"/g) || []).toHaveLength(24);
    else expect(html).toContain('<table');
  }
});
it('requires explicit company compensation routing consent and explains imported post safety', () => {
  const data = paginationFixture(),
    account = data.accounts.find((a) => a.platform === 'instagram')!;
  const html = renderToStaticMarkup(
    <MappingPanel data={data} accountId={account.id} onSave={async () => {}} />
  );
  expect(html).toContain('Company-owned account');
  expect(html).toContain('Existing posts are never');
  expect(html).toContain('disabled');
});
it('uses compact landscape media and four/three/two/one responsive grid breakpoints', () => {
  const css = readFileSync('src/styles/globals.css', 'utf8');
  expect(css).toMatch(/\.post-thumbnail\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10/s);
  expect(css).toMatch(/@media\s*\(min-width: 1550px\)[\s\S]*repeat\(4/);
  expect(css).toMatch(/@media\s*\(max-width: 1100px\)[\s\S]*repeat\(2/);
  expect(css).toMatch(
    /@media\s*\(max-width: 650px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/
  );
});

it('retains old unassigned imports in a collapsed history section without operational alerts', () => {
  const html = renderToStaticMarkup(
    <ReviewGroups
      data={paginationFixture()}
      appId="all"
      onPost={() => {}}
      onRoute={() => {}}
      onExclude={async () => {}}
    />
  );
  expect(html).toContain('0 operational groups');
  expect(html).toContain('No operational post issues');
  expect(html).toContain('Historical records');
  expect(html).toContain('54');
  expect(html).toContain('49 posts');
  expect(html).not.toContain('missing campaign attribution');
  expect(html).toContain('<details class="history-panel">');
  expect(html).not.toMatch(/<details[^>]+\bopen(?:[ =]|>)/);
});
