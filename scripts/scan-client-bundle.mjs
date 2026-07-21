#!/usr/bin/env node
/**
 * Scans the built client bundle for credential-shaped symbols.
 *
 * Run after `bun run build`. Exits 0 when clean, 1 on any forbidden hit, 2 when the positive
 * control fails (which means the scanner is not actually reading bundle text and a green
 * result would be meaningless).
 *
 * The forbidden list matches the names of server-only symbols and env variables: if any of
 * them appears in `.output/public`, a server module (or an inlined secret) has crossed into
 * the browser bundle. The values themselves cannot be scanned for — they are deployment
 * secrets unknown here — but the names travel with the code that reads them.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_DIR = ".output/public";
const FORBIDDEN = [
  "SESSION_SECRET",
  "ATLAS_API_ORIGIN",
  "atlasToken",
  "fd_session",
  "api_token",
  "token_hash",
  "requireAtlasToken",
];
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
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hits.push(`${path}: ${needle}`);
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
