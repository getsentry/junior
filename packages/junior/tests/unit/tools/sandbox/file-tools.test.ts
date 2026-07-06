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
      ok: true,
      status: "success",
      target: "notes.txt",
      truncated: true,
      data: {
        content: "two",
        end_line: 2,
        path: "notes.txt",
        start_line: 2,
        total_lines: 3,
      },
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
      ok: true,
      path: "src/app.ts",
      replacements: 1,
    });
    if (!result.details.ok) {
      throw new Error("editFile should have succeeded");
    }
    expect(result.details.diff).toContain("+2 TWO");
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
        ok: true,
        path: "src",
        status: "success",
        target: "src",
        truncated: false,
        data: {
          entries: ["app.ts", "nested/"],
          entry_count: 2,
        },
      },
    });
    await expect(
      findFiles({ fs: memory.fs, path: "src", pattern: "*.ts" }),
    ).resolves.toMatchObject({
      details: {
        ok: true,
        path: "src",
        status: "success",
        target: "src",
        truncated: false,
        data: {
          files: ["app.ts", "nested/test.ts"],
          file_count: 2,
        },
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
        ok: true,
        path: "src",
        status: "success",
        target: "src",
        truncated: false,
        data: {
          lines: [
            "app.ts:1: const needle = true;",
            "nested/test.ts:1: needle again",
          ],
          match_count: 2,
        },
      },
    });
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
      details: { ok: true, path: ".", truncated: false },
    });
  });

  it("returns tool results for missing search roots", async () => {
    const memory = createMemoryFs({
      "src/app.ts": "const needle = true;\n",
    });

    await expect(
      findFiles({ fs: memory.fs, path: "missing", pattern: "*.ts" }),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        status: "error",
        target: "missing",
        error: {
          kind: "not_found",
          message: "Path not found: missing",
        },
        path: "missing",
        truncated: false,
      },
    });
    await expect(
      grepFiles({
        fs: memory.fs,
        path: "missing",
        pattern: "needle",
        literal: true,
      }),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        status: "error",
        target: "missing",
        error: {
          kind: "not_found",
          message: "Path not found: missing",
        },
        path: "missing",
        truncated: false,
      },
    });
    await expect(
      listDir({ fs: memory.fs, path: "missing" }),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        status: "error",
        target: "missing",
        error: {
          kind: "not_found",
          message: "Path not found: missing",
        },
        path: "missing",
        truncated: false,
      },
    });
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
    ).resolves.toMatchObject({
      details: {
        ok: false,
        status: "error",
        target: "src",
        error: {
          kind: "not_found",
          message: `Path not found: ${SANDBOX_WORKSPACE_ROOT}/src/gone.ts`,
        },
        path: "src",
        missing_path: `${SANDBOX_WORKSPACE_ROOT}/src/gone.ts`,
        truncated: false,
      },
    });
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
        ok: true,
        path: "src",
        status: "success",
        target: "src",
        truncated: false,
        data: {
          lines: [
            "app.ts-1- before",
            "app.ts:2: needle one",
            "app.ts:3: needle two",
            "app.ts-4- after",
          ],
        },
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
    ).resolves.toMatchObject({
      details: {
        ok: false,
        status: "error",
        target: "src/app.ts",
        error: {
          kind: "old_text_not_unique",
        },
      },
    });
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
    ).resolves.toMatchObject({
      details: {
        ok: false,
        status: "error",
        target: "src/app.ts",
        error: {
          kind: "old_text_not_found",
        },
      },
    });
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
