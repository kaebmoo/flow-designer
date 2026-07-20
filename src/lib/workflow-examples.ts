import type { WorkflowGraph, WorkflowPolicy } from "./workflow-graph";

export interface WorkflowExample {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  policy: WorkflowPolicy;
}

const always = { type: "always" } as const;

/**
 * Atlas-native starter workflows based on the four flows in the design handoff.
 *
 * These stay as client-side templates until an operator clicks Create example. The create
 * action persists the exact graph through Atlas's normal workflow mutation, so examples never
 * become a second mock workflow collection or get silently seeded on every page load.
 */
export const WORKFLOW_EXAMPLES: readonly WorkflowExample[] = [
  {
    id: "daily-news-brief",
    name: "Daily News Brief",
    description: "Research, write, fact-check, and publish a morning brief after sign-off.",
    graph: {
      start: "research_news",
      nodes: [
        {
          id: "research_news",
          type: "worker",
          prompt: "Find the 3 most important stories about {topic} today. List facts with sources.",
          outputs: ["research_notes"],
        },
        {
          id: "write_brief",
          type: "worker",
          prompt:
            "Write a short, friendly morning brief from {research_notes}. Keep it under 300 words.",
          outputs: ["draft"],
        },
        {
          id: "fact_check",
          type: "worker",
          prompt:
            'Check every claim in {draft}. Return JSON with verdict "approved" or "needs_work".',
          outputs: ["fact_check"],
          output_format: "json",
        },
        {
          id: "manager_signoff",
          type: "human_gate",
          label: "Manager sign-off",
          reason: "Review the morning brief before it goes out.",
        },
        {
          id: "publish_brief",
          type: "worker",
          prompt: "Publish {draft} to the configured morning brief channel.",
          outputs: ["post_link"],
        },
      ],
      edges: [
        { from: "research_news", to: "write_brief", condition: always },
        { from: "write_brief", to: "fact_check", condition: always },
        {
          from: "fact_check",
          to: "manager_signoff",
          condition: {
            type: "artifact_equals",
            artifact: "fact_check",
            path: "verdict",
            value: "approved",
          },
        },
        {
          from: "fact_check",
          to: "write_brief",
          condition: {
            type: "artifact_equals",
            artifact: "fact_check",
            path: "verdict",
            value: "needs_work",
          },
        },
        { from: "manager_signoff", to: "publish_brief", condition: always },
      ],
    },
    policy: { max_iterations: 3 },
  },
  {
    id: "customer-complaint-handler",
    name: "Customer Complaint Handler",
    description: "Summarize each complaint, let a person choose the response, then record it.",
    graph: {
      start: "read_complaint",
      nodes: [
        {
          id: "read_complaint",
          type: "worker",
          prompt:
            "Summarize this complaint about {topic}: what happened, who is affected, and how urgent it is.",
          outputs: ["summary"],
        },
        {
          id: "choose_response",
          type: "human_gate",
          label: "How should we respond?",
          reason: "Read the complaint summary and choose the response path.",
          choices: [
            { id: "refund", label: "Apology + refund" },
            { id: "escalate", label: "Escalate to a manager" },
            { id: "more_info", label: "Ask for more info" },
          ],
        },
        {
          id: "send_refund",
          type: "worker",
          prompt: "Write a warm apology for {summary} and start a refund.",
          outputs: ["reply"],
        },
        {
          id: "escalate_complaint",
          type: "worker",
          prompt: "Write a handover note for the duty manager from {summary}.",
          outputs: ["handover"],
        },
        {
          id: "request_more_info",
          type: "worker",
          prompt: "Write a polite request for the missing details in {summary}.",
          outputs: ["request"],
        },
        { id: "response_done", type: "join", mode: "any" },
        {
          id: "record_complaint",
          type: "worker",
          prompt: "Log the complaint and our response in the CRM.",
          outputs: ["crm_id"],
        },
      ],
      edges: [
        { from: "read_complaint", to: "choose_response", condition: always },
        {
          from: "choose_response",
          to: "send_refund",
          condition: { type: "human_selected", choice: "refund" },
        },
        {
          from: "choose_response",
          to: "escalate_complaint",
          condition: { type: "human_selected", choice: "escalate" },
        },
        {
          from: "choose_response",
          to: "request_more_info",
          condition: { type: "human_selected", choice: "more_info" },
        },
        { from: "send_refund", to: "response_done", condition: always },
        { from: "escalate_complaint", to: "response_done", condition: always },
        { from: "request_more_info", to: "response_done", condition: always },
        { from: "response_done", to: "record_complaint", condition: always },
      ],
    },
    policy: {},
  },
  {
    id: "weekly-sales-report",
    name: "Weekly Sales Report",
    description: "Gather the numbers, analyze trends, draft the report, and send after sign-off.",
    graph: {
      start: "gather_numbers",
      nodes: [
        {
          id: "gather_numbers",
          type: "worker",
          prompt: "Collect the latest sales figures for {topic} from the reports workspace.",
          outputs: ["figures"],
        },
        {
          id: "analyze_trends",
          type: "worker",
          prompt: "Find the 3 biggest changes in {figures} and explain why they matter.",
          outputs: ["insights"],
        },
        {
          id: "draft_report",
          type: "worker",
          prompt: "Write a one-page report from {insights} for the leadership team.",
          outputs: ["report"],
        },
        {
          id: "manager_signoff",
          type: "human_gate",
          label: "Manager sign-off",
          reason: "Review the weekly report before it is sent.",
        },
        {
          id: "send_report",
          type: "worker",
          prompt: "Send {report} to the sales leadership list.",
          outputs: ["sent_to"],
        },
      ],
      edges: [
        { from: "gather_numbers", to: "analyze_trends", condition: always },
        { from: "analyze_trends", to: "draft_report", condition: always },
        { from: "draft_report", to: "manager_signoff", condition: always },
        { from: "manager_signoff", to: "send_report", condition: always },
      ],
    },
    policy: {},
  },
  {
    id: "blog-post-pipeline",
    name: "Blog Post Pipeline",
    description: "Outline, write, review, revise when needed, and publish a blog post.",
    graph: {
      start: "outline_post",
      nodes: [
        {
          id: "outline_post",
          type: "worker",
          prompt: "Outline a blog post about {topic} with no more than 5 sections.",
          outputs: ["outline"],
        },
        {
          id: "write_post",
          type: "worker",
          prompt: "Write the post from {outline} in a clear, friendly voice.",
          outputs: ["post"],
        },
        {
          id: "review_post",
          type: "worker",
          prompt: 'Review {post}. Return JSON with verdict "approved" or "needs_work".',
          outputs: ["review"],
          output_format: "json",
        },
        {
          id: "final_approval",
          type: "human_gate",
          label: "Final approval",
          reason: "Take a last look before the post goes live.",
        },
        {
          id: "publish_post",
          type: "worker",
          prompt: "Publish {post} to the configured blog channel.",
          outputs: ["publish_link"],
        },
      ],
      edges: [
        { from: "outline_post", to: "write_post", condition: always },
        { from: "write_post", to: "review_post", condition: always },
        {
          from: "review_post",
          to: "final_approval",
          condition: {
            type: "artifact_equals",
            artifact: "review",
            path: "verdict",
            value: "approved",
          },
        },
        {
          from: "review_post",
          to: "write_post",
          condition: {
            type: "artifact_equals",
            artifact: "review",
            path: "verdict",
            value: "needs_work",
          },
        },
        { from: "final_approval", to: "publish_post", condition: always },
      ],
    },
    policy: { max_iterations: 3 },
  },
];
