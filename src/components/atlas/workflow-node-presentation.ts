import {
  Cpu,
  GitBranch,
  ListChecks,
  Merge,
  Repeat,
  ShieldCheck,
  Sparkles,
  Split,
  Webhook,
} from "lucide-react";
import type { NodeKind } from "@/lib/atlas-store";

export const NODE_PRESENTATION: Record<
  NodeKind,
  {
    label: string;
    description: string;
    icon: typeof Cpu;
    tile: string;
    accent: string;
  }
> = {
  trigger: {
    label: "Trigger",
    description: "Start from an event or schedule",
    icon: Webhook,
    tile: "border border-amber-300/20 bg-amber-300/15 text-amber-200",
    accent: "bg-amber-300",
  },
  worker: {
    label: "Worker task",
    description: "Run a job on a connected worker",
    icon: Cpu,
    tile: "border border-primary/20 bg-primary/15 text-primary",
    accent: "bg-primary",
  },
  condition: {
    label: "Condition",
    description: "Route work based on an expression",
    icon: GitBranch,
    tile: "border border-fuchsia-300/20 bg-fuchsia-300/15 text-fuchsia-200",
    accent: "bg-fuchsia-300",
  },
  decision: {
    label: "Ask to choose",
    description: "Let a person choose the next path",
    icon: ListChecks,
    tile: "border border-teal-300/20 bg-teal-300/15 text-teal-200",
    accent: "bg-teal-300",
  },
  loop: {
    label: "Loop",
    description: "Repeat work for each item",
    icon: Repeat,
    tile: "border border-fuchsia-300/20 bg-fuchsia-300/15 text-fuchsia-200",
    accent: "bg-fuchsia-300",
  },
  fanout: {
    label: "Fan out",
    description: "Send work down parallel paths",
    icon: Split,
    tile: "border border-emerald-300/20 bg-emerald-300/15 text-emerald-200",
    accent: "bg-emerald-300",
  },
  join: {
    label: "Join",
    description: "Continue after branches finish",
    icon: Merge,
    tile: "border border-emerald-300/20 bg-emerald-300/15 text-emerald-200",
    accent: "bg-emerald-300",
  },
  approval: {
    label: "Approval",
    description: "Pause for a human decision",
    icon: ShieldCheck,
    tile: "border border-orange-300/20 bg-orange-300/15 text-orange-200",
    accent: "bg-orange-300",
  },
  manager: {
    label: "Manager",
    description: "Let an AI choose the next path",
    icon: Sparkles,
    tile: "border border-primary/20 bg-primary/15 text-primary",
    accent: "bg-primary",
  },
};
