import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PostGrid, postPublicViews } from '@/components/dashboard/PostGrid';
import { ConfirmationActions } from '@/components/dashboard/Primitives';
import { demoWorkspace } from '@/domain/demo';
import { cacheThumbnail, usableThumbnail, thumbnailRetentionMs } from '@/domain/post-media';
import { thumbnailBackfillDue } from '@/domain/post-media';
import { trackingState } from '@/domain/tracking';
import { readFileSync } from 'node:fs';
const now = Date.parse('2026-11-10T12:00:00Z');
const image = 'https://i.ytimg.com/vi/verified-id/hqdefault.jpg';
it('uses the same sharp and decorative image layers in compact and regular cards without changing data', () => {
  const data = demoWorkspace(),
    post = data.posts[0];
  post.tracking = trackingState(data, post, new Date(now).toISOString());
  cacheThumbnail(post, image, new Date(now).toISOString());
  const before = structuredClone(data);
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(
      <PostGrid data={data} posts={[post]} compact={compact} now={now} onOpen={() => {}} />
    );
    expect(html.match(/class="post-thumbnail-foreground"/g)).toHaveLength(1);
    expect(html.match(/class="post-thumbnail-background"/g)).toHaveLength(1);
    expect(
      html.match(new RegExp(`src="${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))
    ).toHaveLength(2);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('post-play');
    expect(html).toContain('post-platform');
    expect(html).toContain('View post details:');
  }
  expect(data).toEqual(before);
});
it('contains the full foreground image and blurs only the background within the fixed preview', () => {
  const css = readFileSync('src/styles/globals.css', 'utf8');
  const imageRules = [...css.matchAll(/\.post-thumbnail img\s*\{([^}]+)\}/g)];
  expect(imageRules.length).toBeGreaterThan(0);
  for (const [, declarations] of imageRules) {
    expect(declarations).toContain('object-fit: contain');
    expect(declarations).not.toContain('filter:');
  }
  expect(css).toMatch(
    /\.post-thumbnail img\.post-thumbnail-background\s*\{[^}]*object-fit: cover;[^}]*filter: blur\(16px\) brightness\(0\.55\)/
  );
  expect(css).toMatch(/\.post-thumbnail-foreground\s*\{[^}]*z-index: 1/);
  expect(css).toMatch(/\.post-thumbnail\s*\{[^}]*overflow: hidden/);
});
it('caches only supported HTTPS provider images, rejects credentials, expired signatures and stale/future timestamps', () => {
  const thumbnail = { url: image, capturedAt: new Date(now).toISOString() };
  expect(usableThumbnail(thumbnail, now)).toBe(image);
  expect(usableThumbnail(thumbnail, now + thumbnailRetentionMs)).toBeUndefined();
  expect(usableThumbnail(thumbnail, now - 1)).toBeUndefined();
  for (const url of [
    'http://i.ytimg.com/image',
    'https://evil.example/image',
    `${image}?access_token=secret`,
    'https://cdninstagram.com/image?refresh_token=secret',
    'https://p16.tiktokcdn.com/image?x-expires=1',
  ])
    expect(usableThumbnail({ ...thumbnail, url }, now)).toBeUndefined();
  expect(usableThumbnail({ ...thumbnail, capturedAt: 'not-a-date' }, now)).toBeUndefined();
});
it('preserves valid cached media through missing responses and ordinary tracking-state recalculation without changing eligibility', () => {
  const data = demoWorkspace();
  const post = data.posts[0];
  post.tracking = trackingState(data, post, new Date(now).toISOString());
  const before = {
    rules: post.rules,
    deadline: post.deadline,
    views: post.eligible_views,
    evidence: post.review_evidence,
    status: post.eligibility_status,
  };
  cacheThumbnail(post, image, new Date(now).toISOString());
  cacheThumbnail(
    post,
    'https://i.ytimg.com/vi/different/hqdefault.jpg',
    new Date(now).toISOString()
  );
  cacheThumbnail(post, null, new Date(now).toISOString());
  cacheThumbnail(post, 'https://evil.example/image', new Date(now).toISOString());
  post.tracking = trackingState(data, post, new Date(now).toISOString());
  expect(post.tracking.thumbnail?.url).toBe(image);
  expect({
    rules: post.rules,
    deadline: post.deadline,
    views: post.eligible_views,
    evidence: post.review_evidence,
    status: post.eligibility_status,
  }).toEqual(before);
  expect(
    trackingState(data, post, new Date(now + thumbnailRetentionMs).toISOString()).thumbnail
  ).toBeUndefined();
});
it('renders real thumbnails lazily, otherwise a platform fallback, with no invented public counters', () => {
  const data = demoWorkspace();
  const post = data.posts[0];
  post.tracking = trackingState(data, post, new Date(now).toISOString());
  cacheThumbnail(post, image, new Date(now).toISOString());
  const render = () =>
    renderToStaticMarkup(<PostGrid data={data} posts={[post]} now={now} onOpen={() => {}} />);
  expect(render()).toContain(image);
  expect(render()).toContain('loading="lazy"');
  expect(render()).toContain('referrerPolicy="no-referrer"');
  data.snapshots = [];
  expect(postPublicViews(data, post)).toBeNull();
  expect(render()).toContain('public views · unverified traffic');
  post.tracking!.thumbnail = {
    url: image,
    capturedAt: new Date(now - thumbnailRetentionMs).toISOString(),
  };
  expect(render()).toContain('Preview unavailable');
  expect(render()).not.toContain('<img');
  post.source_erased_at = new Date(now).toISOString();
  cacheThumbnail(post, image, new Date(now).toISOString());
  expect(render()).toContain('Source removed');
  expect(render()).not.toContain('<img');
});
it('provides a usable empty grid and a consistent confirmation footer with disabled safeguards', () => {
  expect(
    renderToStaticMarkup(<PostGrid data={demoWorkspace()} posts={[]} now={now} onOpen={() => {}} />)
  ).toContain('No posts to show');
  const html = renderToStaticMarkup(
    <ConfirmationActions
      label="Disconnect and delete source data"
      destructive
      disabled
      onCancel={() => {}}
      onConfirm={async () => {}}
    />
  );
  expect(html).toContain('Cancel');
  expect(html).toContain('Disconnect and delete source data');
  expect(html).toContain('disabled');
  expect(html).not.toContain('confirmation-icon');
  expect(html).not.toContain('button-icon-slot');
});

it('recovers cache scheduling from missing, malformed or future attempt timestamps', () => {
  const data = demoWorkspace(),
    post = data.posts[0];
  post.tracking = trackingState(data, post, new Date(now).toISOString());
  for (const timestamp of [undefined, 'bad-time', new Date(now + 1000).toISOString()]) {
    post.tracking.thumbnailCheckedAt = timestamp;
    expect(thumbnailBackfillDue(post, now)).toBe(true);
  }
  post.tracking.thumbnailCheckedAt = new Date(now).toISOString();
  expect(thumbnailBackfillDue(post, now)).toBe(false);
});
