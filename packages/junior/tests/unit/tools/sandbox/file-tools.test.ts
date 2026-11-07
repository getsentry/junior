import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import {
  editFile,
  prepareEditFileArguments,
} from "@/chat/tools/sandbox/edit-file";
import { sliceFileContent } from "@/chat/tools/sandbox/read-file";
import type { SandboxFileSystem } from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { TOOL_RESULT_MAX_CHARS } from "@/chat/tool-support/result-cap";

function workspacePath(filePath: string): string {
  return path.posix.join(SANDBOX_WORKSPACE_ROOT, filePath);
}

function missingPathError(message: string): Error {
  return Object.assign(new Error(message), { code: "ENOENT" });
}

function createMemoryFs(initialFiles: Record<string, string>) {
  const files = new Map(
    Object.entries(initialFiles).map(([filePath, content]) => [
      workspacePath(filePath),
      content,
    ]),
  );

  const hasDirectory = (directoryPath: string) =>
    [...files.keys()].some((filePath) =>
      filePath.startsWith(`${directoryPath}/`),
    );

  const fs: SandboxFileSystem = {
    async readFile(filePath) {
      const content = files.get(filePath);
      if (content === undefined) {
        throw missingPathError(`missing file: ${filePath}`);
      }
      return content;
    },
    async writeFile(filePath, content) {
      files.set(filePath, content);
    },
    async readdir(directoryPath) {
      if (!hasDirectory(directoryPath)) {
        throw missingPathError(`missing directory: ${directoryPath}`);
      }
      const entries = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(`${directoryPath}/`)) continue;
        const remainder = filePath.slice(directoryPath.length + 1);
        const [entry] = remainder.split("/");
        if (entry) entries.add(entry);
      }
      return [...entries];
    },
    async stat(filePath) {
      if (files.has(filePath)) {
        return { isDirectory: () => false };
      }
      if (hasDirectory(filePath)) {
        return { isDirectory: () => true };
      }
      throw missingPathError(`missing path: ${filePath}`);
    },
  };

  return {
    fs,
    read(filePath: string) {
      return files.get(workspacePath(filePath));
    },
  };
}

