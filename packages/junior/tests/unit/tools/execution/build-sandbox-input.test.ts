import { describe, expect, it } from "vitest";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";

describe("buildSandboxInput", () => {
  it("normalizes bash command", () => {
    expect(buildSandboxInput("bash", { command: "ls -la" })).toEqual({
      command: "ls -la",
    });
  });

  it("normalizes readFile path", () => {
    expect(buildSandboxInput("readFile", { path: "/tmp/file.txt" })).toEqual({
      path: "/tmp/file.txt",
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
    expect(buildSandboxInput("writeFile", {})).toEqual({
      path: "",
      content: "",
    });
  });
});
