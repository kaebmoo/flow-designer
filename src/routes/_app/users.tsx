import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Copy, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { useReturnFocus } from "@/hooks/use-return-focus";
import { AtlasErrorState, ForbiddenState, LoadingState } from "@/components/atlas/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { isClientAtlasError, type ApiTokenView, type UserAdminView } from "@/lib/atlas-mappers";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import {
  AtlasMutationError,
  useCreateUser,
  useDeleteUser,
  useMintApiToken,
  useRenameApiToken,
  useRevokeApiToken,
  useUpdateUser,
} from "@/lib/atlas-mutations";
import { apiTokensQuery, usersQuery } from "@/lib/atlas-queries";
import { ATLAS_ROLES, ATLAS_USER_STATUSES } from "@/lib/atlas-types";

const appRoute = getRouteApi("/_app");

/** Matches the height and focus ring of `Input`, which has no `select` counterpart. */
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const Route = createFileRoute("/_app/users")({
  component: UsersPage,
  head: () => ({ meta: [{ title: "Users & Tokens · Atlas Control" }] }),
});

/**
 * Atlas user and API-token administration — admin only, and Atlas is the one enforcing that.
 *
 * Every read and mutation here goes to Atlas's `/api/users` and `/api/tokens` routes, all of
 * which require the `admin` permission; a non-admin gets Atlas's 403 rendered as a forbidden
 * page. Hiding buttons by role is a UX courtesy only.
 *
 * The action is **Create user** — Atlas has no invitation contract (no email, no invite
 * tokens), so an "Invite" button would promise a flow that does not exist.
 */
