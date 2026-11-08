import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default function Privacy() {
  const contact = process.env.PUBLIC_SUPPORT_EMAIL;
  return (
    <main className="access-page">
      <section className="access-card">
        <h1>Creator connection privacy</h1>
        <p>
          Creator Ledger collects authorized account identifiers, published-video metadata, view
          counters and available analytics to administer creator partnerships. Public, advertising
          and uncertain metrics remain distinguishable. Reports and compensation decisions are
          visible only to the authorized company administrator.
        </p>
        <p>
          OAuth credentials are encrypted in the private database and used server-side. They are not
          included in the dashboard or shared with other creators. Hosting and database processing
          use Netlify and Supabase. TikTok uses the separate Zernio integration; the direct YouTube
          and Meta connections do not use Zernio.
        </p>
        <p>
          Direct-provider source data is retained for at most 90 days from publication.
          Authorization and stored-source availability are checked approximately daily, including
          after tracking closes. Source data is erased if required checks cannot be renewed within
          29 days. Disconnecting or using your private deletion link removes stored source data
          immediately and queues provider-grant revocation. Meta also supports signed
          deletion/deauthorization callbacks. Erased details include video metadata, views, evidence
          and their copies in compensation records. Settled company payment amounts/status and
          company-entered contractual records remain under the company’s accounting retention
          policy; they do not retain API source counts or identifiers. A minimal receipt expires
          after 30 days; a revocation retry credential is erased within 24 hours.
        </p>
        <p>
          You can revoke Google access at{' '}
          <a href="https://myaccount.google.com/permissions">Google account permissions</a> or Meta
          access in your account’s app/business integrations settings. See{' '}
          <a href="https://policies.google.com/privacy">Google Privacy Policy</a> and{' '}
          <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.
        </p>
        <p>
          {contact ? (
            <a href={`mailto:${contact}`}>Contact the administrator: {contact}</a>
          ) : (
            'External creator onboarding is not ready until the administrator publishes a support contact and verifies the operational retention/deletion process.'
          )}
        </p>
        <p>
          <Link href="/integrations/delete-data">Data deletion instructions</Link> ·{' '}
          <Link href="/integrations">Connection information</Link>
        </p>
      </section>
    </main>
  );
}
