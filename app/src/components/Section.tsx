import type { ReactNode } from 'react';

/**
 * A collapsible group inside the card. Header is always a single row so
 * the four section headers stack predictably when everything is closed.
 */
export function Section({
  title,
  count,
  open,
  onToggle,
  dot,
  guarded = false,
  note,
  action,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** Tailwind bg-* class for the pile dot. Shapes only, so teal is fine. */
  dot: string;
  /** The not-dust section gets a teal fill so it reads as a different
   *  kind of list without needing a colour that fails contrast. */
  guarded?: boolean;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`border-t border-teal/45 first:border-t-0 ${
        guarded ? '-mx-2 rounded-lg border-t-transparent bg-teal/12 px-2' : ''
      }`}
    >
      <div className="flex items-center gap-2 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Chevron open={open} />
          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
          <span className="truncate text-[13px] font-medium text-cream">{title}</span>
          <span className="num shrink-0 text-[12px] text-muted">{count}</span>
        </button>
        {open && action}
      </div>

      {open && (
        <div className="pb-2">
          {note && (
            <p className="px-2 pb-2 text-[11px] leading-relaxed text-muted">{note}</p>
          )}
          {count === 0 ? (
            <p className="px-2 pb-1 text-[11px] text-faint">Nothing here.</p>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`size-3 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 2.5 L8 6 L4.5 9.5" />
    </svg>
  );
}
