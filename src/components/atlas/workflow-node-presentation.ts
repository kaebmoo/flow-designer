/**
 * Visual identity for the four node kinds Atlas actually has.
 *
 * Five of the scaffold's nine entries are gone because Atlas has no such node type: `trigger`
 * is a separate resource, `condition` is an edge property, `loop` is a guarded cycle, and
 * `fanout` is simply more than one outgoing edge. `approval` was the scaffold's name for what
 * Atlas calls `human_gate`; the internal kind is now Atlas's, while the UI uses the clearer
 * "Human decision" label.
 *
 * Colours are design tokens, not literals, so the canvas follows the theme like the rest of the
 * app. The icons the removed kinds used are reused where their meaning survived: `GitBranch`
 * now marks a conditional edge, and `Webhook` belongs to the trigger panel.
 */

import { Cpu, Merge, ShieldCheck, Sparkles } from "lucide-react";

import type { NodeKind } from "@/lib/workflow-graph";

export interface NodePresentation {
  label: string;
  description: string;
  icon: typeof Cpu;
  /** The icon tile: border, fill, and foreground, all token-derived. */
  tile: string;
  /** A solid accent for handles, bullets, and the start badge. */
  accent: string;
}

export const NODE_PRESENTATION: Record<NodeKind, NodePresentation> = {
  worker: {
    label: "AI Task",
    description: "Runs an instruction on a connected worker",
    icon: Cpu,
    tile: "border border-primary/25 bg-primary/15 text-primary",
    accent: "bg-primary",
  },
  manager: {
    label: "AI Decision",
    description: "Chooses which connected path runs next",
    icon: Sparkles,
    tile: "border border-accent/25 bg-accent/15 text-accent",
    accent: "bg-accent",
  },
  join: {
    label: "Wait for branches",
    description: "Waits for branches before continuing",
    icon: Merge,
    tile: "border border-success/25 bg-success/15 text-success",
    accent: "bg-success",
  },
  human_gate: {
    label: "Human decision",
    description: "Pauses for approval or a choice",
    icon: ShieldCheck,
    tile: "border border-warning/25 bg-warning/15 text-warning",
    accent: "bg-warning",
  },
};

/** Palette order: the two that do work, then the two that control flow. */
export const PALETTE_ORDER: readonly NodeKind[] = ["worker", "manager", "join", "human_gate"];
