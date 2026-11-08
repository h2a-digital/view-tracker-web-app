import 'server-only';
import { createHmac } from 'node:crypto';
export function subjectFingerprint(family: 'google' | 'meta', subject: string) {
  const key = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('OAuth encryption key required.');
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`subject:${family}:${subject}`)
    .digest('hex');
}
