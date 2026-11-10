'use client';
import {
  Children,
  isValidElement,
  cloneElement,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from 'react';
import { LoaderCircle } from 'lucide-react';

/** Covers promise-returning click actions; forms can pass their own busy state. */
export function AsyncButton({
  onClick,
  busy = false,
  children,
  disabled,
  ...props
}: ComponentProps<'button'> & { busy?: boolean }) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const loading = busy || pending;
  const nodes = Children.toArray(children);
  const isIcon = (node: unknown): node is ReactElement<{ size?: number | string }> => {
    if (!isValidElement(node)) return false;
    // Native SVGs and the forward-ref icon components used by Lucide.
    return (
      node.type === 'svg' ||
      (typeof node.type === 'object' &&
        node.type !== null &&
        'render' in node.type &&
        'displayName' in node.type)
    );
  };
  const firstIcon = nodes.findIndex(isIcon);
  const overlayText = firstIcon < 0;
  const slot = (
    icon: ReactElement<{ size?: number | string }> | null,
    replace: boolean,
    key: string | number
  ) => {
    const size = icon?.props.size ?? 16;
    return (
      <span
        key={key}
        className="button-icon-slot"
        aria-hidden="true"
        style={{ width: size, height: size }}
      >
        <span
          className="button-original-icon"
          style={{ visibility: loading ? 'hidden' : undefined }}
        >
          {icon ? (icon.type === 'svg' ? icon : cloneElement(icon, { size })) : null}
        </span>
        {loading && replace && <LoaderCircle size={size} className="spinner button-loading-icon" />}
      </span>
    );
  };
  return (
    <>
      <button
        {...props}
        style={{ ...props.style, ...(overlayText ? { position: 'relative' } : {}) }}
        disabled={disabled || busy || pending}
        aria-busy={busy || pending || undefined}
        onClick={
          onClick
            ? async (event) => {
                if (running.current || busy) return;
                running.current = true;
                setError('');
                try {
                  const result = onClick(event) as unknown;
                  if (result && typeof (result as Promise<unknown>).then === 'function') {
                    setPending(true);
                    await result;
                  }
                } catch (failure) {
                  setError(
                    failure instanceof Error ? failure.message : 'The operation failed. Try again.'
                  );
                } finally {
                  running.current = false;
                  setPending(false);
                }
              }
            : undefined
        }
      >
        {overlayText ? (
          <span style={{ opacity: loading ? 0 : undefined }}>{children}</span>
        ) : (
          nodes.map((node, index) => (isIcon(node) ? slot(node, index === firstIcon, index) : node))
        )}
        {overlayText && loading && (
          <LoaderCircle size={15} className="spinner button-loading-icon" aria-hidden="true" />
        )}
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
