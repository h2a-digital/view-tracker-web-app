import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { hostedDeployment, hostedPreview } from '@/lib/server/deployment';
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (
    hostedPreview() ||
    !url ||
    !key ||
    (!hostedDeployment() && request.nextUrl.searchParams.get('preview') === '1')
  )
    return response;
  const client = createServerClient(url, key, {
    cookieOptions: { httpOnly: true, secure: hostedDeployment(), sameSite: 'lax' },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (values) => {
        for (const { name, value } of values) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of values) response.cookies.set(name, value, options);
      },
    },
  });
  await client.auth.getUser();
  return response;
}
export const config = { matcher: ['/'] };
