/**
 * Visual identity for the four node kinds Atlas actually has.
 *
 * Five of the scaffold's nine entries are gone because Atlas has no such node type: `trigger`
 * is a separate resource, `condition` is an edge property, `loop` is a guarded cycle, and
 * `fanout` is simply more than one outgoing edge. `approval` was the scaffold's name for what
 * Atlas calls `human_gate`; the internal kind is now Atlas's, and "Approval" survives only as
 * the label an operator reads.
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
    label: "Worker",
    description: "Runs a prompt on a connected worker",
    icon: Cpu,
    tile: "border border-primary/25 bg-primary/15 text-primary",
    accent: "bg-primary",
  },
  manager: {
    label: "Manager",
    description: "Lets a model choose which path to take",
    icon: Sparkles,
    tile: "border border-accent/25 bg-accent/15 text-accent",
    accent: "bg-accent",
  },
  join: {
    label: "Join",
    description: "Waits for upstream branches to arrive",
    icon: Merge,
    tile: "border border-success/25 bg-success/15 text-success",
    accent: "bg-success",
  },
  human_gate: {
    label: "Approval",
    description: "Pauses until a person decides",
    icon: ShieldCheck,
    tile: "border border-warning/25 bg-warning/15 text-warning",
    accent: "bg-warning",
  },
};

/** Palette order: the two that do work, then the two that control flow. */
export const PALETTE_ORDER: readonly NodeKind[] = ["worker", "manager", "join", "human_gate"];
