import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default function DeleteData() {
  const contact = process.env.PUBLIC_SUPPORT_EMAIL;
  return (
    <main className="access-page">
      <section className="access-card">
        <h1>Disconnect or request data deletion</h1>
        <p>
          To stop future access immediately, revoke Creator Ledger in your Google account
          permissions or Meta app/business integration settings. You can also ask the company
          administrator to disconnect and delete your source data. This also queues provider-side
          revocation. Shared provider grants may affect multiple connected accounts.
        </p>
        <p>
          Use the private deletion link shown after connecting (valid for 90 days), or ask the
          administrator for a fresh Creator deletion link. It requires explicit confirmation and no
          dashboard login. Local source deletion completes immediately; remote revocation retries
          independently. This does not erase your original social-platform content. To request
          assistance by email, identify the platform and account handle or channel/Page ID. Do not
          send passwords, tokens or API keys. Deletion from Creator Ledger does not delete videos or
          data on the social platform. The administrator must process applicable YouTube data
          deletion requests within seven calendar days and comply with the relevant platform
          requirements.
        </p>
        <p>
          {contact ? (
            <a href={`mailto:${contact}?subject=Creator%20Ledger%20data%20deletion`}>
              Send a deletion request to {contact}
            </a>
          ) : (
            'A verified administrator contact and operational deletion procedure must be configured before external creator onboarding.'
          )}
        </p>
        <p>
          <Link href="/integrations/privacy">Privacy and data use</Link>
        </p>
      </section>
    </main>
  );
}
