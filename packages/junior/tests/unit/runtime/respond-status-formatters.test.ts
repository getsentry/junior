import { describe, expect, it } from "vitest";

import { makeAssistantStatus } from "@/chat/runtime/assistant-status";
import { buildToolStatus } from "@/chat/runtime/tool-status";

describe("tool status formatters", () => {
  it("avoids infrastructure language in shell statuses", () => {
    expect(buildToolStatus("bash", {})).toEqual(
      makeAssistantStatus("running", "shell"),
    );
    expect(buildToolStatus("bash", { command: "pnpm test" })).toEqual(
      makeAssistantStatus("running", "pnpm"),
    );
    expect(
      buildToolStatus("bash", {
        command: 'CI=1 DEBUG=1 "/usr/local/bin/pnpm" test',
      }),
    ).toEqual(makeAssistantStatus("running", "pnpm"));
  });

  it("keeps file statuses free of sandbox wording", () => {
    expect(
      buildToolStatus("readFile", { path: "/workspace/src/app.ts" }),
    ).toEqual(makeAssistantStatus("reading", "app.ts"));
    expect(
      buildToolStatus("writeFile", { path: "/workspace/src/app.ts" }),
    ).toEqual(makeAssistantStatus("updating", "app.ts"));
  });

  it("formats MCP tool names as provider/tool", () => {
    expect(buildToolStatus("mcp__notion__notion-search", {})).toEqual(
      makeAssistantStatus("running", "notion/notion-search"),
    );
    expect(buildToolStatus("mcp__demo__ping", {})).toEqual(
      makeAssistantStatus("running", "demo/ping"),
    );
  });

  it("keeps MCP dispatcher statuses functional", () => {
    expect(
      buildToolStatus("searchTools", { query: "holiday schedule" }),
    ).toEqual(makeAssistantStatus("searching", '"holiday schedule"'));
    expect(
      buildToolStatus("searchTools", {
        query: "holiday schedule",
        provider: "notion",
      }),
    ).toEqual(makeAssistantStatus("searching", 'notion "holiday schedule"'));
  });
});
