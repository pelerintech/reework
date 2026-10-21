import { describe, expect, it } from "vitest";
import { formatAttachment } from "@reework/tui";

describe("formatAttachment", () => {
  it("styles a diff by line kind", () => {
    const lines = formatAttachment({
      kind: "diff",
      title: "worker.ts",
      content: [
        "--- a/worker.ts",
        "+++ b/worker.ts",
        "@@ -10,3 +10,4 @@",
        " const job = next();",
        "-run(job);",
        "+await run(job);",
        "+report(job);",
      ].join("\n"),
    });

    expect(lines.map((l) => l.style)).toEqual([
      "title",
      "file",
      "file",
      "hunk",
      "context",
      "removed",
      "added",
      "added",
    ]);
    expect(lines[6].text).toBe("+await run(job);");
  });

  it("keeps markdown and text lines as they are", () => {
    for (const kind of ["markdown", "text"] as const) {
      const lines = formatAttachment({
        kind,
        content: "# Diagnosis\n- timeout swallowed\n+ not a diff",
      });
      expect(lines.map((l) => l.text)).toEqual([
        "# Diagnosis",
        "- timeout swallowed",
        "+ not a diff",
      ]);
      expect(new Set(lines.map((l) => l.style))).toEqual(new Set(["plain"]));
    }
  });
});
