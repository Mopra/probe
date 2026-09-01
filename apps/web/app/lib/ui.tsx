import type { ReactNode } from 'react';
import { cn } from './format';

/** A panel. Everything on every screen sits in one of these. */
export function Panel({
  title,
  note,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('border border-edge bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-edge px-4 py-2.5">
          <div className="flex min-w-0 items-baseline gap-3">
            {title && <h2 className="lbl">{title}</h2>}
            {note && <span className="truncate text-xs text-faint">{note}</span>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* bodyClassName replaces the default padding rather than fighting it. */}
      <div className={bodyClassName ?? 'px-4 py-3'}>{children}</div>
    </section>
  );
}

/** The one number that matters on a screen is the biggest thing on it. */
export function Stat({
  label,
  value,
  sub,
  tone = 'default',
  size = 'md',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'signal' | 'warn' | 'danger' | 'quiet';
  size?: 'sm' | 'md' | 'lg';
}) {
  const toneClass =
    tone === 'signal'
      ? 'text-signal'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'danger'
          ? 'text-danger'
          : tone === 'quiet'
            ? 'text-dim'
            : 'text-fg';
  const sizeClass =
    size === 'lg'
      ? 'text-6xl font-light'
      : size === 'sm'
        ? 'text-2xl font-normal'
        : 'text-4xl font-light';
  return (
    <div className="flex flex-col gap-1.5">
      <span className="lbl">{label}</span>
      <span className={cn('leading-none tracking-tight tabular-nums', sizeClass, toneClass)}>
        {value}
      </span>
      {sub && <span className="text-xs tabular-nums text-faint">{sub}</span>}
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'signal' | 'warn' | 'danger' | 'ghost';
  title?: string;
}) {
  const map = {
    neutral: 'border-edge-strong bg-raised text-dim',
    signal: 'border-signal-dim bg-signal-dim/20 text-signal',
    warn: 'border-warn-dim bg-warn-dim/20 text-warn',
    danger: 'border-danger-dim bg-danger-dim/20 text-danger',
    ghost: 'border-transparent bg-transparent text-faint',
  } as const;
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

/** A labelled value in the right hand context column. */
export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b border-edge py-2 last:border-b-0">
      <span className="lbl pt-0.5">{label}</span>
      <div className={cn('min-w-0 break-words text-sm', mono && 'font-mono text-[12px]')}>
        {children}
      </div>
    </div>
  );
}

/** A rate rendered against the line it must not cross (§5.5). */
export function Meter({
  value,
  threshold,
  label,
  format,
}: {
  value: number;
  threshold: number;
  label: string;
  format: (n: number) => string;
}) {
  const safeThreshold = threshold > 0 ? threshold : 1;
  const ratio = value / safeThreshold;
  // The bar spans 0 to 1.5x the threshold, so the line always sits at two thirds.
  const fill = Math.max(0, Math.min(1, ratio / 1.5));
  const tone = ratio >= 1 ? 'danger' : ratio >= 0.6 ? 'warn' : 'signal';
  const barColor = tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-signal';
  const textColor =
    tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-signal';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="lbl">{label}</span>
        <span className={cn('font-mono text-sm tabular-nums', textColor)}>{format(value)}</span>
      </div>
      <div className="relative h-2 w-full bg-raised">
        <div
          className={cn('absolute inset-y-0 left-0', barColor)}
          style={{ width: `${(fill * 100).toFixed(2)}%` }}
        />
        <div className="absolute inset-y-[-3px] left-2/3 w-px bg-edge-strong" aria-hidden="true" />
      </div>
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] tabular-nums text-faint">0</span>
        <span className="font-mono text-[10px] tabular-nums text-faint">
          auto pause at {format(threshold)}
        </span>
      </div>
    </div>
  );
}

/** Empty is the state you see first, so it says what would fill it. */
export function Empty({ headline, hint }: { headline: string; hint?: string }) {
  return (
    <div className="flex flex-col items-start gap-2 border border-dashed border-edge px-4 py-8">
      <p className="text-sm text-dim">{headline}</p>
      {hint && <p className="max-w-prose text-xs text-faint">{hint}</p>}
    </div>
  );
}

export function TH({
  children,
  className,
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={cn(
        'lbl border-b border-edge px-3 py-2 font-normal',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  mono = false,
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={cn(
        'border-b border-edge px-3 py-2 align-top text-sm',
        mono && 'font-mono text-[12px] tabular-nums',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Button({
  children,
  tone = 'default',
  type = 'submit',
  name,
  value,
  title,
  disabled,
  className,
}: {
  children: ReactNode;
  tone?: 'default' | 'signal' | 'danger' | 'quiet';
  type?: 'submit' | 'button';
  name?: string;
  value?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  const map = {
    default: 'border-edge-strong bg-raised text-fg hover:border-dim',
    signal: 'border-signal-dim bg-signal-dim/25 text-signal hover:bg-signal-dim/45',
    danger: 'border-danger-dim bg-danger-dim/25 text-danger hover:bg-danger-dim/50',
    quiet: 'border-transparent bg-transparent text-faint hover:text-dim',
  } as const;
  return (
    <button
      type={type}
      name={name}
      value={value}
      title={title}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        map[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A link that looks like a button. Used for the raw .eml view. */
export function LinkButton({
  href,
  children,
  target,
}: {
  href: string;
  children: ReactNode;
  target?: string;
}) {
  return (
    <a
      href={href}
      target={target}
      rel={target === '_blank' ? 'noreferrer' : undefined}
      className="inline-flex items-center gap-2 border border-edge-strong bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-fg transition-colors hover:border-dim"
    >
      {children}
    </a>
  );
}

/** Form control shells, so /leads filters look like part of the panel. */
export const inputClass =
  'w-full border border-edge-strong bg-raised px-2 py-1.5 font-mono text-[12px] text-fg placeholder:text-faint';

export const selectClass =
  'w-full appearance-none border border-edge-strong bg-raised px-2 py-1.5 font-mono text-[12px] text-fg';
