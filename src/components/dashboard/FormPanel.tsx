'use client';
import { Input, Select, Textarea } from '@/components/ui/controls';
import { AsyncButton } from './AsyncButton';
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
        if (busy) return;
        setError('');
        setBusy(true);
        try {
          const values = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<
            string,
            string
          >;
          const missing = fields.find((f) => f.required !== false && !values[f.name]?.trim());
          if (missing) throw new Error(`${missing.label} is required.`);
          await onSubmit(values);
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
            <Select name={f.name} defaultValue={f.value} required={f.required !== false}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : f.type === 'textarea' ? (
            <Textarea
              name={f.name}
              defaultValue={f.value}
              required={f.required !== false}
              rows={4}
              maxLength={f.name === 'notes' ? 2000 : undefined}
            />
          ) : (
            <Input
              name={f.name}
              maxLength={f.name === 'name' ? 100 : undefined}
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
        <AsyncButton className="button primary" disabled={busy} busy={busy}>
          {submitLabel}
        </AsyncButton>
      </div>
    </form>
  );
}
