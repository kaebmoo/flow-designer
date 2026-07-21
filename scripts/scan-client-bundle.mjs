#!/usr/bin/env node
/**
 * Scans the built client bundle for credential-shaped symbols.
 *
 * Run after `bun run build`. Exits 0 when clean, 1 on any forbidden hit, 2 when the positive
 * control fails (which means the scanner is not actually reading bundle text and a green
 * result would be meaningless).
 *
 * The static forbidden list matches the names of server-only symbols and env variables. When
 * `SESSION_SECRET` and/or `ATLAS_API_ORIGIN` are present in this scanner process, their actual
 * values are checked too. Release verification deliberately supplies throwaway canaries so an
 * accidental build-time inline is caught without needing a real deployment secret.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_DIR = ".output/public";
const FORBIDDEN = [
  { label: "SESSION_SECRET symbol", value: "SESSION_SECRET" },
  { label: "ATLAS_API_ORIGIN symbol", value: "ATLAS_API_ORIGIN" },
  { label: "atlasToken symbol", value: "atlasToken" },
  { label: "fd_session cookie name", value: "fd_session" },
  { label: "api_token field", value: "api_token" },
  { label: "token_hash field", value: "token_hash" },
  { label: "requireAtlasToken symbol", value: "requireAtlasToken" },
];
if (process.env.SESSION_SECRET) {
  FORBIDDEN.push({ label: "configured SESSION_SECRET value", value: process.env.SESSION_SECRET });
}
if (process.env.ATLAS_API_ORIGIN) {
  FORBIDDEN.push({
    label: "configured ATLAS_API_ORIGIN value",
    value: process.env.ATLAS_API_ORIGIN,
  });
}
/** A string known to ship in the client bundle; proves the scan reads real bundle text. */
const POSITIVE_CONTROL = "Atlas Control";

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

let controlSeen = false;
const hits = [];

let files = 0;
try {
  for (const path of walk(BUNDLE_DIR)) {
    files += 1;
    const text = readFileSync(path, "utf-8");
    if (text.includes(POSITIVE_CONTROL)) controlSeen = true;
    for (const forbidden of FORBIDDEN) {
      // Report only the safe label. A failing scan must never echo the secret it found.
      if (text.includes(forbidden.value)) hits.push(`${path}: ${forbidden.label}`);
    }
  }
} catch (error) {
  console.error(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

if (!controlSeen) {
  console.error(
    `positive control ${JSON.stringify(POSITIVE_CONTROL)} not found in ${files} files under ${BUNDLE_DIR} — scanner is not reading bundle text; build first`,
  );
  process.exit(2);
}
if (hits.length > 0) {
  console.error(`forbidden symbols in client bundle:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`clean: ${files} files scanned, no forbidden symbols, positive control present`);
