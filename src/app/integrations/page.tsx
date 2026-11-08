import Link from 'next/link';
export default function Integrations() {
  return (
    <main className="access-page">
      <section className="access-card">
        <h1>Creator Ledger connections</h1>
        <p>
          Creator Ledger is a private company tool for managing creator partnerships, campaign
          performance and compensation.
        </p>
        <p>
          A creator can authorize read-only YouTube, Instagram or Facebook access using an expiring
          invitation from the administrator. Authorization permits discovery and analytics
          collection for the registered account. It does not create a dashboard login, publish posts
          or initiate payments.
        </p>
        <p>
          Creator Ledger uses YouTube API Services. Google and Meta handle account sign-in; your
          password is never sent to Creator Ledger.
        </p>
        <p>
          <Link href="/integrations/privacy">Privacy and data use</Link> ·{' '}
          <Link href="/integrations/delete-data">Disconnect or request data deletion</Link> ·{' '}
          <Link href="/">Administrator sign-in</Link>
        </p>
      </section>
    </main>
  );
}
