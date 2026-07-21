/**
 * Explicit states for server-backed screens.
 *
 * Every server-backed page must render loading, error, forbidden, and not-found distinctly —
 * a forbidden response in particular must never be disguised as "not found" or as a sign-out,
 * because that hides a real permission problem from the operator.
 *
 * Colours come from the design tokens in `src/styles.css` only.
 */

import { AlertTriangle, Loader2, Lock, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

import { describeAtlasError, type ClientAtlasError } from "@/lib/atlas-mappers";

function StateShell({
  icon,
  title,
  description,
  tone = "muted",
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  tone?: "muted" | "danger" | "warning";
  children?: ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-md text-center">
        <div className={`mx-auto flex h-11 w-11 items-center justify-center ${toneClass}`}>
          {icon}
        </div>
        <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        {children ? <div className="mt-6 flex justify-center gap-2">{children}</div> : null}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="flex min-h-[60vh] flex-1 items-center justify-center px-6 py-12"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span className="font-mono text-xs uppercase tracking-widest">{label}</span>
      </div>
    </div>
  );
}

export function ForbiddenState({ description }: { description?: string }) {
  return (
    <StateShell
      icon={<Lock className="h-6 w-6" aria-hidden="true" />}
      tone="warning"
      title="Not allowed"
      description={
        description ??
        "Your Atlas role does not permit this. Ask an administrator if you need access."
      }
    />
  );
}

export function NotFoundState({ description }: { description?: string }) {
  return (
    <StateShell
      icon={<SearchX className="h-6 w-6" aria-hidden="true" />}
      title="Not found"
      description={description ?? "Atlas has no record of the thing you asked for."}
    />
  );
}

/**
 * Marks a page whose content is scaffold, not Atlas data.
 *
 * Several pages still render the placeholder arrays the original mock-up shipped with — a
 * per-worker dollar cost, an audit log of events that never happened, an instance name and
 * version that contradict the real ones on the dashboard. Left unlabelled, an operator has no
 * way to tell them apart from the pages that now read Atlas, and the plausible ones are the
 * dangerous ones: a fabricated cost or audit trail can be acted on.
 *
 * This is a stopgap, not the fix. The fix is wiring each page to its Atlas endpoint (Phase 5).
 * Until then the page says what it is, in the tone of a warning rather than a footnote.
 */
export function PlaceholderNotice({ endpoint }: { endpoint?: string }) {
  return (
    <div
      role="status"
      className="mb-6 flex gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <div className="text-xs leading-relaxed text-foreground">
        <span className="font-semibold">Not connected to Atlas yet.</span> Everything below is
        placeholder data from the original mock-up, and the actions on this page do nothing.
        {endpoint ? (
          <>
            {" "}
            Atlas serves this from <code className="font-mono">{endpoint}</code>; wiring it up is
            still to come.
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Renders any normalised Atlas failure, choosing the presentation from its kind so that a
 * permission problem and an outage never look alike.
 */
export function AtlasErrorState({
  error,
  onRetry,
}: {
  error: ClientAtlasError;
  onRetry?: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    if (error.kind === "unauthorized") {
      void router.navigate({ to: "/auth" });
    }
  }, [error.kind, router]);

  if (error.kind === "forbidden") {
    return <ForbiddenState description={error.message} />;
  }
  if (error.kind === "not_found") {
    return <NotFoundState />;
  }

  const { title, description, retryable } = describeAtlasError(error);

  return (
    <StateShell
      icon={<AlertTriangle className="h-6 w-6" aria-hidden="true" />}
      tone="danger"
      title={title}
      description={description}
    >
      {retryable && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Try again
        </button>
      ) : null}
    </StateShell>
  );
}
