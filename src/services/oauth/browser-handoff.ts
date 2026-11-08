import 'server-only';
import { NextResponse } from 'next/server';

/** Finish the same-origin POST before starting the provider's GET redirect chain.
 * Chrome applies form-action to the entire chain of a form submission, even
 * after a 303. An HTML navigation starts a new, non-form navigation instead.
 */
export function instagramBrowserHandoff(response: Response) {
  const location = response.headers.get('Location');
  if (response.status !== 303 || !location) return response;
  const target = new URL(location);
  const trusted =
    target.protocol === 'https:' &&
    !target.username &&
    !target.password &&
    ((target.origin === 'https://www.facebook.com' &&
      /^\/v\d+\.0\/dialog\/oauth$/.test(target.pathname)) ||
      (target.origin === 'https://www.instagram.com' && target.pathname === '/oauth/authorize'));
  if (!trusted) throw new Error('Invalid Instagram authorization destination.');
  const escaped = target
    .toString()
    .replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
    );
  // Preserve the original HttpOnly/Secure/SameSite cookie and no-store headers.
  // A Location header on the new document is unnecessary and must not redirect it.
  const headers = new Headers(response.headers);
  headers.delete('Location');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta http-equiv="refresh" content="0;url=${escaped}"><title>Continue to Instagram · Creator Ledger</title><style>:root{color-scheme:dark;font-family:Arial,Helvetica,sans-serif;background:#111318;color:#eceef4}body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:480px;margin:24px;padding:32px;background:#191c23;border:1px solid #2b2f39;border-radius:20px}p{color:#a5abbb;line-height:1.6}a{color:#c4b5ff}a:focus-visible{outline:3px solid #b6a4fc;outline-offset:4px}</style></head><body><main><h1>Continue to Instagram</h1><p>Opening Meta’s secure authorization page. If it does not open automatically, use the link below.</p><a href="${escaped}" rel="noreferrer">Continue to Instagram</a></main></body></html>`,
    { status: 200, headers }
  );
}
