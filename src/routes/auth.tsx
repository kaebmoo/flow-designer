import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
import { getIdentityFn, loginFn } from "@/lib/auth.functions";
import type { ClientAtlasError } from "@/lib/atlas-mappers";

export const Route = createFileRoute("/auth")({
  /**
   * Navigation convenience only: an already-signed-in operator should not land on a login
   * form. This is not a security boundary — nothing protected renders here.
   */
  loader: async () => {
    const result = await getIdentityFn();
    if (result.status === "authenticated") {
      throw redirect({ to: "/dashboard" });
    }
    return result.status === "error" ? { error: result.error } : { error: null };
  },
  component: AuthPage,
  pendingComponent: () => <LoadingState label="Checking session" />,
  errorComponent: ({ error }) => (
    <AtlasErrorState error={{ kind: "server", message: error.message }} />
  ),
  notFoundComponent: () => <NotFoundState />,
});

function AuthPage() {
  const { error: loaderError } = Route.useLoaderData();
  const router = useRouter();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ClientAtlasError | null>(loaderError);

  /**
   * Marks the form once React has taken over, exposed as `data-hydrated` on the form element.
   *
   * Until this flips, a submit is handled natively by the browser rather than by `onSubmit`,
   * so it POSTs and reloads instead of signing in. Browser tests wait on this attribute to
   * drive the form deterministically; without it they race hydration and fail intermittently.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  /**
   * The fields are deliberately uncontrolled, and the values are read from the DOM at submit
   * time via FormData.
   *
   * This page is server-rendered, so the inputs exist and accept typing before React hydrates.
   * With React-controlled inputs, hydration takes ownership and resets each field to its state
   * value — silently discarding whatever the operator had already typed, most visibly the
   * autofocused username. Uncontrolled inputs let that early input survive.
   *
   * It also means the password never enters React state at all: it lives only in the DOM node
   * until submit, and the form is reset immediately afterwards.
   */
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    // Caught here so an empty field reads as "fill this in" rather than falling through to
    // the server validator, whose thrown error would surface as a misleading network failure.
    if (username.length === 0 || password.length === 0) {
      setError({ kind: "validation", message: "Enter both a username and a password." });
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await loginFn({ data: { username, password } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Drop the credentials from the DOM as soon as they are no longer needed.
      form.reset();
      await router.invalidate();
      await router.navigate({ to: "/dashboard" });
    } catch {
      setError({
        kind: "network",
        message: "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // A 401 from the login endpoint means bad credentials, not an expired session, so it is
  // rendered inline on the form rather than as a sign-out.
  const message =
    error === null
      ? null
      : error.kind === "unauthorized"
        ? "Incorrect username or password."
        : error.kind === "network" || error.kind === "timeout"
          ? "Atlas is unreachable right now. Try again in a moment."
          : error.message;

  return (
    <div className="atlas-grid flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-primary">
            Atlas Control
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Authenticate against the Atlas control plane.
          </p>
        </div>

        {/*
          `method="post"` matters even though `onSubmit` handles every hydrated submit.
          This page is server-rendered, and until React hydrates — or if the JS bundle fails
          to load at all — the browser submits the form natively. A form with no method
          defaults to GET, which would put the typed password into the URL, the address bar,
          browser history, and every access and proxy log in front of the app. Declaring POST
          keeps credentials in the request body in that window. Reproduced with JavaScript
          disabled; guarded by a test in tests/e2e/auth.spec.ts.
        */}
        <form
          method="post"
          data-hydrated={hydrated ? "true" : undefined}
          onSubmit={onSubmit}
          className="rounded-lg border border-border bg-card p-6 shadow-lg"
          noValidate
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="username"
                className="font-mono text-[0.7rem] uppercase tracking-widest text-muted-foreground"
              >
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                autoFocus
                required
                disabled={submitting}
                aria-invalid={message !== null}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-60"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="password"
                className="font-mono text-[0.7rem] uppercase tracking-widest text-muted-foreground"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={submitting}
                aria-invalid={message !== null}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-60"
              />
            </div>
          </div>

          {message !== null ? (
            <p
              role="alert"
              className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Signing in
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p className="mt-6 text-center font-mono text-[0.7rem] uppercase tracking-widest text-muted-foreground">
          Atlas is the authority for every permission
        </p>
      </div>
    </div>
  );
}
