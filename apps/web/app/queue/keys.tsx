'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The only client component in the console (§10 keyboard: j, k, a, x).
 * It owns focus and key events and submits forms that already exist in the
 * server rendered markup. No client state library, no data fetching, and it
 * never sees a contact address it was not already handed by the server.
 */
export function QueueKeys({ count }: { count: number }) {
  const [selected, setSelected] = useState(0);
  // The key handler reads the selection through a ref, never through a state
  // updater: an updater is not the place for a side effect, and Strict Mode
  // runs it twice, which here would mean approving twice.
  const selectedRef = useRef(0);

  useEffect(() => {
    if (count === 0) return;

    const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-queue-item]'));

    const paint = (index: number) => {
      for (const el of items()) {
        const isSel = Number(el.dataset.queueItem) === index;
        el.classList.toggle('ring-1', isSel);
        el.classList.toggle('ring-signal', isSel);
      }
    };

    const select = (index: number, scroll: boolean) => {
      const next = Math.min(count - 1, Math.max(0, index));
      selectedRef.current = next;
      setSelected(next);
      paint(next);
      if (scroll) {
        items()
          .find((n) => Number(n.dataset.queueItem) === next)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    };

    const submit = (action: 'approve' | 'reject') => {
      const index = selectedRef.current;
      const el = items().find((n) => Number(n.dataset.queueItem) === index);
      if (!el) return;
      if (action === 'approve' && el.dataset.lint === 'fail') return;
      el.querySelector<HTMLFormElement>(`form[data-action="${action}"]`)?.requestSubmit();
    };

    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isTyping(ev.target)) return;
      switch (ev.key) {
        case 'j':
          ev.preventDefault();
          select(selectedRef.current + 1, true);
          break;
        case 'k':
          ev.preventDefault();
          select(selectedRef.current - 1, true);
          break;
        case 'a':
          ev.preventDefault();
          submit('approve');
          break;
        case 'x':
          ev.preventDefault();
          submit('reject');
          break;
        default:
          break;
      }
    };

    const onClick = (ev: MouseEvent) => {
      const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-queue-item]');
      if (!el) return;
      select(Number(el.dataset.queueItem), false);
    };

    select(0, false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [count]);

  if (count === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-edge bg-surface px-4 py-2">
      <span className="lbl">Keyboard</span>
      <Key k="j" label="next" />
      <Key k="k" label="previous" />
      <Key k="a" label="approve" />
      <Key k="x" label="reject" />
      <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
        item {Math.min(selected + 1, count)} of {count}
      </span>
    </div>
  );
}

function Key({ k, label }: { k: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <kbd className="border border-edge-strong bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg">
        {k}
      </kbd>
      <span className="font-mono text-[11px] tracking-[0.1em] text-faint">{label}</span>
    </span>
  );
}
