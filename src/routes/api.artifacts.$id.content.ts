/**
 * Same-origin transport glue for `GET /api/artifacts/{id}/content`.
 *
 * This exists for one reason: the Atlas bearer must never reach browser code or a URL. A plain
 * `<a href>` to Atlas would need the token in the query string; `fetch` from the browser would
 * need it in a header. So the browser asks this origin, and the Authorization header is added
 * here, server-side, from the sealed session cookie.
 *
 * The `server` property is the only `createFileRoute` prop in this file, which is what makes
 * the whole route server-only: TanStack Start prunes such a subtree out of the client route
 * tree entirely, so importing `*.server.ts` below never reaches the browser bundle.
 *
 * There is no domain logic here and nothing is cached. The only thing this adds to Atlas's
 * bytes is a usable filename: Atlas's own `Content-Disposition` hardcodes the ASCII filename
 * `download` (`atlas/app.py:939`), so a browser that ignores the RFC 5987 `filename*` saves
 * every artifact under the same extensionless name. The name is rebuilt from the artifact's
 * own `metadata.filename` or collected-file `metadata.relpath`, read from Atlas — never from the
 * request.
 */

import { createFileRoute } from "@tanstack/react-router";

import { atlasDownloadArtifact, atlasGetArtifact } from "@/lib/atlas-api.server";
import { requireAtlasToken } from "@/lib/auth.server";
import { transportErrorResponse } from "@/lib/transport-error.server";

/**
 * Reduces a filename to something safe to place inside a quoted header parameter.
 *
 * Anything outside printable ASCII, plus the quote, backslash, and path separators, would let
 * a filename Atlas stored break out of the parameter or suggest a path. The UTF-8 form in
 * `filename*` carries the real name for browsers that read it.
 */
function asciiFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["]/g, "_")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "artifact";
}

function safeRelpathBasename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const basename = value.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim() ?? "";
  if (basename === "" || basename === "." || basename === "..") return null;
  return basename;
}

export const Route = createFileRoute("/api/artifacts/$id/content")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          // Authentication is enforced here, not by any route guard: this URL is reachable
          // directly over HTTP, and Atlas re-checks the role behind the bearer on both calls.
          const token = await requireAtlasToken();
          const artifact = await atlasGetArtifact(token, params.id);
          const { bytes, contentType } = await atlasDownloadArtifact(token, params.id);

          const metadata = artifact.metadata ?? {};
          const filename =
            typeof metadata.filename === "string" && metadata.filename.trim().length > 0
              ? metadata.filename
              : (safeRelpathBasename(metadata.relpath) ?? artifact.key);

          return new Response(bytes, {
            headers: {
              "content-type": contentType,
              "content-length": String(bytes.byteLength),
              "content-disposition": `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
              // Authenticated bytes: never let a shared cache keep a copy.
              "cache-control": "private, no-store",
            },
          });
        } catch (error) {
          return transportErrorResponse(error, "The download could not be completed.");
        }
      },
    },
  },
});
