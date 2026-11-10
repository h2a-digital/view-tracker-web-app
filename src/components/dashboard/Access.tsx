'use client';
import { Input } from '@/components/ui/controls';
import { requestJson } from '@/lib/client/request';
import { AsyncButton } from './AsyncButton';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, Layers } from 'lucide-react';
export function Access({ setup = false, notice = '' }: { setup?: boolean; notice?: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="access-page">
      <div className="access-card">
        <div className="brand">
          <span className="brand-icon">
            <Layers size={23} />
          </span>
          H2A Creator Hub
        </div>
        <span className="eyebrow">YOUR CREATOR OPERATIONS, CONNECTED</span>
        <h1>{setup ? 'A home for every creator.' : 'Welcome back.'}</h1>
        <p>
          {setup
            ? 'Manage your apps, understand performance, and turn verified views into clear payouts.'
            : 'Sign in to your private workspace.'}
        </p>
        {notice && (
          <p className="form-error" role="alert">
            {notice}
          </p>
        )}
        {setup ? (
          <>
            <div className="setup-steps">
              <div>
                <b>01</b>
                <span>Create a free Supabase project and add your administrator.</span>
              </div>
              <div>
                <b>02</b>
                <span>Apply the migration and set server environment variables.</span>
              </div>
              <div>
                <b>03</b>
                <span>Create Zernio’s free account when you’re ready to connect TikTok.</span>
              </div>
            </div>
            <Link href="/?preview=1" className="button primary">
              Explore the local preview <ArrowRight size={17} />
            </Link>
            <small>
              Preview uses sample data and makes no external API calls. Setup instructions are in
              README.md.
            </small>
          </>
        ) : (
          <form
            className="panel-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const fields = new FormData(e.currentTarget);
              try {
                await requestJson('/api/auth', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(Object.fromEntries(fields)),
                });

                router.push('/');
                router.refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Sign-in failed.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              Administrator email
              <Input type="email" name="email" autoComplete="username" required />
            </label>
            <label className="field">
              Password
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                minLength={8}
              />
            </label>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <AsyncButton className="button primary" disabled={busy} busy={busy}>
              Sign in
              <ArrowRight size={16} />
            </AsyncButton>
          </form>
        )}
      </div>
      <div className="access-art">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <div className="art-card">
          <span className="eyebrow">A CLEARER PICTURE</span>
          <h2>
            Great partnerships.
            <br />
            Measurable impact.
          </h2>
          <div className="art-bars">
            {[25, 45, 36, 65, 53, 82, 72, 100].map((h, i) => (
              <span key={i} style={{ height: h + '%' }} />
            ))}
          </div>
          <p>One workspace. Every app. Every creator.</p>
        </div>
      </div>
    </main>
  );
}
