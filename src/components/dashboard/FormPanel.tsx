'use client';
import { useState } from 'react';
export type Field = {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'month' | 'textarea' | 'select' | 'color';
  options?: { value: string; label: string }[];
  value?: string;
  required?: boolean;
  help?: string;
  min?: string;
  step?: string;
};
export function FormPanel({
  fields,
  submitLabel = 'Save changes',
  onSubmit,
}: {
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="panel-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
          await onSubmit(
            Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not save.');
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f) => (
        <label className="field" key={f.name}>
          <span>{f.label}</span>
          {f.type === 'select' ? (
            <select name={f.name} defaultValue={f.value} required={f.required !== false}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea
              name={f.name}
              defaultValue={f.value}
              required={f.required !== false}
              rows={4}
            />
          ) : (
            <input
              name={f.name}
              type={f.type || 'text'}
              defaultValue={f.value}
              required={f.required !== false}
              min={f.min}
              step={f.step}
            />
          )}{' '}
          {f.help && <small>{f.help}</small>}
          {[
            'publishedAt',
            'observedAt',
            'startsAt',
            'endsAt',
            'paidAt',
            'windowStart',
            'windowEnd',
          ].includes(f.name) && (
            <small>
              Enter ISO 8601 with Z (UTC) or an explicit ±HH:MM offset. Example:
              2026-11-08T12:00:00-05:00. Reports display America/New_York.
            </small>
          )}
        </label>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <button className="button primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
