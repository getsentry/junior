import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { planToolExposure } from "@/chat/tool-exposure";
import { tool, type AnyToolDefinition } from "@/chat/tool-support/definition";
import {
  explainMissingToolResults,
  missingToolText,
  type ToolCallRoutes,
} from "@/chat/tool-support/missing-tool-result";

function demo(exposure?: "deferred" | "codemode"): AnyToolDefinition {
  return tool({
    description: "Demo",
    inputSchema: Type.Object({}),
    ...(exposure ? { exposure } : undefined),
  });
}

const planned = planToolExposure({
  bash: demo(),
  searchConversations: demo("deferred"),
  addReaction: demo("codemode"),
});

const routes: ToolCallRoutes = {
  catalogTools: planned.catalogTools,
  scriptTools: planned.scriptTools,
  modelToolNames: new Set(["bash", "executeTool", "searchTools", "codemode"]),
};

function result(
  toolCallId: string,
  toolName: string,
  text: string,
  isError = true,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: {},
    isError,
    timestamp: 1,
  };
}

describe("missingToolText", () => {
  it.each([
    [
      "searchConversations",
      "`searchConversations` is a catalog tool, not in your tool list. Call executeTool with tool_name `searchConversations` and the same arguments.",
    ],
    [
      "addReaction",
      "`addReaction` is not in your tool list. Call it in a codemode script as `tools.addReaction(args)` with the same arguments.",
    ],
    [
      "searchConversation",
      "`searchConversation` is not a tool. Did you mean `searchConversations`? Call a tool in your tool list directly, and any other catalog tool through executeTool.",
    ],
    [
      "launchRocket",
      "`launchRocket` is not a tool. Call searchTools to find its exact name.",
    ],
  ])("names the next call for %s", (name, text) => {
    expect(missingToolText(name, routes)).toBe(text);
  });

  it("does not send a script-only tool to Code Mode when Code Mode is off", () => {
    expect(
      missingToolText("addReaction", {
        ...routes,
        modelToolNames: new Set(["bash", "executeTool", "searchTools"]),
      }),
    ).toBe(
      "`addReaction` is not a tool. Call searchTools to find its exact name.",
    );
  });
});

describe("explainMissingToolResults", () => {
  it("replaces only Pi's not-found results of the newest step", () => {
    const earlier = result(
      "a",
      "searchConversations",
      "Tool searchConversations not found",
    );
    const missing = result(
      "b",
      "searchConversations",
      "Tool searchConversations not found",
    );
    const direct = result("c", "bash", "Tool bash not found");
    const truncated = result(
      "d",
      "searchConversations",
      'Tool call "searchConversations" was not executed: the response hit the output token limit.',
    );
    const step = [missing, direct, truncated];
    const messages: PiMessage[] = [earlier, ...step];

    const explained = explainMissingToolResults(messages, step, routes);

    expect(explained).toEqual([
      earlier,
      {
        ...missing,
        content: [
          {
            type: "text",
            text: missingToolText("searchConversations", routes),
          },
        ],
      },
      direct,
      truncated,
    ]);
  });

  it("returns undefined when no result changes", () => {
    const step = [result("a", "bash", "ok", false)];
    expect(explainMissingToolResults(step, step, routes)).toBeUndefined();
  });
});
