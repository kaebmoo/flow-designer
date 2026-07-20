import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/atlas/page";

export const Route = createFileRoute("/_app/usage")({
  component: UsagePage,
  head: () => ({ meta: [{ title: "Usage · Atlas Control" }] }),
});

const bars = [
  42, 61, 55, 78, 90, 66, 85, 120, 108, 96, 72, 130, 145, 118, 92, 60, 48, 71, 88, 102, 133, 121,
  96, 74,
];
const workerUsage = [
  { name: "Reporter · Local", tokens: 128_400, cost: 1.28, jobs: 214 },
  { name: "Anchor · Local 2", tokens: 44_100, cost: 0.44, jobs: 88 },
  { name: "Coder · Company Mac", tokens: 96_010, cost: 0.96, jobs: 71 },
  { name: "Research · GPU-01", tokens: 212_300, cost: 2.12, jobs: 143 },
];

function UsagePage() {
  const max = Math.max(...bars);
  return (
    <>
      <PageHeader
        title="Usage & Metering"
        subtitle="Tokens, jobs, and workspace load across the fleet."
      />
      <div className="flex-1 space-y-6 overflow-y-auto px-8 py-6">
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-baseline justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Tokens · last 24h
              </div>
              <div className="mt-1 font-mono text-2xl tabular-nums">
                {bars.reduce((a, b) => a + b, 0).toLocaleString()}k
              </div>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              hourly buckets
            </div>
          </div>
          <div className="flex h-40 items-end gap-1">
            {bars.map((v, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-primary/60 transition hover:bg-primary"
                style={{ height: `${(v / max) * 100}%` }}
              />
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <header className="border-b border-border px-6 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            By worker
          </header>
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03]">
              <tr>
                {["Worker", "Tokens", "Cost (USD)", "Jobs", "Load"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workerUsage.map((w) => {
                const pct = Math.min(100, (w.tokens / 220_000) * 100);
                return (
                  <tr key={w.name} className="border-t border-border">
                    <td className="px-4 py-3">{w.name}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      {w.tokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums">${w.cost.toFixed(2)}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{w.jobs}</td>
                    <td className="px-4 py-3">
                      <div className="h-1.5 w-full overflow-hidden rounded bg-white/5">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
