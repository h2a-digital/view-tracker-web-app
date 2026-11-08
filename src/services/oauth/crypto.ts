import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const nonce = () => randomBytes(32).toString('hex');
function key() {
  const value = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}
export function seal(value: unknown, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}
export function unseal<T>(value: string, context: string): T {
  const [version, iv, tag, data, ...extra] = value.split('.');
  if (version !== 'v1' || extra.length || !iv || !tag || !data)
    throw new Error('Invalid encrypted OAuth material.');
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8')
  );
}
