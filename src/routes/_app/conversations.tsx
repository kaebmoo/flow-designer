import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { DataTable, PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toClientAtlasError, type ConversationView } from "@/lib/atlas-mappers";
import { useCreateConversation, type AtlasMutationError } from "@/lib/atlas-mutations";
import { conversationsQuery } from "@/lib/atlas-queries";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/conversations")({
  component: ConversationsPage,
  head: () => ({ meta: [{ title: "Conversations · Atlas Control" }] }),
});

/**
 * Atlas's conversation surface, exactly as it exists.
 *
 * `GET /api/conversations` is a fixed window of the 100 most recently updated rows — no
 * limit, offset, cursor, total, search, get-by-id, update, or delete exists in Atlas
 * (`atlas/db.py:2245-2248`; the dispatcher has no other conversation route). So this page
 * offers list + create and nothing else: an Edit or Delete button here would promise an
 * operation the backend cannot perform.
 *
 * On session reuse the copy is deliberately hedged: a conversation row is a *grouping
 * record*. The worker-session binding lives in Atlas-internal tables (`session_bindings`,
 * written only when a worker later reports a session, `atlas/jobs.py`), no endpoint exposes
 * it, and a binding may never come to exist. Claiming "jobs share one session" would assert
 * state this API cannot show.
 */
function ConversationsPage() {
  const identity = appRoute.useLoaderData();
  const role = identity.status === "authenticated" ? identity.identity.role : null;
  // UX gate only. Atlas enforces `resources.manage` on the POST regardless of what we render.
  const canCreate = role === "admin" || role === "operator";

  const conversations = useQuery(conversationsQuery());
  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const items = conversations.data?.items;
  const rows = useMemo(() => items ?? [], [items]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.id, row.title, row.workspaceKey, row.company].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [rows, filter]);

  return (
    <>
      <PageHeader
        title="Conversations"
        subtitle="Records that group related jobs. Atlas may reuse an internal worker session for a conversation once a worker reports one."
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New conversation
            </Button>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {conversations.isPending ? (
          <LoadingState label="Loading conversations" />
        ) : conversations.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(conversations.error)}
            onRetry={() => void conversations.refetch()}
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="w-72">
                <Label htmlFor="conversation-filter" className="text-xs text-muted-foreground">
                  Filter loaded rows
                </Label>
                <Input
                  id="conversation-filter"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Title, workspace, company, or id…"
                  className="mt-1"
                />
              </div>
              <p className="pb-2 text-xs text-muted-foreground">
                Filters only the {rows.length} conversations loaded below — Atlas offers no
                server-side search.
              </p>
            </div>

            {rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
                Atlas has no conversations yet.
                {canCreate
                  ? " Create one to group related jobs under a shared conversation id."
                  : " They appear here once created by an operator or by job submission."}
              </div>
            ) : (
              <DataTable
                rows={filtered}
                rowKey={(row) => row.id}
                empty="No loaded conversation matches the filter."
                columns={[
                  {
                    key: "id",
                    header: "Conversation",
                    render: (row: ConversationView) => (
                      <span className="font-mono text-xs text-primary">{row.id}</span>
                    ),
                  },
                  { key: "title", header: "Title" },
                  {
                    key: "workspaceKey",
                    header: "Workspace key",
                    render: (row: ConversationView) => (
                      <span className="font-mono text-xs">{row.workspaceKey || "—"}</span>
                    ),
                  },
                  {
                    key: "company",
                    header: "Company",
                    render: (row: ConversationView) => row.company || "—",
                  },
                  {
                    key: "updatedAt",
                    header: "Updated",
                    className: "text-right",
                    render: (row: ConversationView) => (
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.updatedAt}
                      </span>
                    ),
                  },
                ]}
              />
            )}

            <p className="mt-4 text-xs text-muted-foreground">
              Atlas returns only the 100 most recently updated conversations.{" "}
              {conversations.data.mayHaveMore
                ? "This window is full, so older conversations exist that the API cannot list."
                : "There is no paging, search, or per-conversation detail endpoint."}{" "}
              Conversations cannot be edited or deleted — Atlas has no such operation. Worker
              session bindings are internal to Atlas and not readable through the API, so this page
              cannot show whether a conversation currently has one.
            </p>
          </>
        )}
      </div>

      {createOpen ? (
        <CreateConversationDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      ) : null}
    </>
  );
}

function CreateConversationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateConversation();
  const [title, setTitle] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [company, setCompany] = useState("");

  const submit = () => {
    if (title.trim().length === 0 || create.isPending) return;
    create.mutate(
      { title: title.trim(), workspaceKey: workspaceKey.trim(), company: company.trim() },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>
            Creates an Atlas conversation record. Jobs submitted with its id are grouped together,
            and Atlas may reuse an internal worker session for them once one exists — the API does
            not expose binding status.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div>
            <Label htmlFor="conversation-title">Title</Label>
            <Input
              id="conversation-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="conversation-workspace-key">Workspace key (optional)</Label>
            <Input
              id="conversation-workspace-key"
              value={workspaceKey}
              onChange={(event) => setWorkspaceKey(event.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="conversation-company">Company (optional)</Label>
            <Input
              id="conversation-company"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              className="mt-1"
            />
          </div>
          <MutationError error={create.isError ? create.error : null} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={title.trim().length === 0 || create.isPending}>
              {create.isPending ? "Creating…" : "Create conversation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MutationError({ error }: { error: AtlasMutationError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {error.kind === "forbidden"
        ? "Atlas refused this action: your role does not hold resources.manage."
        : error.message}
    </p>
  );
}
