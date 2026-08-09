/**
 * Artifact keys for files uploaded onto a workflow run.
 *
 * Atlas's rule for `POST /api/workflow-runs/{id}/files?key=…` is
 * `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$` (`atlas/app.py::_upload_workflow_file`) — no slashes, and
 * 128 characters at most. A browser filename satisfies almost none of that, so it is mapped
 * here; the real name still travels intact in the percent-encoded `x-filename` header and is
 * what Atlas stores as the artifact's display filename.
 *
 * This lives in `lib/` because both sides of the upload need it: the page derives the key, and
 * the transport route re-validates it against the same rule Atlas will apply.
 */

/** Mirror of Atlas's key rule. Atlas re-validates authoritatively on every upload. */
export const RUN_FILE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

/** Atlas's maximum: one leading character plus 127 more. */
export const RUN_FILE_KEY_MAX_LENGTH = 128;

/** `upload_` both satisfies the leading-character rule and makes the batch matchable by
 *  one edge glob (`upload_*`) for `push_files`. */
const PREFIX = "upload_";

/**
 * The key a filename maps to before any collision is resolved.
 *
 * Every character outside Atlas's class collapses to a single `_`, so a name that is entirely
 * outside it — any Thai filename, for instance — contributes nothing but its extension. That
 * is exactly why this is not a unique key on its own; see `uniqueRunFileKey`.
 */
export function runFileKeyFor(filename: string): string {
  const sanitized = filename
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, RUN_FILE_KEY_MAX_LENGTH - PREFIX.length);
  return `${PREFIX}${sanitized || "file"}`;
}

/** Appends a suffix while staying inside Atlas's length limit. */
function withSuffix(base: string, suffix: string): string {
  return `${base.slice(0, RUN_FILE_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** The first key not already taken on the run: the plain key, else `_2`, `_3`, … */
function firstFreeKey(filename: string, taken: ReadonlySet<string>): string {
  const base = runFileKeyFor(filename);
  if (!taken.has(base)) return base;
  // Bounded by construction: among `taken.size + 1` distinct candidates at least one is free.
  for (let ordinal = 2; ordinal <= taken.size + 2; ordinal += 1) {
    const candidate = withSuffix(base, `_${ordinal}`);
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable while the loop bound holds; kept so the function has no implicit undefined.
  return withSuffix(base, `_${taken.size + 2}`);
}

/** One `upload_*` artifact already on the run, as far as key selection is concerned. */
export interface ExistingRunFile {
  key: string;
  /** Atlas's stored display name (`metadata.filename`), null when it holds none. */
  filename: string | null;
}

export interface RunFileKeyChoice {
  key: string;
  /** True when this upload lands on a key the run already holds, replacing what is there. */
  replaces: boolean;
}

/**
 * The key an upload should use, and whether it replaces something.
 *
 * Two different behaviours ride on one Atlas mechanism, and the whole point of this function is
 * to tell them apart:
 *
 * - **Re-uploading a corrected file.** Reusing the key is a genuine end-to-end replace, and it
 *   is Atlas's design rather than an accident: `list_artifacts` orders newest-first with a
 *   rowid tiebreaker written for exactly this case (`atlas/db.py:2004`), and `push_files`
 *   collapses its matches through `latest_by_key[key] = art` so the worker receives only the
 *   newest (`atlas/workflows.py:1618-1631`). Allocating a fresh key instead would send the
 *   worker the stale file alongside the corrected one — with no way to withdraw it, because
 *   Atlas exposes no artifact delete.
 * - **Two different files whose names sanitise alike.** `a b.txt` and `a_b.txt` both reduce to
 *   `upload_a_b.txt`, and any two Thai filenames reduce to nothing but their extension. Here
 *   the same mechanism is data loss: the operator attached two files and the worker would
 *   receive one.
 *
 * The key cannot distinguish them, but the *filename* can — Atlas keeps it verbatim. So a
 * matching filename replaces, and anything else takes a fresh key.
 *
 * `existing` must carry the run's `upload_*` artifacts plus the files already sent earlier in
 * the same batch. Two operators uploading at once still race; Atlas is the authority on the
 * outcome and the caller surfaces whatever it answers.
 */
export function chooseRunFileKey(
  filename: string,
  existing: readonly ExistingRunFile[],
): RunFileKeyChoice {
  // Only the upload namespace: a collected output can carry the same display name, and its key
  // is outside the `upload_*` glob that hands inputs to a worker.
  const uploads = existing.filter((file) => file.key.startsWith(PREFIX));
  const sameName = uploads.find((file) => file.filename === filename);
  if (sameName) return { key: sameName.key, replaces: true };
  return { key: firstFreeKey(filename, new Set(uploads.map((file) => file.key))), replaces: false };
}
