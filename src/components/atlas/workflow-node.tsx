import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Webhook, Cpu, GitBranch, Repeat, Split, Merge, ShieldCheck, Sparkles } from "lucide-react";
import type { NodeKind } from "@/lib/atlas-store";

const meta: Record<NodeKind, { label: string; icon: typeof Cpu; accent: string }> = {
  trigger:   { label: "Trigger",   icon: Webhook,     accent: "bg-accent" },
  worker:    { label: "Worker",    icon: Cpu,         accent: "bg-primary" },
  condition: { label: "Condition", icon: GitBranch,   accent: "bg-[var(--color-chart-5)]" },
  loop:      { label: "Loop",      icon: Repeat,      accent: "bg-[var(--color-chart-5)]" },
  fanout:    { label: "Fan-out",   icon: Split,       accent: "bg-[var(--color-chart-2)]" },
  join:      { label: "Join",      icon: Merge,       accent: "bg-[var(--color-chart-2)]" },
  approval:  { label: "Approval",  icon: ShieldCheck, accent: "bg-accent" },
  manager:   { label: "Manager",   icon: Sparkles,    accent: "bg-primary" },
};

export type AtlasNodeData = {
  kind: NodeKind;
  label: string;
  hint?: string;
  runState?: "queued" | "running" | "success" | "failed" | "skipped";
};

export function AtlasNode({ data, selected }: NodeProps) {
  const d = data as unknown as AtlasNodeData;
  const m = meta[d.kind];
  const Icon = m.icon;
  const runTone =
    d.runState === "running" ? "border-primary shadow-[0_0_25px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]" :
    d.runState === "success" ? "border-[var(--color-success)]/60" :
    d.runState === "failed" ? "border-destructive/70" :
    d.runState === "skipped" ? "border-border opacity-50" :
    selected ? "border-primary" : "border-border";

  return (
    <div className={`w-56 rounded-lg border-2 bg-card shadow-xl transition ${runTone}`}>
      {d.kind !== "trigger" && <Handle type="target" position={Position.Left} />}
      <div className={`h-1 w-full ${m.accent} rounded-t`} />
      <div className="p-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <Icon className="size-3" /> {m.label}
          {d.runState === "running" && <span className="ml-auto text-primary">running</span>}
          {d.runState === "success" && <span className="ml-auto text-[var(--color-success)]">ok</span>}
          {d.runState === "failed" && <span className="ml-auto text-destructive">failed</span>}
        </div>
        <div className="mt-1 text-sm font-bold">{d.label}</div>
        {d.hint && <div className="mt-1 line-clamp-1 font-mono text-[10px] text-muted-foreground">{d.hint}</div>}
        {d.runState === "running" && (
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/5">
            <div className="h-full w-1/2 animate-pulse bg-primary" />
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}