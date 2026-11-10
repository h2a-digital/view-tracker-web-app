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
          A creator can authorize YouTube, Instagram or Facebook performance tracking using an
          expiring invitation from the administrator. Authorization permits discovery and analytics
          collection for the registered account. It does not create a dashboard login, publish posts
          or initiate payments.
        </p>
        <p>
          Instagram can also connect through Zernio when the administrator enables the pilot. This
          requires a Professional Creator or Business account; direct Instagram Login does not
          require a Facebook Page. Zernio manages the platform authorization and may request
          publishing, comments or messaging permissions alongside analytics. Creator Ledger does not
          use those permissions to publish or access messages. Zernio-held data is subject to its
          own policies; contact the administrator to disconnect and request deletion.
        </p>
        <p>
          Direct Instagram connections use Meta Unified Login with a Professional Creator or
          Business account. A Facebook profile or linked Facebook Page is not required. Switch a
          personal Instagram account to Professional before accepting an invitation. Select the
          business portfolio that owns your account during login. Meta requires a messaging
          permission in this configuration; Creator Ledger does not read, send, subscribe to or
          store messages. Existing Instagram connections made through Facebook keep their original
          linked-Page requirements. Facebook connections separately require a Page and a legitimate
          Facebook profile with Page analytics access; personal-profile Reels are not supported.
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
