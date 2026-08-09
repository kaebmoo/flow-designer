/**
 * Same-origin transport glue for `POST /api/workflow-runs/{id}/files?key=...`.
 *
 * This exists for the same single reason as the artifact-content route: the Atlas bearer must
 * never reach browser code, and this is a *binary* request — Atlas reads the raw body by
 * `Content-Length` — so it cannot ride the JSON server-function channel. The browser posts the
 * file bytes to this origin; the Authorization header is added here, server-side, from the
 * sealed session cookie.
 *
 * Because the CSRF middleware in `src/start.ts` filters on `handlerType === "serverFn"`, a
 * route handler does NOT inherit it — and this one mutates. So the same evaluation order the
 * framework applies to server functions is enforced by hand before anything else:
 * `Sec-Fetch-Site` wins when present (must be `same-origin`), otherwise `Origin` is matched
 * against `PUBLIC_ORIGIN`, otherwise deny. There is no `allowRequestsWithoutOriginCheck`
 * equivalent here either.
 *
 * No domain logic: key validation is a mirror of Atlas's own rule (which re-validates
 * authoritatively), the size cap fronts Atlas's `ATLAS_MAX_UPLOAD_BYTES` so an oversized body
 * is refused on its header before it is read, and the artifact row in the response is Atlas's,
 * verbatim. The bytes are relayed as a stream — they are never held in this process.
 */

import { createFileRoute } from "@tanstack/react-router";

import { atlasUploadRunFile } from "@/lib/atlas-api.server";
import { requireAtlasToken } from "@/lib/auth.server";
import { matchesConfiguredOrigin } from "@/lib/csrf-origin";
import { RUN_FILE_KEY_RE } from "@/lib/run-file-keys";
import { transportBadRequest, transportErrorResponse } from "@/lib/transport-error.server";

/**
 * The per-file cap, read at request time from the same variable name Atlas uses so one shared
 * environment configures both sides. Atlas stays the authority: it re-checks the size against
 * its own `ATLAS_MAX_UPLOAD_BYTES` (`atlas/config.py:70`, enforced in `atlas/app.py:1156`
 * against `Content-Length` before it reads a byte), and when the two disagree its refusal is
 * what the operator is shown.
 *
 * 32 MiB is a chosen policy number, not a discovered one. The hard ceiling above it belongs to
 * thClaws: `MAX_INPUT_TOTAL_BYTES` is a compile-time 64 MiB for the *whole* `push_files` batch
 * (`crates/core/src/api_v1/artifacts.rs:43`, which Atlas's `ATLAS_SYNC_MAX_BYTES` is pinned
 * to), so 32 MiB still lets two files share one handoff while 64 would not.
 *
 * This route previously capped at 64 MiB — that is the batch ceiling, applied to a single file
 * by mistake, and Atlas's own default is 10 MiB. Raising the number is only safe because the
 * body is now relayed as a stream; see the handler.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function maxUploadBytes(): number {
  const configured = Number(process.env.ATLAS_MAX_UPLOAD_BYTES ?? "");
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

function tooLargeMessage(limit: number): string {
  return `The file is larger than the ${Math.floor(limit / (1024 * 1024))} MiB upload limit.`;
}

/** The same evaluation order `createCsrfMiddleware` applies, restated for a route handler. */
function isSameOriginRequest(request: Request): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite !== null) return secFetchSite === "same-origin";
  const origin = request.headers.get("origin");
  if (origin !== null) return matchesConfiguredOrigin(origin, process.env.PUBLIC_ORIGIN);
  return false;
}

export const Route = createFileRoute("/api/workflow-runs/$id/files")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          if (!isSameOriginRequest(request)) {
            // Plain text like every other refusal this route can answer with: one content type
            // per route is what lets the caller read a message at all.
            return new Response("cross-origin request refused", {
              status: 403,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            });
          }
          // Authentication is enforced here, not by any route guard: this URL is reachable
          // directly over HTTP, and Atlas re-checks the role behind the bearer.
          const token = await requireAtlasToken();

          const key = new URL(request.url).searchParams.get("key") ?? "";
          if (!RUN_FILE_KEY_RE.test(key)) {
            return transportBadRequest(
              "The file key must match [A-Za-z_][A-Za-z0-9_.-]{0,127} (no slashes).",
            );
          }
          const limit = maxUploadBytes();
          // Decided on the header, before the body is touched — the same order Atlas uses. An
          // oversized upload is refused without this process reading, let alone holding, it.
          const declaredLength = Number(request.headers.get("content-length") ?? "");
          if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
            return transportBadRequest("A non-empty request body with Content-Length is required.");
          }
          if (declaredLength > limit) {
            return transportBadRequest(tooLargeMessage(limit));
          }
          // Relayed as a stream rather than buffered: this process's memory no longer scales
          // with the cap, which is what lets the cap be raised at all. There is deliberately no
          // post-read size backstop any more — buffering the body to measure it would undo the
          // point. A body that disagrees with its own Content-Length fails at the far end:
          // Atlas reads exactly that many bytes and rejects a short one as incomplete.
          const body = request.body;
          if (body === null) {
            return transportBadRequest("A non-empty request body with Content-Length is required.");
          }

          // The browser percent-encodes the filename (fetch refuses non-Latin-1 header bytes,
          // so a Thai name cannot travel raw). Decode to the real name here; the Atlas client
          // re-encodes for its own hop. An undecodable value is kept as-is rather than failing
          // the upload over display metadata.
          let filename = (request.headers.get("x-filename") ?? "").trim() || "upload.bin";
          try {
            filename = decodeURIComponent(filename);
          } catch {
            // keep the raw value — it is only a display name
          }
          const contentType =
            request.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
            "application/octet-stream";

          const artifact = await atlasUploadRunFile(token, {
            runId: params.id,
            key,
            filename,
            contentType,
            body,
            contentLength: declaredLength,
          });

          return new Response(JSON.stringify({ artifact }), {
            status: 201,
            headers: { "content-type": "application/json", "cache-control": "private, no-store" },
          });
        } catch (error) {
          return transportErrorResponse(error, "The file could not be uploaded.");
        }
      },
    },
  },
});