function UsersPage() {
  const identity = appRoute.useLoaderData();
  const currentUsername = identity.status === "authenticated" ? identity.identity.username : null;
  const currentSessionTokenId =
    identity.status === "authenticated" ? identity.identity.sessionTokenId : undefined;

  const users = useQuery(usersQuery());
  const tokens = useQuery(apiTokensQuery());

  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserAdminView | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserAdminView | null>(null);
  const deleteUserFocus = useReturnFocus();
  const [mintOpen, setMintOpen] = useState(false);
  const [renameToken, setRenameToken] = useState<ApiTokenView | null>(null);
  const [revokeToken, setRevokeToken] = useState<ApiTokenView | null>(null);
  const revokeTokenFocus = useReturnFocus();

  if (users.isPending || tokens.isPending) {
    return (
      <>
        <PageHeader title="Users & Tokens" subtitle="Atlas identities and API access." />
        <LoadingState label="Loading users and tokens" />
      </>
    );
  }

  // Both queries hit admin-only routes, so a non-admin fails on the first one. One explicit
  // forbidden page beats two error tables saying the same thing.
  const forbidden =
    (users.isError && isClientAtlasError(users.error) && users.error.kind === "forbidden") ||
    (tokens.isError && isClientAtlasError(tokens.error) && tokens.error.kind === "forbidden");
  if (forbidden) {
    return (
      <>
        <PageHeader title="Users & Tokens" subtitle="Atlas identities and API access." />
        <ForbiddenState description="User and API token management requires the Atlas admin role. Atlas refused this read; nothing on this page is available to your role." />
      </>
    );
  }

  if (users.isError || tokens.isError) {
    const error = users.isError ? users.error : tokens.error;
    return (
      <>
        <PageHeader title="Users & Tokens" subtitle="Atlas identities and API access." />
        <AtlasErrorState
          error={toClientAtlasError(error)}
          onRetry={() => {
            void users.refetch();
            void tokens.refetch();
          }}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Users & Tokens"
        subtitle="Atlas identities and API access. All changes are enforced and audited by Atlas."
        actions={
          <Button size="sm" onClick={() => setCreateUserOpen(true)}>
            <Plus className="size-4" /> Create user
          </Button>
        }
      />
      <div className="flex-1 space-y-8 overflow-y-auto px-8 py-6">
        <section>
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Users
          </h2>
          <DataTable
            rows={users.data}
            rowKey={(user) => user.id}
            empty="Atlas has no users. (You are signed in, so this should be unreachable.)"
            columns={[
              {
                key: "username",
                header: "Username",
                render: (user: UserAdminView) => (
                  <span className="font-medium">
                    {user.username}
                    {user.username === currentUsername ? (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        you
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: "role",
                header: "Role",
                render: (user: UserAdminView) => (
                  <span className="font-mono text-[10px] uppercase tracking-widest">
                    {user.roleLabel}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (user: UserAdminView) => (
                  <StatusPill tone={user.status.tone}>{user.status.label}</StatusPill>
                ),
              },
              {
                key: "tokenCount",
                header: "Live tokens",
                render: (user: UserAdminView) => (
                  <span className="font-mono text-xs tabular-nums">{user.tokenCount}</span>
                ),
              },
              {
                key: "createdAt",
                header: "Created",
                render: (user: UserAdminView) => (
                  <span className="font-mono text-xs text-muted-foreground">{user.createdAt}</span>
                ),
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (user: UserAdminView) => (
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${user.username}`}
                      onClick={() => setEditUser(user)}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${user.username}`}
                      onClick={(event) => {
                        deleteUserFocus.capture(event.currentTarget);
                        setDeleteUser(user);
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              API tokens
            </h2>
            <Button size="sm" variant="outline" onClick={() => setMintOpen(true)}>
              <KeyRound className="size-3.5" /> Mint token
            </Button>
          </div>
          <DataTable
            rows={tokens.data}
            rowKey={(token) => token.id}
            empty="Atlas has issued no API tokens beyond the ones revoked or expired away."
            columns={[
              {
                key: "name",
                header: "Name",
                render: (token: ApiTokenView) => <span className="text-sm">{token.name}</span>,
              },
              {
                key: "username",
                header: "User",
                render: (token: ApiTokenView) => (
                  <span className="font-mono text-xs">{token.username}</span>
                ),
              },
              {
                key: "purpose",
                header: "Purpose",
                render: (token: ApiTokenView) => (
                  <span className="font-mono text-xs uppercase">
                    {token.purpose}
                    {token.id === currentSessionTokenId ? (
                      <span data-testid="current-session-token" className="ml-2 text-primary">
                        current session
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (token: ApiTokenView) => (
                  <StatusPill tone={token.lifecycle === "active" ? "success" : "muted"}>
                    {token.lifecycle}
                  </StatusPill>
                ),
              },
              {
                key: "expiresAt",
                header: "Expires",
                render: (token: ApiTokenView) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {token.expiresAt ?? "never"}
                  </span>
                ),
              },
              {
                key: "lastUsedAt",
                header: "Last used",
                render: (token: ApiTokenView) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {token.lastUsedAt}
                  </span>
                ),
              },
              {
                key: "createdAt",
                header: "Created",
                render: (token: ApiTokenView) => (
                  <span className="font-mono text-xs text-muted-foreground">{token.createdAt}</span>
                ),
              },
              {
                key: "actions",
                header: "",
                className: "text-right",
                render: (token: ApiTokenView) => (
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Rename token ${token.name}`}
                      onClick={() => setRenameToken(token)}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    {token.revoked ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Revoke token ${token.name}`}
                        onClick={(event) => {
                          revokeTokenFocus.capture(event.currentTarget);
                          setRevokeToken(token);
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
          <p className="mt-4 text-xs text-muted-foreground">
            Atlas stores only a hash of each token, so a token's value is shown exactly once — at
            mint time. Revocation is permanent and keeps the row for the audit trail. Note that
            signing in to this UI also mints a session token per session; Atlas can revoke it on
            sign-out, expiry, or when the five-session cap evicts the oldest session.
          </p>
        </section>
      </div>

      {createUserOpen ? (
        <UserFormDialog mode="create" onClose={() => setCreateUserOpen(false)} />
      ) : null}
      {editUser ? (
        <UserFormDialog
          mode="edit"
          user={editUser}
          isSelf={editUser.username === currentUsername}
          onClose={() => setEditUser(null)}
        />
      ) : null}
      {deleteUser ? (
        <DeleteUserDialog
          user={deleteUser}
          isSelf={deleteUser.username === currentUsername}
          onClose={() => {
            setDeleteUser(null);
            deleteUserFocus.restore();
          }}
        />
      ) : null}
      {mintOpen ? <MintTokenDialog users={users.data} onClose={() => setMintOpen(false)} /> : null}
      {renameToken ? (
        <RenameTokenDialog token={renameToken} onClose={() => setRenameToken(null)} />
      ) : null}
      {revokeToken ? (
        <RevokeTokenDialog
          token={revokeToken}
          onClose={() => {
            setRevokeToken(null);
            revokeTokenFocus.restore();
          }}
        />
      ) : null}
    </>
  );
}

function MutationErrorText({ error }: { error: AtlasMutationError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {error.kind === "forbidden"
        ? "Atlas refused this action: it requires the admin permission."
        : error.message}
    </p>
  );
}

/**
 * Create and edit share one form because Atlas's `PUT` is a partial update of the same four
 * fields. On edit, the password field is optional and sent only when filled — an empty field
 * means "keep the current password", matching Atlas's partial-PUT semantics.
 */
function UserFormDialog({
  mode,
  user,
  isSelf = false,
  onClose,
}: {
  mode: "create" | "edit";
  user?: UserAdminView;
  isSelf?: boolean;
  onClose: () => void;
}) {
  const create = useCreateUser();
  const update = useUpdateUser();
  const active = mode === "create" ? create : update;

  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user?.role ?? "viewer");
  const [status, setStatus] = useState(user?.status.label ?? "active");

  const valid = username.trim().length > 0 && (mode === "edit" || password.length > 0);

  const submit = () => {
    if (!valid || active.isPending) return;
    if (mode === "create") {
      create.mutate({ username: username.trim(), password, role, status }, { onSuccess: onClose });
    } else if (user) {
      update.mutate(
        {
          userId: user.id,
          username: username.trim(),
          ...(password.length > 0 ? { password } : {}),
          role,
          status,
        },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create user" : `Edit ${user?.username}`}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Creates an Atlas user with a password. Atlas has no invitation flow — share the credentials directly."
              : "Changes are applied by Atlas immediately; a disabled user's tokens stop authenticating at once."}
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
            <Label htmlFor="user-username">Username</Label>
            <Input
              id="user-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-1"
              autoFocus={mode === "create"}
            />
          </div>
          <div>
            <Label htmlFor="user-password">
              {mode === "create" ? "Password" : "New password (leave blank to keep current)"}
            </Label>
            <Input
              id="user-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="user-role">Role</Label>
              <select
                id="user-role"
                className={`${SELECT_CLASS} mt-1`}
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ATLAS_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="user-status">Status</Label>
              <select
                id="user-status"
                className={`${SELECT_CLASS} mt-1`}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                {ATLAS_USER_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {isSelf && (role !== "admin" || status !== "active") ? (
            <p className="text-xs text-accent">
              This is your own account: demoting or disabling it takes effect on your next request
              and can lock you out of this page.
            </p>
          ) : null}
          <MutationErrorText error={active.isError ? active.error : null} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={active.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || active.isPending}>
              {active.isPending ? "Saving…" : mode === "create" ? "Create user" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({
  user,
  isSelf,
  onClose,
}: {
  user: UserAdminView;
  isSelf: boolean;
  onClose: () => void;
}) {
  const remove = useDeleteUser();
  return (
    // No dismissal while the request is in flight: Escape here would unmount the
    // dialog mid-mutation and hide Atlas's refusal as if nothing had been asked.
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (next || remove.isPending) return;
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user.username}?</AlertDialogTitle>
          <AlertDialogDescription>
            Atlas deletes the user and every API token they hold ({user.tokenCount} live token
            {user.tokenCount === 1 ? "" : "s"}) — including any active dashboard sessions. This
            cannot be undone.
            {isSelf
              ? " This is your own account: deleting it revokes the session you are using right now."
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <MutationErrorText error={remove.isError ? remove.error : null} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(event) => {
              // Keep the dialog open until Atlas confirms; closing optimistically would hide
              // a refusal.
              event.preventDefault();
              remove.mutate({ userId: user.id }, { onSuccess: onClose });
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete user"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Mints a token and shows its value exactly once.
 *
 * The raw token lives in this component's `useState` and nowhere else — deliberately not in a
 * `useMutation` (whose cache would retain the result), not in any query cache, storage, or
 * URL. Closing the dialog discards the state; after that, the value is unrecoverable because
 * Atlas keeps only a hash. That is the contract, and the UI says so.
 */
function MintTokenDialog({ users, onClose }: { users: UserAdminView[]; onClose: () => void }) {
  const mint = useMintApiToken();
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AtlasMutationError | null>(null);
  /** The one-time raw token. Transient component state only; cleared when the dialog closes. */
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  const submit = async () => {
    if (pending || !userId || name.trim().length === 0) return;
    setPending(true);
    setError(null);
    try {
      const result = await mint({
        userId,
        name: name.trim(),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      setMinted(result.apiToken);
    } catch (thrown) {
      setError(
        thrown instanceof AtlasMutationError
          ? thrown
          : new AtlasMutationError({
              error: { kind: "server", message: "The token could not be minted." },
            }),
      );
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{minted ? "Token minted" : "Mint API token"}</DialogTitle>
          <DialogDescription>
            {minted
              ? "Copy it now. Atlas stores only a hash, so this value cannot be shown again — not after closing this dialog, not after a reload."
              : "Issues a bearer token for a user. The value is shown once, immediately after minting."}
          </DialogDescription>
        </DialogHeader>

        {minted ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code
                data-testid="minted-token"
                className="flex-1 break-all rounded border border-border bg-secondary/40 px-3 py-2 font-mono text-xs"
              >
                {minted}
              </code>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                <Copy className="size-3.5" />
                {copied === "copied" ? "Copied" : "Copy"}
              </Button>
            </div>
            {copied === "failed" ? (
              <p className="text-xs text-accent">
                This browser refused clipboard access. Select the token text and copy it by hand.
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={onClose}>Done — discard the value</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div>
              <Label htmlFor="token-user">User</Label>
              <select
                id="token-user"
                className={`${SELECT_CLASS} mt-1`}
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.username} ({user.roleLabel})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="token-name">Token name</Label>
              <Input
                id="token-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. CI pipeline"
                className="mt-1"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="token-expires">Expiry (optional)</Label>
              <Input
                id="token-expires"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">Submitted to Atlas as UTC.</p>
            </div>
            <MutationErrorText error={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !userId || name.trim().length === 0}>
                {pending ? "Minting…" : "Mint token"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameTokenDialog({ token, onClose }: { token: ApiTokenView; onClose: () => void }) {
  const rename = useRenameApiToken();
  const [name, setName] = useState(token.name === "(unnamed)" ? "" : token.name);
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename token</DialogTitle>
          <DialogDescription>
            Renames the metadata only — the token value itself never changes and is never shown.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length === 0 || rename.isPending) return;
            rename.mutate({ tokenId: token.id, name: name.trim() }, { onSuccess: onClose });
          }}
        >
          <div>
            <Label htmlFor="rename-token-name">Name</Label>
            <Input
              id="rename-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1"
              autoFocus
            />
          </div>
          <MutationErrorText error={rename.isError ? rename.error : null} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={rename.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length === 0 || rename.isPending}>
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevokeTokenDialog({ token, onClose }: { token: ApiTokenView; onClose: () => void }) {
  const revoke = useRevokeApiToken();
  return (
    // No dismissal while the request is in flight: Escape here would unmount the
    // dialog mid-mutation and hide Atlas's refusal as if nothing had been asked.
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (next || revoke.isPending) return;
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke &ldquo;{token.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            The token stops authenticating immediately and permanently; the row remains listed as
            revoked for the audit trail. If this is a live dashboard session, that session signs out
            on its next request.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <MutationErrorText error={revoke.isError ? revoke.error : null} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={(event) => {
              event.preventDefault();
              revoke.mutate({ tokenId: token.id }, { onSuccess: onClose });
            }}
          >
            {revoke.isPending ? "Revoking…" : "Revoke token"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
