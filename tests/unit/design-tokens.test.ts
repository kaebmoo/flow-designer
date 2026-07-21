/**
 * Phase 6 design-token regression scan.
 *
 * Colours in application source must come from the semantic tokens in `src/styles.css`.
 * This scan is a static tripwire: it fails when a new hardcoded colour appears, while
 * carefully NOT flagging the things the rules exempt —
 *
 *  - arbitrary DIMENSION values (`text-[10px]`, `w-[220px]`, `tracking-[0.2em]`) and
 *    arbitrary-opacity washes (`bg-highlight/[0.03]`) are not colours;
 *  - `:root`/`@theme` custom-property declarations are the token definitions themselves;
 *  - `src/lib/error-page.ts` declares its own minimal token block because it renders without
 *    the app stylesheet — literals are legal there only inside custom-property declarations;
 *  - `chart.tsx`'s `[stroke='#ccc']` selectors match colours *Recharts* draws, in order to
 *    override them with tokens — selector text, not an app-drawn colour.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = "src";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (/\.(tsx?|css)$/.test(path) && !path.endsWith("routeTree.gen.ts")) {
      yield path;
    }
  }
}

/** Lines that *define* tokens (custom properties) may carry literals; all others may not. */
function isTokenDefinition(line: string): boolean {
  return /^\s*--[\w-]+\s*:/.test(line);
}

/** Third-party compatibility selectors: `[stroke='#ccc']` matches what Recharts emitted. */
function stripThirdPartySelectors(line: string): string {
  return line.replace(/\[[\w-]+='#[0-9a-fA-F]{3,8}'\]/g, "");
}

const NAMED_TAILWIND_PALETTE =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|accent|caret|decoration|shadow)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?=[\s/"'`\]}]|$)/;

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color)\(/;

describe("design-token regression scan", () => {
  const files = [...walk(SRC)];

  it("finds the source tree (guard against a silently empty scan)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join("src", "styles.css"));
  });

  it("no Tailwind literal colour classes (black/white/named palettes) outside tokens", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        const match = NAMED_TAILWIND_PALETTE.exec(line);
        if (match) hits.push(`${file}:${index + 1} → ${match[0]}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("no colour literals (hex/rgb/hsl/oklch) outside token definitions and known exemptions", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((rawLine, index) => {
        if (isTokenDefinition(rawLine)) return;
        const line = stripThirdPartySelectors(rawLine);
        // `color-mix(... var(--token) ...)` derives from a token; only flag it when a raw
        // colour literal appears inside.
        const withoutTokenMixes = line.replace(
          /color-mix\((?:[^()]|\([^)]*\))*var\(--[\w-]+\)(?:[^()]|\([^)]*\))*\)/g,
          "",
        );
        // `var(--...)` references are the point of the system.
        const cleaned = withoutTokenMixes.replace(/var\(--[\w-]+\)/g, "");
        const match = COLOR_LITERAL.exec(cleaned);
        if (match)
          hits.push(`${file}:${index + 1} → ${match[0]} in ${rawLine.trim().slice(0, 80)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the standalone error page draws only from its declared token block", () => {
    const source = readFileSync(join("src", "lib", "error-page.ts"), "utf-8");
    const withoutDeclarations = source
      .split("\n")
      .filter((line) => !isTokenDefinition(line))
      .join("\n");
    expect(withoutDeclarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutDeclarations).not.toMatch(/\b(?:rgba?|hsla?|oklch)\(\s*\d/);
  });

  it("the semantic surface tokens exist for the roles the app uses", () => {
    const styles = readFileSync(join("src", "styles.css"), "utf-8");
    for (const token of [
      "--overlay:",
      "--highlight:",
      "--surface-raised:",
      "--edge-label-border:",
      "--edge-label-foreground:",
      "--color-overlay:",
      "--color-highlight:",
    ]) {
      expect(styles).toContain(token);
    }
  });
});
