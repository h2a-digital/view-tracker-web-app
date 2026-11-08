'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
export function Drawer({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content className="drawer-content">
          <div className="drawer-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || 'Changes are validated before they are saved.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close panel">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'purple' | 'red';
}) {
  return (
    <span className={`badge badge-${tone}`}>
      <span />
      {children}
    </span>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">
        <ArrowUpRight size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Money({ cents }: { cents: number }) {
  return (
    <>
      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)}
    </>
  );
}
export function number(value: number) {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}
export function date(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/New_York',
  }).format(new Date(value));
}
export function Avatar({ name, color = '#a99cf4' }: { name: string; color?: string }) {
  return (
    <span className="avatar" style={{ background: `${color}18`, color }}>
      {name
        .split(' ')
        .slice(0, 2)
        .map((n) => n[0])
        .join('')}
    </span>
  );
}
