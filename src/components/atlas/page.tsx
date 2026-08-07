import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border bg-background/60 px-8 py-5 backdrop-blur">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        {meta && <div className="mt-2">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function StatusPill({
  tone = "muted",
  icon,
  children,
}: {
  tone?: "primary" | "success" | "warning" | "danger" | "muted";
  /**
   * Optional per-state glyph. When two states share a tone (failed vs recovery_required both
   * `danger`), an icon separates them pre-reading; it replaces the generic dot. Mark it
   * aria-hidden at the call site — the label text is the accessible name.
   */
  icon?: ReactNode;
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    primary: "bg-primary/10 text-primary border-primary/25",
    success: "bg-success/10 text-success border-success/30",
    warning: "bg-accent/10 text-accent border-accent/30",
    danger: "bg-destructive/10 text-destructive border-destructive/30",
    muted: "bg-highlight/5 text-muted-foreground border-highlight/10",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${tones[tone]}`}
    >
      {icon ? (
        <span className="[&_svg]:size-3">{icon}</span>
      ) : (
        <span
          // The primary "live" dot pulses; motion-reduce silences it for users who ask the OS to.
          className={`size-1.5 rounded-full ${tone === "primary" ? "bg-primary animate-pulse motion-reduce:animate-none" : tone === "success" ? "bg-success" : tone === "warning" ? "bg-accent" : tone === "danger" ? "bg-destructive" : "bg-muted-foreground"}`}
        />
      )}
      {children}
    </span>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeRowKey,
  empty,
}: {
  columns: {
    key: keyof T | string;
    header: string;
    className?: string;
    render?: (row: T) => ReactNode;
  }[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** rowKey of the currently-selected row (e.g. the one whose detail pane is open). */
  activeRowKey?: string;
  empty?: ReactNode;
}) {
  return (
    // overflow-x-auto (not overflow-hidden) so a wide table scrolls on narrow screens instead
    // of clipping columns; the rounded border still clips horizontally.
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-highlight/[0.03]">
          <tr>
            {columns.map((c) => (
              <th
                key={String(c.key)}
                scope="col"
                className={`px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground ${c.className ?? ""}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                {empty ?? "No entries yet."}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const isActive = activeRowKey !== undefined && rowKey(row) === activeRowKey;
            return (
              <tr
                key={rowKey(row)}
                onClick={() => onRowClick?.(row)}
                aria-current={isActive ? "true" : undefined}
                // A clickable row must be reachable and operable by keyboard too: it enters the
                // tab order and answers Enter/Space like the click it stands for.
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        if (event.target !== event.currentTarget) return;
                        event.preventDefault();
                        onRowClick(row);
                      }
                    : undefined
                }
                className={`border-t border-border transition-colors ${isActive ? "bg-primary/5 shadow-[inset_2px_0_0_0_var(--color-primary)]" : ""} ${onRowClick ? "cursor-pointer hover:bg-highlight/[0.03] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring" : ""}`}
              >
                {columns.map((c) => (
                  <td key={String(c.key)} className={`px-4 py-3 align-middle ${c.className ?? ""}`}>
                    {c.render
                      ? c.render(row)
                      : String((row as Record<string, unknown>)[c.key as string] ?? "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A filter / window toggle pill. Active state is carried by border + fill + text (not colour
 * alone) AND announced to assistive tech via `aria-pressed`, so a keyboard or screen-reader user
 * always knows which option is selected. Wrap a set in `<div role="group" aria-label="…">`.
 */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-highlight/[0.02] p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