describe("sandbox file tools", () => {
  it("slices readFile content with continuation metadata", () => {
    const result = sliceFileContent({
      content: "one\ntwo\nthree",
      path: "notes.txt",
      offset: 2,
      limit: 1,
    });

    expect(result.details).toMatchObject({
      target: "notes.txt",
      truncated: true,
      content: "two",
      end_line: 2,
      path: "notes.txt",
      start_line: 2,
      total_lines: 3,
      continuation: {
        arguments: {
          path: "notes.txt",
          offset: 3,
          limit: 1,
        },
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
  });

  it("continues readFile at the first whole line excluded by the character limit", () => {
    const line = "a".repeat(14_000);
    const result = sliceFileContent({
      content: `${line}\n${line}\n${line}\nfour`,
      path: "generated.txt",
    });

    expect(result.details).toMatchObject({
      truncated: true,
      character_limit_reached: 30_000,
      content: `${line}\n${line}`,
      end_line: 2,
      truncation_reasons: ["30000 character output limit reached."],
      continuation: {
        arguments: {
          path: "generated.txt",
          offset: 3,
          limit: 1000,
        },
        reason: "character output limit reached; file has more lines",
      },
    });
    expect(result.details).not.toHaveProperty("line_truncated");
    // A page always fits the tool result cap, so the cap never copies it.
    expect(result.content[0].text.length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS,
    );
  });

  it("keeps a whole CRLF file under the tool result cap", () => {
    const lines = Array.from({ length: 1000 }, () => "a".repeat(27));
    const result = sliceFileContent({
      content: lines.join("\r\n"),
      path: "windows.txt",
    });

    expect(result.details).toMatchObject({ truncated: false, end_line: 1000 });
    expect(result.details.content).toBe(lines.join("\n"));
    expect(result.content[0].text.length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS,
    );
  });

  it("bounds and reports an individually oversized readFile line", () => {
    // Each quote is two chars in JSON text.
    const result = sliceFileContent({
      content: '"'.repeat(100_000),
      path: "generated.json",
    });

    expect(result.details).toMatchObject({
      truncated: true,
      character_limit_reached: 30_000,
      line_truncated: true,
      end_line: 1,
      truncation_reasons: [
        "30000 character output limit reached.",
        "Line 1 was truncated.",
      ],
    });
    expect(result.details.content).toHaveLength(15_000);
    expect(result.details).not.toHaveProperty("continuation");
    expect(result.content[0].text.length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS,
    );
  });

  it("applies exact edits and preserves line endings", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "one\r\ntwo\r\nthree\r\n",
    });

    const result = await editFile({
      fs: memory.fs,
      path: "src/app.ts",
      edits: [{ old_text: "two\nthree", new_text: "TWO\nTHREE" }],
    });

    expect(memory.read("src/app.ts")).toBe("one\r\nTWO\r\nTHREE\r\n");
    expect(result.details).toMatchObject({
      path: "src/app.ts",
      replacements: 1,
    });
    expect(result.details.diff).toContain("+2 TWO");
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
  });

  it("keeps distant edits in separate hunks with correct line numbers", async () => {
    const original = Array.from(
      { length: 1_000 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const memory = createMemoryFs({ "large.ts": original });
    const result = await editFile({
      fs: memory.fs,
      path: "large.ts",
      edits: [
        { old_text: "line 2\n", new_text: "changed\ninserted\n" },
        { old_text: "line 998\n", new_text: "" },
      ],
    });

    expect(result.details).toMatchObject({
      first_changed_line: 2,
      truncated: false,
    });
    expect(result.details.diff).toMatchInlineSnapshot(`
      "    1 line 1
      -   2 line 2
      +   2 changed
      +   3 inserted
          4 line 3
          5 line 4
          6 line 5
            ...
        996 line 995
        997 line 996
        998 line 997
      - 998 line 998
        999 line 999
       1000 line 1000
      \\ No newline at end of file"
    `);
  });

  it.each([
    ["old", "", "-1 old\n\\ No newline at end of file"],
    ["old", "old\n", "-1 old\n\\ No newline at end of file\n+1 old"],
  ])(
    "reports an end-of-file edit from %j to %j",
    async (oldText, newText, diff) => {
      const memory = createMemoryFs({ "file.txt": oldText });
      const result = await editFile({
        fs: memory.fs,
        path: "file.txt",
        edits: [{ old_text: oldText, new_text: newText }],
      });
      expect(result.details.diff).toBe(diff);
      expect(result.details.truncated).toBe(false);
    },
  );

  it("bounds huge single-line edit diffs without duplicating them", async () => {
    const memory = createMemoryFs({
      "generated.js": `const data = "${"a".repeat(100_000)}";\n`,
    });

    const result = await editFile({
      fs: memory.fs,
      path: "generated.js",
      edits: [
        {
          old_text: "a".repeat(100_000),
          new_text: "b".repeat(100_000),
        },
      ],
    });

    expect(result.details.truncated).toBe(true);
    expect(result.details.diff.length).toBeLessThan(10_000);
    expect(result.details.diff).toContain("[line truncated]");
    expect(result.content[0].text.length).toBeLessThan(20_000);
  });

  it("prepares common edit argument variants", () => {
    expect(
      prepareEditFileArguments({
        path: "src/app.ts",
        oldText: "before",
        newText: "after",
      }),
    ).toEqual({
      path: "src/app.ts",
      edits: [{ old_text: "before", new_text: "after" }],
    });
  });

  it("returns structured failure for ambiguous edits", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "same\nsame\n",
    });

    await expect(
      editFile({
        fs: memory.fs,
        path: "src/app.ts",
        edits: [{ old_text: "same", new_text: "changed" }],
      }),
    ).rejects.toThrow("Found 2 occurrences");
  });

  it("returns structured failure for old text not found", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "hello world\n",
    });

    await expect(
      editFile({
        fs: memory.fs,
        path: "src/app.ts",
        edits: [{ old_text: "missing text", new_text: "new" }],
      }),
    ).rejects.toThrow("Could not find edits[0]");
  });

  it("throws ToolInputError for workspace path traversal", async () => {
    const memory = createMemoryFs({});

    await expect(
      editFile({
        fs: memory.fs,
        path: "../../../etc/passwd",
        edits: [{ old_text: "root", new_text: "user" }],
      }),
    ).rejects.toThrow(ToolInputError);
  });
});
