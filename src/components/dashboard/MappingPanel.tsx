'use client';
import { useState } from 'react';
import type { DashboardData } from '@/domain/model';
import type { Command } from '@/domain/validation';
import { instant } from '@/domain/time';
import { Select, Input, Checkbox } from '@/components/ui/controls';
import { AsyncButton } from './AsyncButton';
export function MappingPanel({
  data,
  accountId,
  onSave,
}: {
  data: DashboardData;
  accountId?: string;
  onSave: (command: Command) => Promise<void>;
}) {
  const [selected, setSelected] = useState(
      accountId || data.accounts.find((a) => !a.archived)?.id || ''
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const account = data.accounts.find((a) => a.id === selected),
    assignments = data.memberships.filter(
      (m) =>
        m.creator_id === account?.creator_id &&
        !data.apps.find((a) => a.id === data.campaigns.find((c) => c.id === m.campaign_id)?.app_id)
          ?.archived
    );
  return (
    <form
      className="panel-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          const values = new FormData(event.currentTarget);
          await onSave({
            type: 'mapAccount',
            accountId: selected,
            membershipId: String(values.get('membershipId')),
            startsAt: instant(String(values.get('startsAt'))),
            endsAt: values.get('endsAt') ? instant(String(values.get('endsAt'))) : null,
            confirmCompanyCompensation: confirmed,
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not save route.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="info-box">
        <p>
          A connection grants tracking access. A campaign route controls compensation attribution
          for newly discovered posts published within its effective dates. Existing posts are never
          reassigned by this form.
        </p>
      </div>
      <label className="field">
        <span>Social account</span>
        <Select
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setConfirmed(false);
          }}
        >
          {data.accounts
            .filter((a) => !a.archived)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.platform} · @{a.username}
              </option>
            ))}
        </Select>
      </label>
      <label className="field">
        <span>Creator campaign assignment</span>
        <Select key={selected} name="membershipId" required>
          {assignments.map((m) => (
            <option key={m.id} value={m.id}>
              {data.creators.find((c) => c.id === m.creator_id)?.name} ·{' '}
              {data.campaigns.find((c) => c.id === m.campaign_id)?.name}
            </option>
          ))}
        </Select>
      </label>
      {!assignments.length && (
        <p className="form-error">Assign this creator to a campaign before routing the account.</p>
      )}
      <label className="field">
        <span>Effective from · explicit timezone required</span>
        <Input name="startsAt" required defaultValue={new Date().toISOString()} />
        <small>
          Defaults to now. Choosing an earlier date does not assign previously imported posts.
          Review old records individually.
        </small>
      </label>
      <label className="field">
        <span>Effective until · optional</span>
        <Input name="endsAt" placeholder="ISO 8601 with Z or ±HH:MM" />
      </label>
      {account?.ownership === 'company' && (
        <div className="info-box">
          <div>
            <strong>Company-owned account</strong>
            <p>Do not enable compensation routing for brand-only or test content.</p>
            <label className="inline-check">
              <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              This account participates in this creator campaign; I approve compensation routing.
            </label>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <AsyncButton
          className="button primary"
          busy={busy}
          disabled={!assignments.length || (account?.ownership === 'company' && !confirmed)}
        >
          Save route
        </AsyncButton>
      </div>
    </form>
  );
}
