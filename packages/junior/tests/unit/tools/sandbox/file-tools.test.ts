import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import {
  editFile,
  prepareEditFileArguments,
} from "@/chat/tools/sandbox/edit-file";
import { findFiles } from "@/chat/tools/sandbox/find-files";
import { createGrepTool, grepFiles } from "@/chat/tools/sandbox/grep";
import { listDir } from "@/chat/tools/sandbox/list-dir";
import { sliceFileContent } from "@/chat/tools/sandbox/read-file";
import type { SandboxFileSystem } from "@/chat/tools/sandbox/file-utils";
import type { SandboxCommandRunner } from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

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
    const line = "a".repeat(30_000);
    const result = sliceFileContent({
      content: `${line}\n${line}\nthree`,
      path: "generated.txt",
    });

    expect(result.details).toMatchObject({
      truncated: true,
      character_limit_reached: 60_000,
      content: line,
      end_line: 1,
      truncation_reasons: ["60000 character output limit reached."],
      continuation: {
        arguments: {
          path: "generated.txt",
          offset: 2,
          limit: 1000,
        },
        reason: "character output limit reached; file has more lines",
      },
    });
    expect(result.details).not.toHaveProperty("line_truncated");
    expect(result.content[0].text.length).toBeLessThan(61_000);
  });

  it("bounds and reports an individually oversized readFile line", () => {
    const result = sliceFileContent({
      content: "a".repeat(100_000),
      path: "generated.json",
    });

    expect(result.details).toMatchObject({
      truncated: true,
      character_limit_reached: 60_000,
      line_truncated: true,
      end_line: 1,
      truncation_reasons: [
        "60000 character output limit reached.",
        "Line 1 was truncated.",
      ],
    });
    expect(result.details.content).toHaveLength(60_000);
    expect(result.details).not.toHaveProperty("continuation");
    expect(result.content[0].text.length).toBeLessThan(61_000);
  });

  it("applies exact edits and preserves line endings", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "one\r\ntwo\r\nthree\r\n",
    });

    const result = await editFile({
      fs: memory.fs,
      path: "src/app.ts",
      edits: [{ oldText: "two\nthree", newText: "TWO\nTHREE" }],
    });

    expect(memory.read("src/app.ts")).toBe("one\r\nTWO\r\nTHREE\r\n");
    expect(result.details).toMatchObject({
      path: "src/app.ts",
      replacements: 1,
    });
    expect(result.details.diff).toContain("+2 TWO");
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
  });

  it("bounds huge single-line edit diffs without duplicating them", async () => {
    const memory = createMemoryFs({
      "generated.js": `const data = "${"a".repeat(100_000)}";\n`,
    });

    const result = await editFile({
      fs: memory.fs,
      path: "generated.js",
      edits: [
        {
          oldText: "a".repeat(100_000),
          newText: "b".repeat(100_000),
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
        old_text: "before",
        new_text: "after",
      }),
    ).toEqual({
      path: "src/app.ts",
      edits: [{ oldText: "before", newText: "after" }],
    });
  });

  it("lists, finds, and searches files without shelling out", async () => {
    const memory = createMemoryFs({
      "README.md": "hello",
      "src/app.ts": "const needle = true;\n",
      "src/nested/test.ts": "needle again\n",
    });

    await expect(
      listDir({ fs: memory.fs, path: "src" }),
    ).resolves.toMatchObject({
      details: {
        path: "src",
        target: "src",
        truncated: false,
        entries: ["app.ts", "nested/"],
        entry_count: 2,
      },
    });
    await expect(
      findFiles({ fs: memory.fs, path: "src", pattern: "*.ts" }),
    ).resolves.toMatchObject({
      details: {
        path: "src",
        target: "src",
        truncated: false,
        files: ["app.ts", "nested/test.ts"],
        file_count: 2,
      },
    });
    await expect(
      grepFiles({
        fs: memory.fs,
        path: "src",
        pattern: "needle",
        literal: true,
      }),
    ).resolves.toMatchObject({
      details: {
        path: "src",
        target: "src",
        truncated: false,
        lines: [
          "app.ts:1: const needle = true;",
          "nested/test.ts:1: needle again",
        ],
        match_count: 2,
      },
    });
  });

  it("runs findFiles through ripgrep with ignore-aware argv", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "content\n",
      "src/nested/test.ts": "content\n",
    });
    const calls: Parameters<SandboxCommandRunner>[0][] = [];
    const runCommand: SandboxCommandRunner = async (input) => {
      calls.push(input);
      return {
        exitCode: 0,
        stderr: "",
        stdout: "nested/test.ts\0",
      };
    };

    const result = await findFiles({
      fs: memory.fs,
      limit: 20,
      path: "src",
      pattern: "nested/*.ts",
      runCommand,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "bash",
      args: [
        "-c",
        expect.stringContaining('rg "$@" | head -z -n 21'),
        "find-files",
        "--files",
        "--null",
        "--hidden",
        "--glob",
        "nested/*.ts",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/node_modules/**",
        "--",
        ".",
      ],
      cwd: workspacePath("src"),
      timeoutMs: 30_000,
    });
    expect(result.details).toMatchObject({
      files: ["nested/test.ts"],
      file_count: 1,
    });
  });

  it("parses bounded ripgrep JSON without shell interpolation", async () => {
    const memory = createMemoryFs({
      "src/nested/app.ts": "before\nneedle\nafter\n",
    });
    const calls: Parameters<SandboxCommandRunner>[0][] = [];
    const event = (type: "context" | "match", line: number, text: string) =>
      JSON.stringify({
        type,
        data: {
          path: { text: "nested/app.ts" },
          lines: { text: `${text}\n` },
          line_number: line,
        },
      });
    const runCommand: SandboxCommandRunner = async (input) => {
      calls.push(input);
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          event("context", 1, "before"),
          event("match", 2, "needle"),
          event("context", 3, "after"),
        ].join("\n"),
      };
    };

    const result = await grepFiles({
      context: 1,
      fs: memory.fs,
      glob: "nested/*.ts",
      literal: true,
      path: "src",
      pattern: "needle'; exit 9; '",
      runCommand,
    });

    expect(calls[0]).toMatchObject({
      cmd: "rg",
      cwd: workspacePath("src"),
      timeoutMs: 30_000,
    });
    const args = calls[0]?.args ?? [];
    expect(args).toContain("--max-count");
    expect(args).toContain("101");
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("--max-count");
    expect(args).toContain("101");
    expect(args).toContain("nested/*.ts");
    expect(args).toContain("needle'; exit 9; '");
    expect(args.indexOf("nested/*.ts")).toBeLessThan(
      args.indexOf("!**/.git/**"),
    );
    expect(args.indexOf("nested/*.ts")).toBeLessThan(
      args.indexOf("!**/node_modules/**"),
    );
    expect(result.details).toMatchObject({
      lines: [
        "nested/app.ts-1- before",
        "nested/app.ts:2: needle",
        "nested/app.ts-3- after",
      ],
      match_count: 1,
    });
  });

  it("preserves ripgrep input and sandbox lifecycle failures", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "content\n",
    });
    const invalidRegex: SandboxCommandRunner = async () => ({
      exitCode: 2,
      stderr: "regex parse error: unclosed character class",
      stdout: "",
    });

    await expect(
      grepFiles({
        fs: memory.fs,
        path: "src",
        pattern: "[invalid",
        runCommand: invalidRegex,
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: "Invalid regex pattern: [invalid",
    });

    const invalidGlob: SandboxCommandRunner = async () => ({
      exitCode: 2,
      stderr:
        "rg: error parsing glob '{foo,{bar,baz}}': nested alternate groups are not allowed",
      stdout: "",
    });

    await expect(
      grepFiles({
        fs: memory.fs,
        glob: "{foo,{bar,baz}}",
        path: "src",
        pattern: "needle",
        runCommand: invalidGlob,
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: "Invalid glob: {foo,{bar,baz}}",
    });

    const lifecycleFailure = new Error("sandbox_stopped");
    await expect(
      findFiles({
        fs: memory.fs,
        path: "src",
        pattern: "*.ts",
        runCommand: async () => {
          throw lifecycleFailure;
        },
      }),
    ).rejects.toBe(lifecycleFailure);
  });

  it("does not accept findFiles pipeline failures as no-match results", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "content\n",
    });

    await expect(
      findFiles({
        fs: memory.fs,
        path: "src",
        pattern: "*.ts",
        runCommand: async () => ({
          exitCode: 1,
          stderr: "head failed",
          stdout: "",
        }),
      }),
    ).rejects.toThrow("ripgrep file search failed: head failed");
  });

  it("prepares grep string booleans like the previous TypeBox schema", () => {
    const tool = createGrepTool();

    expect(
      tool.prepareArguments?.({
        pattern: "hello",
        ignoreCase: "false",
        literal: "true",
      }),
    ).toMatchObject({
      ignoreCase: false,
      literal: true,
    });
  });

  it("matches globstar directories with or without nested segments", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "top",
      "src/nested/test.ts": "nested",
      "src/nested/test.js": "ignored",
    });

    await expect(
      findFiles({ fs: memory.fs, pattern: "src/**/*.ts" }),
    ).resolves.toMatchObject({
      details: { path: ".", truncated: false },
    });
  });

  it("returns tool results for missing search roots", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "const needle = true;\n",
    });

    await expect(
      findFiles({ fs: memory.fs, path: "missing", pattern: "*.ts" }),
    ).rejects.toThrow("Path not found: missing");
    await expect(
      grepFiles({
        fs: memory.fs,
        path: "missing",
        pattern: "needle",
        literal: true,
      }),
    ).rejects.toThrow("Path not found: missing");
    await expect(listDir({ fs: memory.fs, path: "missing" })).rejects.toThrow(
      "Path not found: missing",
    );
  });

  it("reports files that disappear during traversal", async () => {
    const memory = createMemoryFs({
      "src/kept.ts": "needle\n",
      "src/gone.ts": "needle\n",
    });
    let hideGone = false;
    const originalStat = memory.fs.stat;
    memory.fs.stat = async (filePath) => {
      if (hideGone && filePath.endsWith("/gone.ts")) {
        throw missingPathError(`missing path: ${filePath}`);
      }
      return originalStat(filePath);
    };

    hideGone = true;

    await expect(
      findFiles({ fs: memory.fs, path: "src", pattern: "*.ts" }),
    ).rejects.toThrow(`Path not found: ${SANDBOX_WORKSPACE_ROOT}/src/gone.ts`);
  });

  it("deduplicates overlapping grep context lines", async () => {
    const memory = createMemoryFs({
      "src/app.ts": ["before", "needle one", "needle two", "after"].join("\n"),
    });

    await expect(
      grepFiles({
        fs: memory.fs,
        path: "src",
        pattern: "needle",
        literal: true,
        context: 1,
      }),
    ).resolves.toMatchObject({
      details: {
        path: "src",
        target: "src",
        truncated: false,
        lines: [
          "app.ts-1- before",
          "app.ts:2: needle one",
          "app.ts:3: needle two",
          "app.ts-4- after",
        ],
      },
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
        edits: [{ oldText: "same", newText: "changed" }],
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
        edits: [{ oldText: "missing text", newText: "new" }],
      }),
    ).rejects.toThrow("Could not find edits[0]");
  });

  it("throws ToolInputError for workspace path traversal", async () => {
    const memory = createMemoryFs({});

    await expect(
      listDir({ fs: memory.fs, path: "../../../etc" }),
    ).rejects.toThrow(ToolInputError);
  });

  it("throws ToolInputError for invalid grep regex", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "content\n",
    });

    await expect(
      grepFiles({
        fs: memory.fs,
        path: "src",
        pattern: "[invalid",
      }),
    ).rejects.toThrow(ToolInputError);
  });

  it("throws ToolInputError when listDir targets a file", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "content\n",
    });

    await expect(
      listDir({ fs: memory.fs, path: "src/app.ts" }),
    ).rejects.toThrow(ToolInputError);
  });
});
