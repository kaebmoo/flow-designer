import type { Edge, Node } from "@xyflow/react";
import type { ChoiceOption } from "./workflow-scaffold-store";
import type { AtlasNodeData } from "./workflow-node";

export type NodeRunState = "queued" | "running" | "waiting" | "success" | "failed" | "skipped";

export type PendingGate =
  | {
      kind: "approval";
      nodeId: string;
      title: string;
      message: string;
    }
  | {
      kind: "decision";
      nodeId: string;
      title: string;
      question: string;
      choices: ChoiceOption[];
    };

type SimulatorOptions = {
  nodes: Node[];
  edges: Edge[];
  onNodeState: (nodeId: string, state: NodeRunState) => void;
  onLog: (nodeId: string, text: string, level?: "info" | "success" | "error" | "warn") => void;
  onGate: (gate: PendingGate | null) => void;
  onFinish: (state: "success" | "failed") => void;
};

const asText = (value: unknown, fallback = "") =>
  typeof value === "string" || typeof value === "number" ? String(value) : fallback;

const getChoices = (data: AtlasNodeData): ChoiceOption[] =>
  Array.isArray(data.config.choices) ? data.config.choices : [];

export function createWorkflowSimulator(options: SimulatorOptions) {
  const nodeById = new Map(options.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const started = new Set<string>();
  const active = new Set<string>();
  const joinArrivals = new Map<string, Set<string>>();
  let pending: PendingGate | null = null;
  let finished = false;
  let stopped = false;

  for (const edge of options.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }

  const dataFor = (nodeId: string) => nodeById.get(nodeId)?.data as AtlasNodeData | undefined;

  const markUnreachedAsSkipped = () => {
    for (const node of options.nodes) {
      if (!started.has(node.id)) options.onNodeState(node.id, "skipped");
    }
  };

  const finishIfIdle = () => {
    if (finished || pending || active.size > 0) return;
    finished = true;
    markUnreachedAsSkipped();
    options.onLog("SYSTEM", "Workflow completed successfully.", "success");
    options.onFinish("success");
  };

  const branchMatches = (edge: Edge, branch: string, label: string) => {
    const edgeLabel = String(edge.label ?? "").toLowerCase();
    return (
      edge.sourceHandle === branch ||
      edgeLabel === branch.replace("condition:", "") ||
      edgeLabel === label.toLowerCase()
    );
  };

  const deliver = (edge: Edge) => {
    const targetData = dataFor(edge.target);
    if (!targetData || stopped) return;

    if (targetData.kind !== "join") {
      startNode(edge.target);
      return;
    }

    const arrivals = joinArrivals.get(edge.target) ?? new Set<string>();
    arrivals.add(edge.id);
    joinArrivals.set(edge.target, arrivals);
    const mode = asText(targetData.config.mode, "all");
    const required = incoming.get(edge.target)?.length ?? 1;
    const threshold =
      mode === "any"
        ? 1
        : mode === "quorum"
          ? Number(asText(targetData.config.quorum, "2"))
          : required;
    if (arrivals.size >= Math.max(1, threshold)) startNode(edge.target);
  };

  const route = (
    nodeId: string,
    outcome?: { type: "decision"; choiceId: string } | { type: "condition"; passed: boolean },
  ) => {
    const data = dataFor(nodeId);
    if (!data || stopped) return;
    const candidates = outgoing.get(nodeId) ?? [];
    let next = candidates;

    if (data.kind === "decision" && outcome?.type === "decision") {
      const selected = getChoices(data).find((choice) => choice.id === outcome.choiceId);
      next = selected
        ? candidates.filter(
            (edge) =>
              edge.sourceHandle === `choice:${selected.id}` ||
              String(edge.label ?? "") === selected.label,
          )
        : [];
    }

    if (data.kind === "condition" && outcome?.type === "condition") {
      const key = outcome.passed ? "condition:true" : "condition:false";
      const label = asText(
        data.config[outcome.passed ? "true_label" : "false_label"],
        outcome.passed ? "matches" : "otherwise",
      );
      next = candidates.filter((edge) => branchMatches(edge, key, label));
      if (next.length === 0) next = candidates.slice(0, 1);
    }

    if (data.kind === "manager") next = candidates.slice(0, 1);
    next.forEach(deliver);
  };

  const completeNode = (
    nodeId: string,
    outcome?: { type: "decision"; choiceId: string } | { type: "condition"; passed: boolean },
  ) => {
    if (stopped) return;
    const data = dataFor(nodeId);
    if (!data) return;
    active.delete(nodeId);
    options.onNodeState(nodeId, "success");

    if (data.kind === "condition") {
      const passed = outcome?.type === "condition" ? outcome.passed : true;
      options.onLog(nodeId, `Condition ${passed ? "matched" : "fell through"}.`, "success");
    } else if (data.kind === "manager") {
      options.onLog(nodeId, "Manager selected the first connected path.", "success");
    } else {
      options.onLog(nodeId, `${data.label} completed.`, "success");
    }

    route(nodeId, outcome);
    finishIfIdle();
  };

  function startNode(nodeId: string) {
    if (started.has(nodeId) || stopped) return;
    const data = dataFor(nodeId);
    if (!data) return;
    started.add(nodeId);

    if (data.kind === "approval") {
      pending = {
        kind: "approval",
        nodeId,
        title: data.label,
        message: asText(data.config.message, "Please review before the workflow continues."),
      };
      options.onNodeState(nodeId, "waiting");
      options.onLog(nodeId, "Waiting for approval.", "warn");
      options.onGate(pending);
      return;
    }

    if (data.kind === "decision") {
      pending = {
        kind: "decision",
        nodeId,
        title: data.label,
        question: asText(data.config.question, "Pick how to continue."),
        choices: getChoices(data),
      };
      options.onNodeState(nodeId, "waiting");
      options.onLog(nodeId, "Waiting for a human choice.", "warn");
      options.onGate(pending);
      return;
    }

    active.add(nodeId);
    options.onNodeState(nodeId, "running");
    options.onLog(nodeId, `Running ${data.label}…`);
    setTimeout(() => {
      if (data.kind === "condition") completeNode(nodeId, { type: "condition", passed: true });
      else completeNode(nodeId);
    }, 700);
  }

  const start = () => {
    const initialNodes = options.nodes.filter(
      (node) => dataFor(node.id)?.kind === "trigger" || (incoming.get(node.id)?.length ?? 0) === 0,
    );
    (initialNodes.length ? initialNodes : options.nodes.slice(0, 1)).forEach((node) =>
      startNode(node.id),
    );
  };

  const approve = (approved: boolean) => {
    if (!pending || pending.kind !== "approval") return;
    const gate = pending;
    pending = null;
    options.onGate(null);
    if (!approved) {
      stopped = true;
      options.onNodeState(gate.nodeId, "failed");
      options.onLog(gate.nodeId, "Approval was rejected. Workflow stopped.", "error");
      markUnreachedAsSkipped();
      options.onFinish("failed");
      return;
    }
    options.onLog(gate.nodeId, "Approval accepted.", "success");
    completeNode(gate.nodeId);
  };

  const choose = (choiceId: string) => {
    if (!pending || pending.kind !== "decision") return;
    const gate = pending;
    const selected = gate.choices.find((choice) => choice.id === choiceId);
    if (!selected) return;
    pending = null;
    options.onGate(null);
    options.onLog(gate.nodeId, `Selected “${selected.label}”.`, "success");
    completeNode(gate.nodeId, { type: "decision", choiceId });
  };

  const cancel = () => {
    stopped = true;
    pending = null;
    active.clear();
    options.onGate(null);
  };

  return { start, approve, choose, cancel };
}
