import { describe, expect, it } from "vitest";

import {
  chooseRunFileKey,
  RUN_FILE_KEY_MAX_LENGTH,
  RUN_FILE_KEY_RE,
  runFileKeyFor,
  type ExistingRunFile,
} from "@/lib/run-file-keys";

/** Uploads the run already holds, in the shape the page passes down. */
function uploaded(...pairs: [key: string, filename: string][]): ExistingRunFile[] {
  return pairs.map(([key, filename]) => ({ key, filename }));
}

describe("runFileKeyFor", () => {
  it("produces a key Atlas's own rule accepts", () => {
    for (const name of [
      "report.pdf",
      "a b.txt",
      "รายงานประจำปี.pdf",
      "  leading and trailing  .csv  ",
      "!!!",
      "",
      `${"x".repeat(400)}.txt`,
    ]) {
      expect(runFileKeyFor(name)).toMatch(RUN_FILE_KEY_RE);
    }
  });

  it("keeps a name that is already legal readable", () => {
    expect(runFileKeyFor("report.pdf")).toBe("upload_report.pdf");
  });

  it("falls back rather than emitting a bare prefix for a name with nothing usable in it", () => {
    expect(runFileKeyFor("!!!")).toBe("upload_file");
    expect(runFileKeyFor("")).toBe("upload_file");
  });
});

describe("chooseRunFileKey", () => {
  it("takes the plain key when the run holds nothing", () => {
    expect(chooseRunFileKey("report.pdf", [])).toEqual({
      key: "upload_report.pdf",
      replaces: false,
    });
  });

  /**
   * The regression this exists for: sanitising is many-to-one, so two files the operator
   * genuinely attached would otherwise land on one key — and `push_files` collapses a repeated
   * key to the newest, so the worker would receive one of the two.
   */
  it("separates two different filenames that sanitise to the same key", () => {
    const existing = uploaded(["upload_a_b.txt", "a b.txt"]);
    const choice = chooseRunFileKey("a_b.txt", existing);

    expect(choice.replaces).toBe(false);
    expect(choice.key).not.toBe("upload_a_b.txt");
    expect(choice.key).toMatch(RUN_FILE_KEY_RE);
  });

  it("separates Thai filenames, which sanitise to nothing but their extension", () => {
    const existing: ExistingRunFile[] = [];
    const keys = ["รายงาน.pdf", "สรุป.pdf", "แผนงาน.pdf"].map((filename) => {
      const { key } = chooseRunFileKey(filename, existing);
      existing.push({ key, filename });
      return key;
    });

    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(RUN_FILE_KEY_RE);
  });

  /**
   * The other half of the rule. Reusing the key is a real end-to-end replace — Atlas resolves
   * `{artifact.<key>}` newest-first and `push_files` keeps only the newest per key — and it is
   * the operator's only way to correct a wrong file, since Atlas cannot delete an artifact.
   */
  it("reuses the key when the same filename is attached again, so the correction replaces", () => {
    const existing = uploaded(["upload_report.pdf", "report.pdf"]);
    expect(chooseRunFileKey("report.pdf", existing)).toEqual({
      key: "upload_report.pdf",
      replaces: true,
    });
  });

  it("replaces on the suffixed key too, once a name has been pushed onto one", () => {
    const existing = uploaded(["upload_a_b.txt", "a b.txt"], ["upload_a_b.txt_2", "a_b.txt"]);
    expect(chooseRunFileKey("a_b.txt", existing)).toEqual({
      key: "upload_a_b.txt_2",
      replaces: true,
    });
  });

  it("ignores collected outputs, which share neither the namespace nor the push glob", () => {
    // A node's own output can carry the same display name; replacing its key would corrupt a
    // result, and `files.*` is outside the `upload_*` glob that feeds a worker anyway.
    const existing = uploaded(["files.gather.report.pdf", "report.pdf"]);
    expect(chooseRunFileKey("report.pdf", existing)).toEqual({
      key: "upload_report.pdf",
      replaces: false,
    });
  });

  it("counts up past several taken keys rather than stopping at the first suffix", () => {
    const existing = uploaded(
      ["upload_a.txt", "one.txt"],
      ["upload_a.txt_2", "two.txt"],
      ["upload_a.txt_3", "three.txt"],
    );
    expect(chooseRunFileKey("a.txt", existing).key).toBe("upload_a.txt_4");
  });

  it("stays inside Atlas's length limit when it has to add a suffix", () => {
    const longName = `${"x".repeat(400)}.txt`;
    const base = runFileKeyFor(longName);
    expect(base).toHaveLength(RUN_FILE_KEY_MAX_LENGTH);

    const { key } = chooseRunFileKey(longName, uploaded([base, "something-else.txt"]));
    expect(key).not.toBe(base);
    expect(key.length).toBeLessThanOrEqual(RUN_FILE_KEY_MAX_LENGTH);
    expect(key).toMatch(RUN_FILE_KEY_RE);
  });

  it("never repeats a key across a whole batch of colliding names", () => {
    const names = ["a b.txt", "a_b.txt", "a-b.txt", "a  b.txt", "a\tb.txt", "รายงาน.txt", "！.txt"];
    const existing: ExistingRunFile[] = [];
    for (const filename of names) {
      const { key, replaces } = chooseRunFileKey(filename, existing);
      expect(replaces).toBe(false);
      expect(existing.some((file) => file.key === key)).toBe(false);
      expect(key).toMatch(RUN_FILE_KEY_RE);
      existing.push({ key, filename });
    }
    expect(existing).toHaveLength(names.length);
  });
});
