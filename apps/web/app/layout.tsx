import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import './globals.css';
import { cn } from './lib/format';
import { sendEnabled, tryEnv } from './lib/probe';

export const metadata: Metadata = {
  title: 'probe',
  description: 'Internal outreach console. One email per person, ever.',
  robots: { index: false, follow: false },
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/queue', label: 'Queue' },
  { href: '/leads', label: 'Leads' },
  { href: '/sends', label: 'Sends' },
  { href: '/health', label: 'Health' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Set by middleware. Reading it here keeps the nav a server component with
  // no client router hook.
  const h = await headers();
  const pathname = h.get('x-probe-path') ?? '';

  // /data is linked from every email, so a recipient lands on it. Operator
  // navigation into Cloudflare Access gated screens has no business there.
  const operatorChrome = !pathname.startsWith('/data');

  const enabled = sendEnabled();
  const approver = tryEnv()?.PROBE_APPROVER ?? null;

  const gateTone =
    enabled === null
      ? 'border-edge-strong bg-raised text-dim'
      : enabled
        ? 'border-signal-dim bg-signal-dim/25 text-signal'
        : 'border-warn-dim bg-warn-dim/20 text-warn';

  const gateLabel = enabled === null ? 'send unknown' : enabled ? 'send enabled' : 'send disabled';

  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-fg antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:border focus:border-signal focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-40 border-b border-edge bg-ink/95 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-8">
            <a href="/" className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  'block h-2 w-2',
                  enabled ? 'bg-signal' : enabled === null ? 'bg-faint' : 'bg-warn',
                )}
              />
              <span className="font-mono text-sm lowercase tracking-[0.32em] text-fg">probe</span>
            </a>

            {operatorChrome && (
              <nav aria-label="Screens" className="flex items-center gap-1">
                {NAV.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'border-b-2 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
                        active
                          ? 'border-signal text-fg'
                          : 'border-transparent text-faint hover:text-dim',
                      )}
                    >
                      {item.label}
                    </a>
                  );
                })}
              </nav>
            )}

            {operatorChrome && (
              <div className="ml-auto flex items-center gap-3">
                {approver && (
                  <span className="hidden font-mono text-[11px] tracking-[0.12em] text-faint sm:inline">
                    approver {approver}
                  </span>
                )}
                <span
                  title="PROBE_SEND_ENABLED. One of two independent gates: a campaign can still be paused."
                  className={cn(
                    'inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em]',
                    gateTone,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'block h-1.5 w-1.5 rounded-full',
                      enabled === null ? 'bg-faint' : enabled ? 'bg-signal' : 'bg-warn',
                    )}
                  />
                  {gateLabel}
                </span>
              </div>
            )}
          </div>
        </header>

        <main id="main" className="px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>

        <footer className="border-t border-edge px-4 py-4 text-[11px] text-faint lg:px-8">
          <span className="font-mono tracking-[0.12em]">
            probe. one email per person, ever. no follow ups, no sequence.
          </span>
        </footer>
      </body>
    </html>
  );
}
