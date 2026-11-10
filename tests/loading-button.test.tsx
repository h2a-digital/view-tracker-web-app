import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { AsyncButton } from '@/components/dashboard/AsyncButton';
it('replaces an icon-only action in the same sized slot and preserves its accessible name', () => {
  const idle = renderToStaticMarkup(
    <AsyncButton aria-label="Refresh workspace">
      <RefreshCw size={17} />
    </AsyncButton>
  );
  const busy = renderToStaticMarkup(
    <AsyncButton aria-label="Refresh workspace" busy>
      <RefreshCw size={17} />
    </AsyncButton>
  );
  expect(idle).toContain('width:17px;height:17px');
  expect(busy).toContain('width:17px;height:17px');
  expect(busy).toContain('aria-busy="true"');
  expect(busy).toContain('disabled');
  expect(busy).toContain('aria-label="Refresh workspace"');
  expect(busy).toContain('class="button-original-icon" style="visibility:hidden"');
  expect(busy.match(/button-loading-icon/g)).toHaveLength(1);
  expect(idle).not.toContain('button-loading-icon');
});
it('keeps labels and trailing-icon placement while hiding action icons during loading', () => {
  const html = renderToStaticMarkup(
    <AsyncButton busy>
      Open account
      <ExternalLink size={14} />
    </AsyncButton>
  );
  expect(html.indexOf('Open account')).toBeLessThan(html.indexOf('button-loading-icon'));
  expect(html).toContain('visibility:hidden');
});
it('renders one spinner for multi-icon buttons and overlays text-only forms without empty idle slots', () => {
  const html = renderToStaticMarkup(
    <AsyncButton busy>
      <RefreshCw size={16} />
      Refresh
      <ExternalLink size={14} />
    </AsyncButton>
  );
  expect(html.match(/button-loading-icon/g)).toHaveLength(1);
  expect(html.match(/visibility:hidden/g)).toHaveLength(2);
  const render = (busy: boolean) =>
    renderToStaticMarkup(
      <AsyncButton className="button" busy={busy}>
        Save
      </AsyncButton>
    );
  expect(render(false)).not.toContain('button-icon-slot');
  expect(render(false)).not.toContain('button-loading-icon');
  expect(render(false)).toContain('Save');
  expect(render(true)).not.toContain('button-icon-slot');
  expect(render(true)).toContain('opacity:0');
  expect(render(true)).toContain('button-loading-icon');
  expect(render(true)).toContain('Save');
});
