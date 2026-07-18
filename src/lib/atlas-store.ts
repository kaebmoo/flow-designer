import { create } from "zustand";

export type WorkerStatus = "online" | "offline" | "degraded";
export type Worker = {
  id: string;
  name: string;
  base_url: string;
  role: string;
  tags: string[];
  status: WorkerStatus;
  workspaces: string[];
  version: string;
  last_seen: string;
};

export type JobState = "queued" | "running" | "success" | "failed" | "cancelled";
export type Job = {
  id: string;
  prompt: string;
  worker: string;
  workspace: string;
  state: JobState;
  started_at: string;
  duration_ms: number;
  tokens: number;
  session?: string;
};

export type NodeKind =
  | "trigger"
  | "worker"
  | "condition"
  | "loop"
  | "fanout"
  | "join"
  | "approval"
  | "manager";

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  config: Record<string, string>;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type Workflow = {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft" | "disabled";
  updated_at: string;
  runs_24h: number;
  success_rate: number;
  trigger_enabled: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type RunState = "running" | "success" | "failed" | "paused" | "cancelled";
export type WorkflowRun = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  state: RunState;
  started_at: string;
  duration_ms: number;
  triggered_by: string;
  node_states: Record<string, "queued" | "running" | "success" | "failed" | "skipped">;
  log: Array<{ ts: string; node: string; level: "info" | "warn" | "error" | "success"; text: string }>;
};

const now = () => new Date().toISOString();

const initialWorkers: Worker[] = [
  { id: "wrk_01", name: "Reporter · Local", base_url: "http://127.0.0.1:4317", role: "reporter", tags: ["local", "news"], status: "online", workspaces: ["thclaws", "research"], version: "1.4.2", last_seen: "12s ago" },
  { id: "wrk_02", name: "Anchor · Local 2", base_url: "http://127.0.0.1:4318", role: "anchor", tags: ["local", "broadcast"], status: "online", workspaces: ["thclaws"], version: "1.4.2", last_seen: "8s ago" },
  { id: "wrk_03", name: "Coder · Company Mac", base_url: "http://100.64.1.12:4317", role: "coder", tags: ["company-a", "code"], status: "degraded", workspaces: ["thclaws", "atlas"], version: "1.3.9", last_seen: "2m ago" },
  { id: "wrk_04", name: "Reviewer · Edge", base_url: "http://100.64.1.14:4317", role: "reviewer", tags: ["review", "qa"], status: "offline", workspaces: [], version: "1.3.7", last_seen: "1h ago" },
  { id: "wrk_05", name: "Research · GPU-01", base_url: "http://10.0.4.21:4317", role: "researcher", tags: ["gpu", "finance"], status: "online", workspaces: ["research", "finance"], version: "1.4.2", last_seen: "3s ago" },
];

const initialJobs: Job[] = [
  { id: "job_8829", prompt: "Summarize today's telecom incident logs...", worker: "Reporter · Local", workspace: "thclaws", state: "running", started_at: "14:22:01", duration_ms: 12400, tokens: 1204, session: "sess_A12" },
  { id: "job_8828", prompt: "Read the report as broadcast script.", worker: "Anchor · Local 2", workspace: "thclaws", state: "success", started_at: "14:20:11", duration_ms: 8100, tokens: 890 },
  { id: "job_8827", prompt: "Review PR #482 for regressions.", worker: "Coder · Company Mac", workspace: "atlas", state: "failed", started_at: "14:12:04", duration_ms: 4300, tokens: 512 },
  { id: "job_8826", prompt: "Extract entities from filing.", worker: "Research · GPU-01", workspace: "finance", state: "success", started_at: "14:04:22", duration_ms: 15600, tokens: 2380 },
  { id: "job_8825", prompt: "Draft weekly digest.", worker: "Reporter · Local", workspace: "research", state: "queued", started_at: "14:03:00", duration_ms: 0, tokens: 0 },
];

