import type { ReactNode } from "react";

export function PageHeader({
  title, subtitle, actions, meta,
}: { title: string; subtitle?: string; actions?: ReactNode; meta?: ReactNode }) {
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
  tone = "muted", children,
}: { tone?: "primary" | "success" | "warning" | "danger" | "muted"; children: ReactNode }) {
  const tones: Record<string, string> = {
    primary: "bg-primary/10 text-primary border-primary/25",
    success: "bg-[var(--color-success)]/10 text-[var(--color-success)] border-[var(--color-success)]/30",
    warning: "bg-accent/10 text-accent border-accent/30",
    danger: "bg-destructive/10 text-destructive border-destructive/30",
    muted: "bg-white/5 text-muted-foreground border-white/10",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${tones[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${tone === "primary" ? "bg-primary animate-pulse" : tone === "success" ? "bg-[var(--color-success)]" : tone === "warning" ? "bg-accent" : tone === "danger" ? "bg-destructive" : "bg-muted-foreground"}`} />
      {children}
    </span>
  );
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, empty,
}: {
  columns: { key: keyof T | string; header: string; className?: string; render?: (row: T) => ReactNode }[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-white/[0.03]">
          <tr>
            {columns.map((c) => (
              <th
                key={String(c.key)}
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
              <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-muted-foreground">
                {empty ?? "No entries yet."}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={() => onRowClick?.(row)}
              className={`border-t border-border transition-colors ${onRowClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
            >
              {columns.map((c) => (
                <td key={String(c.key)} className={`px-4 py-3 align-middle ${c.className ?? ""}`}>
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key as string] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-white/[0.02] p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}