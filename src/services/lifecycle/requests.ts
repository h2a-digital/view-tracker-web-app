import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { adminDatabase, requireSameOrigin } from '@/lib/server/supabase';
import { assertLiveDeployment } from '@/lib/server/deployment';
import { configuration } from '@/lib/server/config';
import { digest, nonce } from '@/services/oauth/crypto';
import { subjectFingerprint } from './identity';
const valid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function verifyMetaRequest(
  value: string,
  family: 'meta' | 'instagram' | 'instagram_unified' = 'meta'
) {
  const secret =
    family === 'instagram'
      ? process.env.INSTAGRAM_APP_SECRET
      : family === 'instagram_unified'
        ? process.env.INSTAGRAM_META_APP_SECRET
        : process.env.META_APP_SECRET;
  if (!secret || value.length > 16000) throw new Error('Invalid signed request.');
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some((s) => !s || !/^[A-Za-z0-9_-]+$/.test(s)))
    throw new Error('Invalid signed request.');
  const expected = createHmac('sha256', secret).update(parts[1]).digest(),
    actual = Buffer.from(parts[0], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Invalid signed request.');
  const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (
    data.algorithm !== 'HMAC-SHA256' ||
    typeof data.user_id !== 'string' ||
    !/^\d{1,128}$/.test(data.user_id) ||
    !Number.isSafeInteger(data.issued_at) ||
    data.issued_at < 0 ||
    data.issued_at > Date.now() / 1000 + 300
  )
    throw new Error('Invalid signed request.');
  return {
    subject: subjectFingerprint(family, data.user_id),
    issuedAt: new Date(data.issued_at * 1000).toISOString(),
  };
}
export async function metaRemoval(
  request: Request,
  family: 'meta' | 'instagram' | 'instagram_unified' = 'meta'
) {
  assertLiveDeployment();
  const raw = await request.text();
  if (raw.length > 20000) throw new Error('Invalid signed request.');
  const signed = new URLSearchParams(raw).get('signed_request');
  if (!signed) throw new Error('Invalid signed request.');
  const verified = verifyMetaRequest(signed, family),
    code = nonce();
  const result = await adminDatabase().rpc('erase_meta_subject', {
    subject_fingerprint: verified.subject,
    issued_at: verified.issuedAt,
    receipt_hash: digest(code),
  });
  if (result.error) throw new Error('Could not complete deletion.');
  return NextResponse.json(
    {
      url: new URL(`/api/privacy/status?code=${code}`, configuration().siteUrl).toString(),
      confirmation_code: code,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
export async function deletionForm(request: Request) {
  assertLiveDeployment();
  const ticket = new URL(request.url).searchParams.get('ticket');
  if (!valid(ticket)) throw new Error('Invalid deletion link.');
  const result = await adminDatabase().rpc('read_deletion_link', { token_hash: digest(ticket) });
  if (result.error || !result.data) throw new Error('Deletion link expired.');
  return new NextResponse(
    `<!doctype html><html><head><title>Delete connected source data</title></head><body><h1>Delete connected source data</h1><p>This removes the connection, stored videos, metrics and evidence from Creator Ledger. It does not delete any content on Google, YouTube, Instagram or Facebook. Revocation may disconnect other accounts using the same provider grant. Settled company payment amounts and company-entered contractual records remain, with API source details erased.</p><form method="post"><input type="hidden" name="ticket" value="${ticket}"><label><input type="checkbox" name="confirm" value="delete" required>Delete my connected source data and revoke access</label><button type="submit">Delete source data</button></form></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'strict-origin',
      },
    }
  );
}
export async function deleteFromLink(request: Request) {
  assertLiveDeployment();
  requireSameOrigin(request);
  const raw = await request.text();
  if (raw.length > 2000) throw new Error('Invalid deletion request.');
  const form = new URLSearchParams(raw),
    ticket = form.get('ticket');
  if (!valid(ticket) || form.get('confirm') !== 'delete') throw new Error('Confirmation required.');
  const code = nonce(),
    result = await adminDatabase().rpc('redeem_deletion_link', {
      token_hash: digest(ticket),
      receipt_hash: digest(code),
    });
  if (result.error) throw new Error('Deletion link expired.');
  return NextResponse.redirect(
    new URL(`/api/privacy/status?code=${code}`, configuration().siteUrl),
    303
  );
}
export async function deletionStatus(request: Request) {
  assertLiveDeployment();
  const code = new URL(request.url).searchParams.get('code');
  if (!valid(code))
    return NextResponse.json({ error: 'Unknown confirmation code' }, { status: 404 });
  const result = await adminDatabase().rpc('read_deletion_receipt', { token_hash: digest(code) });
  if (result.error) throw new Error('Status temporarily unavailable.');
  return NextResponse.json(result.data || { error: 'Unknown or expired confirmation code' }, {
    status: result.data ? 200 : 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}
