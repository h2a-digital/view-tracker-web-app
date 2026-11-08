import { it, expect } from 'vitest';
import { createTestDatabase } from './helpers/database';
import { populatedDocument } from './helpers/dashboard';
import { instagramAuthMode } from '@/services/oauth/config';
it('round-trips new Instagram mode in schema 5, isolates erasure and preserves legacy grants and TikTok compensation', async () => {
  const db = await createTestDatabase(true, 5);
  try {
    const d = populatedDocument();
    const legacy = {
      ...d.accounts[0],
      id: crypto.randomUUID(),
      platform: 'instagram' as const,
      provider: 'direct' as const,
      username: 'legacy',
      provider_account_id: 'legacy-remote',
      integration: null,
    };
    const direct = {
      ...legacy,
      id: crypto.randomUUID(),
      username: 'direct',
      provider_account_id: 'new-remote',
      integration: { instagramAuthMode: 'instagram_login' as const },
    };
    const unified = {
      ...direct,
      id: crypto.randomUUID(),
      username: 'unified',
      provider_account_id: 'unified-remote',
      integration: { instagramAuthMode: 'unified_login' as const },
    };
    d.accounts.push(legacy, direct, unified);
    const revision = (
      await db.query<{ r: number }>("select (public.read_dashboard()->>'revision')::int r")
    ).rows[0].r;
    await db.query('select public.commit_dashboard($1,$2::jsonb)', [revision, JSON.stringify(d)]);
    const read = async () =>
      (
        await db.query<{ d: { schemaVersion: number; data: typeof d } }>(
          'select public.read_dashboard() d'
        )
      ).rows[0].d;
    const stored = await read();
    expect(stored.schemaVersion).toBe(5);
    expect(instagramAuthMode(stored.data.accounts.find((a) => a.id === direct.id)!)).toBe(
      'instagram_login'
    );
    expect(instagramAuthMode(stored.data.accounts.find((a) => a.id === unified.id)!)).toBe(
      'unified_login'
    );
    expect(instagramAuthMode(stored.data.accounts.find((a) => a.id === legacy.id)!)).toBe(
      'facebook_login'
    );
    await db.query(
      "insert into private.oauth_credentials(account_id,encrypted_token,subject_hash,authorized_at) values($1,$2,$3,now()-interval '1 minute'),($4,$5,$6,now()-interval '1 minute')",
      [legacy.id, 'encrypted-legacy', 'f'.repeat(64), direct.id, 'encrypted-new', 'e'.repeat(64)]
    );
    await db.query('select public.erase_meta_subject($1,now(),$2)', [
      'e'.repeat(64),
      'a'.repeat(64),
    ]);
    expect(
      (
        await db.query(
          'select encrypted_token from private.oauth_credentials where account_id=$1',
          [legacy.id]
        )
      ).rows
    ).toEqual([{ encrypted_token: 'encrypted-legacy' }]);
    expect(
      (await db.query('select * from private.oauth_credentials where account_id=$1', [direct.id]))
        .rows
    ).toHaveLength(0);
    const after = (await read()).data;
    expect(after.accounts.find((a) => a.id === unified.id)).toEqual(
      stored.data.accounts.find((a) => a.id === unified.id)
    );
    expect(after.accounts.find((a) => a.id === d.accounts[0].id)).toEqual(
      stored.data.accounts.find((a) => a.id === d.accounts[0].id)
    );
    expect(after.posts).toEqual(stored.data.posts);
    expect(after.snapshots).toEqual(stored.data.snapshots);
    expect(after.statements).toEqual(stored.data.statements);
    expect(after.ruleVersions).toEqual(stored.data.ruleVersions);
  } finally {
    await db.close();
  }
});
