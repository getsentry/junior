import { defineJuniorPlugins } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect } from "vitest";
import { mention } from "../../../src/fixture/inputs";
import { rubric } from "../../../src/fixture/judge";
import { completedToolCalls } from "../../../src/fixture/results";
import { test } from "../../../src/fixture/test";

/** Release tools of the eval MCP server. */
const evalOperation = defineJuniorPlugin({
  manifest: {
    name: "eval-operation",
    displayName: "Eval Operation",
    description: "Eval release operations",
    mcp: {
      transport: "http",
      url: "https://eval-mcp.example.test/mcp",
      allowedTools: ["release-push", "release-status"],
    },
  },
});

/** The MCP call of one eval-operation tool, by tool name. */
function evalOperationCalls(
  conversation: Parameters<typeof completedToolCalls>[1],
  tool: string,
) {
  return completedToolCalls("callMcpTool", conversation).filter(
    (call) =>
      (call.input as { tool_name?: unknown } | undefined)?.tool_name ===
      `mcp__eval-operation__${tool}`,
  );
}

describe("Lifecycle and Resilience", () => {
  test("when the first human message lands, store a conversation title", async ({
    run,
  }) => {
    const conversation = await run(
      mention("How do I debug a Node.js memory leak in production?"),
    );

    expect(conversation.title).toMatch(/leak/i);
  });

  test("when a tool call is interrupted at a turn deadline, continue the task to completion", async ({
    agent,
  }) => {
    // The first release push lands remotely but stalls past the turn deadline.
    // The runtime records the interrupted call and resumes the turn.
    const { run } = await agent({
      plugins: defineJuniorPlugins([evalOperation]),
      limits: { turnTimeoutMs: 15_000 },
    });
    const conversation = await run(
      mention(
        "Ship the release with mcp__eval-operation__release-push, then tell me the final remote status from mcp__eval-operation__release-status.",
      ),
      {
        criteria: rubric({
          pass: [
            "The final reply reports that the remote release status is shipped.",
            "The assistant continues after the interrupted push and bases the answer on the observed remote state.",
          ],
          fail: [
            "The reply only reports that the work was interrupted or timed out.",
            "The assistant asks the user to retry instead of completing the task.",
          ],
        }),
      },
    );

    // Whether the agent verifies remote state before pushing again is model
    // judgment, measured by the rubric.
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(evalOperationCalls(conversation, "release-status")).not.toHaveLength(
      0,
    );
    expect(conversation.replies).toHaveLength(1);
  });
});
