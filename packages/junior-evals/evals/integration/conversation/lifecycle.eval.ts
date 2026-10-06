import { defineJuniorPlugins } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedMcpToolCalls,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

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
    // The runtime records the interrupted call as timed out and resumes the
    // turn, so the resumed turn knows that the push happened.
    const { run } = await agent({
      plugins: defineJuniorPlugins([evalOperation]),
      limits: { turnTimeoutMs: 15_000 },
    });
    const conversation = await run(
      mention(
        "Ship the release with mcp__eval-operation__release-push, then tell me the final remote status from mcp__eval-operation__release-status.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The final reply reports that the remote release status is shipped.",
          "The assistant continues after the interrupted push and bases the answer on the observed remote state.",
        ],
        fail: [
          "The reply only reports that the work was interrupted or timed out.",
          "The assistant asks the user to retry instead of completing the task.",
        ],
      }),
    );

    const [interruptedPush] = completedMcpToolCalls(
      "mcp__eval-operation__release-push",
      conversation,
    );
    expect(interruptedPush && toolOutput(interruptedPush)).toMatchObject({
      timed_out: true,
    });
    // Whether the agent verifies remote state before pushing again is model
    // judgment, measured by the rubric.
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(
      completedMcpToolCalls(
        "mcp__eval-operation__release-status",
        conversation,
      ),
    ).not.toHaveLength(0);
    expect(conversation.replies).toHaveLength(1);
  });
});
