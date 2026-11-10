'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ArrowUpRight, Music2, Camera, Clapperboard, Globe } from 'lucide-react';
import { useState, createContext, useContext, type ReactNode } from 'react';
import Image from 'next/image';
import { AsyncButton } from './AsyncButton';
const DialogBusyContext = createContext<(busy: boolean) => void>(() => {});
export function Drawer({
  title,
  description,
  compact = false,
  children,
  onClose,
}: {
  title: string;
  description?: string;
  compact?: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content className={compact ? 'drawer-content compact-dialog' : 'drawer-content'}>
          <div className="drawer-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || 'Changes are validated before they are saved.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close panel" disabled={busy}>
              <X size={20} />
            </Dialog.Close>
          </div>
          <DialogBusyContext.Provider value={setBusy}>{children}</DialogBusyContext.Provider>
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
export function Avatar({ name, color = '#91b4e4' }: { name: string; color?: string }) {
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

export function AccountAvatar({
  name,
  src,
  platform,
}: {
  name: string;
  src?: string;
  platform?: string;
}) {
  const [failed, setFailed] = useState(false);
  const Icon =
    platform === 'tiktok'
      ? Music2
      : platform === 'instagram'
        ? Camera
        : platform === 'youtube'
          ? Clapperboard
          : Globe;
  return src && !failed ? (
    <Image
      className="channel-avatar"
      src={src}
      alt=""
      width={40}
      height={40}
      unoptimized
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : platform ? (
    <span className={`avatar platform-avatar ${platform}`} aria-hidden="true">
      <Icon size={19} />
    </span>
  ) : (
    <Avatar name={name} />
  );
}

/** One action group for compact confirmations. Escape/close and Cancel share the same safety guard. */
export function ConfirmationActions({
  onCancel,
  onConfirm,
  label,
  destructive = false,
  disabled = false,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<unknown>;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const setDialogBusy = useContext(DialogBusyContext);
  return (
    <div className="confirmation-actions">
      <AsyncButton type="button" className="button" disabled={busy} onClick={onCancel}>
        Cancel
      </AsyncButton>
      <AsyncButton
        type="button"
        className={`button ${destructive ? 'danger' : 'primary'}`}
        busy={busy}
        disabled={disabled}
        onClick={async () => {
          setBusy(true);
          setDialogBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setDialogBusy(false);
          }
        }}
      >
        {label}
      </AsyncButton>
    </div>
  );
}
