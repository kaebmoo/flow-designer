/**
 * Safe server-side error logging.
 *
 * A raw `console.error(error)` prints the whole object: an `AtlasError`'s `cause` can embed a
 * socket error naming the private Atlas origin, and an Atlas 5xx message is a raw Python
 * exception string. This helper logs a bounded diagnostic instead — error kind, HTTP status,
 * and for non-Atlas failures the name/message/stack of our own code — and never a `cause`
 * chain, a header, a cookie, a request body, or Atlas's 5xx text.
 *
 * Client-safe by construction (no imports, no secrets): `start.ts` may be pulled into both
 * bundles, so this module must not drag a `*.server.ts` dependency with it. The AtlasError
 * check is structural for the same reason.
 */

interface AtlasErrorShape {
  kind: string;
  status?: number;
  fromAtlas?: boolean;
  message: string;
}

function isAtlasErrorShaped(error: unknown): error is Error & AtlasErrorShape {
  return (
    error instanceof Error &&
    error.name === "AtlasError" &&
    typeof (error as Partial<AtlasErrorShape>).kind === "string"
  );
}

export function logServerError(scope: string, error: unknown): void {
  if (isAtlasErrorShaped(error)) {
    // 5xx text is a raw Python exception; anything not authored by Atlas for the caller is
    // our own generic copy and adds nothing. Log the classification, not the words.
    const safeMessage = error.fromAtlas && error.kind !== "server" ? ` ${error.message}` : "";
    const status = error.status === undefined ? "" : ` status=${error.status}`;
    console.error(`[${scope}] AtlasError kind=${error.kind}${status}${safeMessage}`);
    return;
  }
  if (error instanceof Error) {
    // `error.stack` alone: printing the Error object would let the runtime append the whole
    // `cause` chain, which is exactly what must stay out of the log.
    console.error(`[${scope}] ${error.stack ?? `${error.name}: ${error.message}`}`);
    return;
  }
  if (typeof error === "string") {
    console.error(`[${scope}] ${error}`);
    return;
  }
  // A thrown object could be a Response or carry anything; classify it, don't serialise it.
  console.error(`[${scope}] non-Error throw of type ${typeof error}`);
}
