import { describe, expect, it } from "vitest";

import {
  formatToolStatus,
  formatToolStatusWithInput,
} from "@/chat/runtime/tool-status";

describe("tool status formatters", () => {
  it("avoids infrastructure language in shell statuses", () => {
    expect(formatToolStatus("bash")).toBe("Working in the shell");
    expect(formatToolStatusWithInput("bash", { command: "pnpm test" })).toBe(
      "Running pnpm",
    );
    expect(
      formatToolStatusWithInput("bash", {
        command: 'CI=1 DEBUG=1 "/usr/local/bin/pnpm" test',
      }),
    ).toBe("Running pnpm");
  });

  it("keeps file statuses free of sandbox wording", () => {
    expect(
      formatToolStatusWithInput("readFile", { path: "/workspace/src/app.ts" }),
    ).toBe("Reading file app.ts");
    expect(
      formatToolStatusWithInput("writeFile", { path: "/workspace/src/app.ts" }),
    ).toBe("Updating file app.ts");
  });

  it("keeps MCP dispatcher statuses functional", () => {
    expect(
      formatToolStatusWithInput("searchTools", { query: "holiday schedule" }),
    ).toBe('Searching tools for "holiday schedule"');
    expect(
      formatToolStatusWithInput("searchTools", {
        query: "holiday schedule",
        provider: "notion",
      }),
    ).toBe('Searching notion tools for "holiday schedule"');
    expect(
      formatToolStatusWithInput("useTool", {
        tool_name: "mcp__notion__notion-search",
      }),
    ).toBe("Running notion/notion-search");
  });
});
