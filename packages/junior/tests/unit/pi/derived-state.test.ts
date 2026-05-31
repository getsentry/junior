import { describe, expect, it } from "vitest";
import {
  inferActiveMcpProvidersFromPiMessages,
  inferLoadedSkillNamesFromPiMessages,
} from "@/chat/pi/derived-state";
import type { PiMessage } from "@/chat/pi/messages";

describe("Pi derived state", () => {
  it("infers loaded skills and MCP providers from durable Pi messages", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "loadSkill",
        isError: false,
        details: {
          skill_name: "demo-skill",
          mcp_provider: "demo",
        },
        content: [{ type: "text", text: "loaded" }],
      },
      {
        role: "toolResult",
        toolName: "searchMcpTools",
        isError: false,
        details: {
          provider: "linear",
          tools: [{ tool_name: "mcp__linear__create_issue" }],
        },
        content: [{ type: "text", text: "listed tools" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "callMcpTool",
            arguments: {
              tool_name: "mcp__notion__search",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "callMcpTool",
        isError: false,
        input: {
          tool_name: "mcp__eval_auth__budget_echo",
        },
        content: [{ type: "text", text: "called tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The handoff mentioned mcp__github__search, but no tool used it.",
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "searchMcpTools",
        isError: true,
        details: {
          provider: "failed",
        },
        content: [{ type: "text", text: "failed" }],
      },
    ] as unknown as PiMessage[];

    expect(inferLoadedSkillNamesFromPiMessages(messages)).toEqual([
      "demo-skill",
    ]);
    expect(inferActiveMcpProvidersFromPiMessages(messages)).toEqual([
      "demo",
      "eval_auth",
      "linear",
      "notion",
    ]);
  });
});
