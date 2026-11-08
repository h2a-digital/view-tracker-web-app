import { NextResponse } from 'next/server';
import { z } from 'zod';
import { configuration, isConfigured } from '@/lib/server/config';
import { requireAdmin, requireSameOrigin, sessionClient } from '@/lib/server/supabase';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!isConfigured()) throw new Error('Complete Supabase setup first.');
    const { email, password } = z
      .object({ email: z.email(), password: z.string().min(8).max(200) })
      .parse(await request.json());
    if (email.toLowerCase() !== configuration().adminEmail)
      throw new Error('Invalid administrator credentials.');
    const client = await sessionClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Invalid administrator credentials.');
    try {
      await requireAdmin();
    } catch {
      await client.auth.signOut();
      throw new Error('Invalid administrator credentials.');
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sign-in failed.' },
      { status: 400 }
    );
  }
}
export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const client = await sessionClient();
    await client.auth.signOut();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Sign-out failed.' }, { status: 400 });
  }
}
