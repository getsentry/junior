import { describe, expect, it } from "vitest";

import { toolCallPreview } from "../src/client/components/toolCallPreview";

describe("toolCallPreview", () => {
  it("normalizes generic tool arguments", () => {
    expect(
      toolCallPreview("search", {
        query: "release   regression",
        limit: 10,
        options: { archived: false },
      }),
    ).toBe(
      'query: "release regression", limit: 10, options: { "archived": false }',
    );
  });

  it("JSON stringifies string argument values", () => {
    expect(
      toolCallPreview("searchTools", {
        query: "",
        source: "memory",
        note: 'say "hello"',
      }),
    ).toBe('query: "", source: "memory", note: "say \\"hello\\""');
  });

  it("shows only the bash command", () => {
    expect(
      toolCallPreview("bash", {
        command: "jr-rpc   config get github.repo",
        timeout_ms: 10_000,
      }),
    ).toBe("jr-rpc config get github.repo");
  });

  it("shows the dispatched tool and its arguments for executeTool", () => {
    expect(
      toolCallPreview("executeTool", {
        tool_name: "github_search",
        arguments: { query: "is:pr is:open", limit: 25 },
      }),
    ).toBe('github_search, query: "is:pr is:open", limit: 25');
  });

  it("shows only the skill name for loadSkill", () => {
    expect(
      toolCallPreview("loadSkill", {
        skill_name: "github",
        ignored: "value",
      }),
    ).toBe("github");
  });

  it("shows only the query for webSearch", () => {
    expect(
      toolCallPreview("webSearch", {
        query: "service:checkout status:error",
        max_results: 50,
      }),
    ).toBe("service:checkout status:error");
  });

  it("bounds long values and long argument lists", () => {
    const preview = toolCallPreview("demo", {
      first: "x".repeat(100),
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
    });

    expect(preview?.length).toBeLessThanOrEqual(120);
    expect(preview).toContain("…");
    expect(preview).not.toContain("fifth");
  });
});
