import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ChoiceOption, NodeKind, WorkflowNodeConfig } from "./workflow-scaffold-store";
import { NODE_PRESENTATION } from "./workflow-node-presentation";

export type AtlasNodeData = {
  kind: NodeKind;
  label: string;
  hint?: string;
  config: WorkflowNodeConfig;
  runState?: "queued" | "running" | "waiting" | "success" | "failed" | "skipped";
};

type BranchOption = { id: string; label: string };

function textConfig(config: WorkflowNodeConfig, key: string, fallback = "") {
  const value = config[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function decisionChoices(config: WorkflowNodeConfig): ChoiceOption[] {
  const choices = config.choices;
  return Array.isArray(choices) ? choices : [];
}

function branchOptions(data: AtlasNodeData): BranchOption[] {
  if (data.kind === "condition") {
    return [
      { id: "condition:true", label: textConfig(data.config, "true_label", "matches") },
      { id: "condition:false", label: textConfig(data.config, "false_label", "otherwise") },
    ];
  }
  if (data.kind === "decision") {
    return decisionChoices(data.config).map((choice) => ({
      id: `choice:${choice.id}`,
      label: choice.label,
    }));
  }
  return [];
}

export function AtlasNode({ data, selected }: NodeProps) {
  const d = data as unknown as AtlasNodeData;
  const presentation = NODE_PRESENTATION[d.kind];
  const Icon = presentation.icon;
  const branches = branchOptions(d);
  const runTone =
    d.runState === "running"
      ? "border-primary shadow-[0_0_28px_color-mix(in_oklab,var(--color-primary)_28%,transparent)]"
      : d.runState === "waiting"
        ? "border-amber-300 shadow-[0_0_28px_rgb(252_211_77_/_16%)]"
        : d.runState === "success"
          ? "border-[var(--color-success)]/70"
          : d.runState === "failed"
            ? "border-destructive/80"
            : d.runState === "skipped"
              ? "border-border opacity-50"
              : selected
                ? "border-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_12%,transparent)]"
                : "border-[#314154]";
  const stateDot =
    d.runState === "running"
      ? "animate-pulse bg-primary"
      : d.runState === "waiting"
        ? "animate-pulse bg-amber-300"
        : d.runState === "success"
          ? "bg-[var(--color-success)]"
          : d.runState === "failed"
            ? "bg-destructive"
            : "bg-[#53677b]";

  return (
    <div
      className={`group relative w-60 rounded-xl border bg-[#101b29] p-2.5 shadow-[0_14px_30px_rgba(0,0,0,0.22)] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px ${runTone}`}
    >
      {d.kind !== "trigger" && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-3 !border-2 !border-[#101b29] !bg-[#91a4b7]"
        />
      )}
      <div className="flex items-center gap-2.5">
        <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${presentation.tile}`}>
          <Icon className="size-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
            {d.label}
          </div>
          <div className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground">
            {d.hint || presentation.description}
          </div>
        </div>
        <div className={`size-2 shrink-0 rounded-full ${stateDot}`} />
      </div>

      {branches.length > 0 && (
        <div className="mt-2 border-t border-[#2b3b4d] pt-1.5">
          {branches.map((branch, index) => (
            <div
              key={branch.id}
              className="relative flex h-5 items-center gap-1.5 pl-1 text-[10px] text-[#b7c5d2]"
            >
              <span className={`size-1.5 rounded-full ${presentation.accent}`} />
              <span className="truncate">{branch.label}</span>
              <Handle
                id={branch.id}
                type="source"
                position={Position.Right}
                style={{ top: `${70 + index * 20}px` }}
                className="!size-3 !border-2 !border-[#101b29] !bg-[#91a4b7] group-hover:!bg-primary"
              />
            </div>
          ))}
        </div>
      )}

      {d.runState === "running" && (
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/5">
          <div className={`h-full w-1/2 animate-pulse ${presentation.accent}`} />
        </div>
      )}
      {branches.length === 0 && (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-3 !border-2 !border-[#101b29] !bg-[#91a4b7] group-hover:!bg-primary"
        />
      )}
    </div>
  );
}
