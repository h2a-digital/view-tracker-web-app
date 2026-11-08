import 'server-only';
import { NextResponse } from 'next/server';
import { oauthFormSecurity } from '@/lib/oauth-form-security';
import type { DirectPlatform, InstagramAuthMode } from './config';
/** Inputs are a validated platform enum and a 64-character hexadecimal invitation. */
export function consentPage(
  platform: DirectPlatform,
  ticket: string,
  mode: InstagramAuthMode = 'unified_login'
) {
  const unified = platform === 'instagram' && mode === 'unified_login';
  const name = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' }[platform];
  return new NextResponse(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>Connect ${name} · Creator Ledger</title>
<style>
:root{color-scheme:dark;font-family:Arial,Helvetica,sans-serif;color:#eceef4;background:#111318}
*{box-sizing:border-box}body{margin:0;line-height:1.6;font-size:14px}
main{min-height:100vh;display:grid;place-items:center;padding:40px 20px}
.card{width:100%;max-width:580px;background:#191c23;border:1px solid #2b2f39;border-radius:20px;padding:36px;box-shadow:0 24px 70px #0003}
.brand{display:flex;gap:10px;align-items:center;font-size:15px;font-weight:700;margin-bottom:32px;letter-spacing:-.3px}
.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:#b6a4fc;color:#191c23;font-size:17px}
.badge{display:inline-block;color:#7dd4b3;border:1px solid #7dd4b340;background:#7dd4b30d;border-radius:20px;padding:3px 10px;font-size:11px;margin-bottom:12px}
h1{font-size:30px;line-height:1.2;letter-spacing:-1px;margin:0 0 16px}p{color:#a5abbb;margin:0 0 18px}
a{color:#c4b5ff;text-underline-offset:3px}a:hover{color:#e1d9ff}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #b6a4fc;outline-offset:4px}
.permissions{padding:16px 18px;margin:22px 0;background:#20232c;border:1px solid #2b2f39;border-radius:12px}
.permissions strong{display:block;font-size:12px;margin-bottom:8px}.permissions ul{padding-left:18px;margin:0;color:#b0b6c5;font-size:13px}.permissions li+li{margin-top:6px}
.terms{font-size:12px;line-height:1.7}.consent{display:flex;align-items:flex-start;gap:12px;padding:18px 0;font-size:13px;color:#d0d4df;cursor:pointer}
input[type=checkbox]{flex-shrink:0;width:18px;height:18px;margin:2px 0 0;accent-color:#b6a4fc}
button{width:100%;border:0;border-radius:10px;background:#b6a4fc;color:#191522;padding:13px 18px;font:inherit;font-weight:700;cursor:pointer;margin-top:8px}button:hover{background:#c4b5ff}
.footer{font-size:11px;color:#9298aa;text-align:center;margin:18px 0 0}
@media(max-width:480px){main{padding:20px 12px}.card{padding:26px 22px;border-radius:16px}h1{font-size:27px}.brand{margin-bottom:26px}}
</style></head><body><main><section class="card" aria-labelledby="connection-title">
<div class="brand"><span class="mark" aria-hidden="true">C</span>Creator Ledger</div>
<span class="badge">${unified ? 'Performance tracking connection' : 'Read-only connection'}</span>
<h1 id="connection-title">Connect your ${name} account</h1>
<p>Authorize Creator Ledger to track your published videos for your creator partnership.</p>
${
  platform === 'instagram'
    ? `<p>${
        mode === 'unified_login'
          ? 'Use your Instagram Professional account (Creator or Business). Sign in with Instagram or Facebook, select the business portfolio that owns your account, and share the registered Instagram account. A linked Facebook Page is not required. Personal accounts must switch to Professional first. The optional ad account is not needed: you can skip it.'
          : mode === 'instagram_login'
            ? 'Use your Instagram Professional account (Creator or Business). Personal accounts must switch to Professional first. No Facebook account or linked Facebook Page is required.'
            : 'This existing connection uses Facebook Login. Use the Facebook profile with analytics access to the Page linked to your Instagram Professional account.'
      }</p>`
    : ''
}
${platform === 'facebook' ? '<p>Connect a Facebook Page using your legitimate Facebook profile with Page analytics access. Personal-profile Reels are not supported.</p>' : ''}
<div class="permissions"><strong>What this connection allows</strong><ul>
<li>Read your account identity, published videos and available analytics.</li>
<li>Share performance with your company administrator for compensation review.</li>
<li>No publishing permissions or access to the administrator dashboard.</li></ul></div>
${unified ? '<p class="terms">Meta requires <strong>instagram_manage_messages</strong> in this login configuration, in addition to <strong>instagram_basic</strong> and <strong>instagram_manage_insights</strong>. The messaging permission can allow message access, but Creator Ledger does not read, send, subscribe to, or store your messages. We use this connection only for account identity, published Reels and performance analytics. No advertising permissions are requested.</p>' : ''}
<p class="terms">Review our <a href="/integrations/privacy">privacy and data-use policy</a> and <a href="/integrations/delete-data">disconnection and deletion instructions</a> before continuing.</p>
${platform === 'youtube' ? '<p class="terms">Creator Ledger uses YouTube API Services. By using this connection you also agree to the <a href="https://www.youtube.com/t/terms" rel="noreferrer">YouTube Terms of Service</a>. Compensation estimates are calculated by your partner company and are not approved or published by Google or YouTube.</p>' : ''}
<form method="post" action="/api/oauth/${platform}/start">
<input type="hidden" name="ticket" value="${ticket}">
<label class="consent"><input type="checkbox" name="consent" value="accepted" required><span>I agree to the privacy policy and authorize this ${unified ? 'connection with the disclosed permissions' : 'read-only connection'} for the stated purpose.</span></label>
<button type="submit">Continue to ${name} <span aria-hidden="true">→</span></button></form>
<p class="footer">You can revoke access or request source-data deletion at any time.</p>
</section></main></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...oauthFormSecurity(platform),
      },
    }
  );
}