const defaultWorkflow: Workflow = {
  id: "wf_ingest",
  name: "Data Ingestion Pipeline",
  description: "Webhook → Reporter → Volume check → Anchor + Approval → Join",
  status: "active",
  updated_at: "2m ago",
  runs_24h: 214,
  success_rate: 98.1,
  trigger_enabled: true,
  nodes: [
    { id: "n1", kind: "trigger", label: "Webhook Inlet", x: 40, y: 200, config: { path: "/api/v1/ingest", auth: "hmac" } },
    { id: "n2", kind: "worker", label: "Reporter Worker", x: 300, y: 200, config: { worker: "wrk_01", workspace: "thclaws", prompt: "Analyze incoming payload and extract priority signals." } },
    { id: "n3", kind: "condition", label: "Volume Check", x: 560, y: 200, config: { expr: "payload.qty > 1000" } },
    { id: "n4", kind: "worker", label: "Anchor Worker", x: 820, y: 80, config: { worker: "wrk_02", workspace: "thclaws", prompt: "Compose broadcast script." } },
    { id: "n5", kind: "approval", label: "Ops Approval", x: 820, y: 320, config: { approvers: "ops-lead", timeout_s: "600" } },
    { id: "n6", kind: "join", label: "Join (all)", x: 1080, y: 200, config: { mode: "all" } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
    { id: "e3", source: "n3", target: "n4", label: "true" },
    { id: "e4", source: "n3", target: "n5", label: "else" },
    { id: "e5", source: "n4", target: "n6" },
    { id: "e6", source: "n5", target: "n6" },
  ],
};

const initialWorkflows: Workflow[] = [
  defaultWorkflow,
  {
    id: "wf_research",
    name: "Research → Writer Chain",
    description: "Research worker feeds a Writer worker with citations.",
    status: "active", updated_at: "1h ago", runs_24h: 47, success_rate: 95.4, trigger_enabled: true,
    nodes: [
      { id: "n1", kind: "trigger", label: "Manual", x: 40, y: 160, config: {} },
      { id: "n2", kind: "worker", label: "Research", x: 320, y: 160, config: { worker: "wrk_05", workspace: "research", prompt: "Gather sources." } },
      { id: "n3", kind: "worker", label: "Writer", x: 620, y: 160, config: { worker: "wrk_01", workspace: "research", prompt: "Draft article from {result}." } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  },
  {
    id: "wf_code",
    name: "Coder → Reviewer",
    description: "Coder proposes patch, Reviewer validates before merge.",
    status: "draft", updated_at: "3h ago", runs_24h: 0, success_rate: 0, trigger_enabled: false,
    nodes: [
      { id: "n1", kind: "trigger", label: "Webhook", x: 40, y: 160, config: { path: "/api/v1/pr" } },
      { id: "n2", kind: "worker", label: "Coder", x: 320, y: 160, config: { worker: "wrk_03", workspace: "atlas" } },
      { id: "n3", kind: "approval", label: "Human Review", x: 620, y: 160, config: {} },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }, { id: "e2", source: "n2", target: "n3" }],
  },
  {
    id: "wf_digest",
    name: "Daily Digest",
    description: "Cron trigger produces a daily broadcast digest.",
    status: "disabled", updated_at: "yesterday", runs_24h: 0, success_rate: 92.0, trigger_enabled: false,
    nodes: [
      { id: "n1", kind: "trigger", label: "Cron 09:00", x: 40, y: 160, config: { cron: "0 9 * * *" } },
      { id: "n2", kind: "worker", label: "Digest", x: 320, y: 160, config: { worker: "wrk_01", workspace: "research" } },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  },
];

const initialRuns: WorkflowRun[] = [
  {
    id: "run_00214", workflow_id: "wf_ingest", workflow_name: "Data Ingestion Pipeline",
    state: "running", started_at: "14:22:01", duration_ms: 12400, triggered_by: "webhook",
    node_states: { n1: "success", n2: "running", n3: "queued", n4: "queued", n5: "queued", n6: "queued" },
    log: [
      { ts: "14:22:01.03", node: "SYSTEM", level: "info", text: "Workflow initialized." },
      { ts: "14:22:01.45", node: "WEBHOOK", level: "success", text: "Inbound request from 192.168.1.4 accepted." },
      { ts: "14:22:02.12", node: "REPORTER", level: "info", text: "Executing Reporter Worker on chunk size 2048..." },
      { ts: "14:22:13.98", node: "REPORTER", level: "info", text: "Streaming: extracted 12 priority signals..." },
    ],
  },
  {
    id: "run_00213", workflow_id: "wf_ingest", workflow_name: "Data Ingestion Pipeline",
    state: "success", started_at: "14:12:44", duration_ms: 18320, triggered_by: "webhook",
    node_states: { n1: "success", n2: "success", n3: "success", n4: "success", n5: "skipped", n6: "success" },
    log: [{ ts: "14:12:44", node: "SYSTEM", level: "success", text: "Run completed in 18.3s" }],
  },
  {
    id: "run_00212", workflow_id: "wf_research", workflow_name: "Research → Writer Chain",
    state: "failed", started_at: "13:44:10", duration_ms: 6100, triggered_by: "manual",
    node_states: { n1: "success", n2: "failed", n3: "skipped" },
    log: [{ ts: "13:44:16", node: "RESEARCH", level: "error", text: "Worker returned 502 after retry #3." }],
  },
  {
    id: "run_00211", workflow_id: "wf_ingest", workflow_name: "Data Ingestion Pipeline",
    state: "paused", started_at: "13:22:00", duration_ms: 42000, triggered_by: "webhook",
    node_states: { n1: "success", n2: "success", n3: "success", n4: "success", n5: "running", n6: "queued" },
    log: [{ ts: "13:22:42", node: "APPROVAL", level: "warn", text: "Waiting for ops-lead approval..." }],
  },
];

type State = {
  workers: Worker[];
  jobs: Job[];
  workflows: Workflow[];
  runs: WorkflowRun[];
  updateWorkflow: (id: string, patch: Partial<Workflow>) => void;
  addWorkflow: (wf: Workflow) => void;
  removeWorkflow: (id: string) => void;
  addRun: (workflowId: string) => string;
  addWorker: (w: Omit<Worker, "id" | "status" | "last_seen">) => void;
};

export const useAtlas = create<State>((set, get) => ({
  workers: initialWorkers,
  jobs: initialJobs,
  workflows: initialWorkflows,
  runs: initialRuns,
  updateWorkflow: (id, patch) =>
    set((s) => ({ workflows: s.workflows.map((w) => (w.id === id ? { ...w, ...patch, updated_at: "just now" } : w)) })),
  addWorkflow: (wf) => set((s) => ({ workflows: [wf, ...s.workflows] })),
  removeWorkflow: (id) => set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) })),
  addRun: (workflowId) => {
    const wf = get().workflows.find((w) => w.id === workflowId);
    if (!wf) return "";
    const id = `run_${String(215 + get().runs.length).padStart(5, "0")}`;
    const node_states = Object.fromEntries(wf.nodes.map((n, i) => [n.id, i === 0 ? "running" : "queued"])) as WorkflowRun["node_states"];
    const run: WorkflowRun = {
      id, workflow_id: wf.id, workflow_name: wf.name, state: "running",
      started_at: new Date().toLocaleTimeString(), duration_ms: 0, triggered_by: "manual",
      node_states,
      log: [{ ts: new Date().toLocaleTimeString(), node: "SYSTEM", level: "info", text: `Run ${id} started.` }],
    };
    set((s) => ({ runs: [run, ...s.runs] }));
    return id;
  },
  addWorker: (w) =>
    set((s) => ({
      workers: [
        ...s.workers,
        { ...w, id: `wrk_${String(s.workers.length + 1).padStart(2, "0")}`, status: "online", last_seen: now() },
      ],
    })),
}));

export const NODE_KINDS: { kind: NodeKind; label: string; hint: string }[] = [
  { kind: "trigger", label: "Trigger", hint: "Webhook, cron, or event" },
  { kind: "worker", label: "Worker Job", hint: "Run a prompt on a worker" },
  { kind: "condition", label: "Condition", hint: "Route by expression" },
  { kind: "loop", label: "Loop", hint: "Iterate over items" },
  { kind: "fanout", label: "Fan-out", hint: "Run branches in parallel" },
  { kind: "join", label: "Join", hint: "All / Any / Quorum" },
  { kind: "approval", label: "Approval", hint: "Human gate" },
  { kind: "manager", label: "Manager", hint: "LLM proposes next actions" },
];