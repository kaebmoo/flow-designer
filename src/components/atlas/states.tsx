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
