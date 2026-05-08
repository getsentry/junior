import { describe, expect, it } from "vitest";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";

describe("buildSandboxInput", () => {
  it("normalizes bash command", () => {
    expect(buildSandboxInput("bash", { command: "ls -la" })).toEqual({
      command: "ls -la",
    });
    expect(
      buildSandboxInput("bash", { command: "sleep 10", timeoutMs: 1000 }),
    ).toEqual({
      command: "sleep 10",
      timeoutMs: 1000,
    });
  });

  it("normalizes readFile path", () => {
    expect(buildSandboxInput("readFile", { path: "/tmp/file.txt" })).toEqual({
      path: "/tmp/file.txt",
    });
    expect(
      buildSandboxInput("readFile", {
        path: "/tmp/file.txt",
        offset: 10,
        limit: 20,
      }),
    ).toEqual({
      path: "/tmp/file.txt",
      offset: 10,
      limit: 20,
    });
  });

  it("normalizes sandbox discovery tool params", () => {
    expect(
      buildSandboxInput("grep", {
        pattern: "needle",
        path: "src",
        glob: "*.ts",
        ignoreCase: true,
        literal: true,
        context: 1,
        limit: 2,
      }),
    ).toEqual({
      pattern: "needle",
      path: "src",
      glob: "*.ts",
      ignoreCase: true,
      literal: true,
      context: 1,
      limit: 2,
    });
    expect(
      buildSandboxInput("findFiles", {
        pattern: "**/*.ts",
        path: "src",
        limit: 5,
      }),
    ).toEqual({
      pattern: "**/*.ts",
      path: "src",
      limit: 5,
    });
    expect(buildSandboxInput("listDir", { path: "src", limit: 5 })).toEqual({
      path: "src",
      limit: 5,
    });
  });

  it("normalizes editFile params", () => {
    const edits = [{ oldText: "before", newText: "after" }];
    expect(buildSandboxInput("editFile", { path: "src/a.ts", edits })).toEqual({
      path: "src/a.ts",
      edits,
    });
  });

  it("normalizes writeFile path and content", () => {
    expect(
      buildSandboxInput("writeFile", { path: "/tmp/out", content: "data" }),
    ).toEqual({ path: "/tmp/out", content: "data" });
  });

  it("passes through unknown tool params", () => {
    const params = { foo: "bar", baz: 42 };
    expect(buildSandboxInput("unknownTool", params)).toBe(params);
  });

  it("handles missing fields with empty strings", () => {
    expect(buildSandboxInput("bash", {})).toEqual({ command: "" });
    expect(buildSandboxInput("readFile", {})).toEqual({ path: "" });
    expect(buildSandboxInput("editFile", {})).toEqual({ path: "", edits: [] });
    expect(buildSandboxInput("writeFile", {})).toEqual({
      path: "",
      content: "",
    });
  });
});
