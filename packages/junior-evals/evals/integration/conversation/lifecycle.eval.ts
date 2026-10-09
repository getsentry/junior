import { defineJuniorPlugins } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect } from "vitest";
import { slackMention, reply, webMessage } from "@junior-evals/fixture/inputs";
import { rejectNextModelRequest } from "@junior-evals/fixture/gateway";
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

// With a 50,000 token context window, Junior compacts agent history above
// 45,000 estimated tokens. Junior estimates 4 characters for each token, so
// this log is about 51,000 tokens.
const SMALL_CONTEXT_WINDOW_TOKENS = 50_000;
const DEPLOY_LOG = Array.from(
  { length: 3_000 },
  (_, index) =>
    `2026-03-01T04:${String(index % 60).padStart(2, "0")}:00Z step ${String(index + 1).padStart(4, "0")} ok checksum ${String(index * 7919).padStart(12, "0")} region iad1`,
).join("\n");

describe("Lifecycle and Resilience", () => {
  test("when the first human message lands, store a conversation title", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("How do I debug a Node.js memory leak in production?"),
    );

    expect(conversation.title).toMatch(/leak/i);
  });

  // A Slack turn compacts history before the agent starts. A web turn
  // compacts it in the agent, before the first model request.
  test.for([
    { surface: "a Slack thread", message: slackMention },
    { surface: "a web conversation", message: webMessage },
  ])(
    "when the history of $surface does not fit the context window, compact it and answer from the summary",
    async ({ message }, { agent }) => {
      const { run } = await agent({
        limits: { contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS },
      });
      const conversation = await run(
        message("In one sentence, which date did we pick for the launch?"),
        {
          history: [
            message("We picked March 14 for the launch. Keep that in mind."),
            reply("Noted. The launch date is March 14."),
            message("Paste the full deploy log of build 7421."),
            reply(`Deploy log of build 7421:\n${DEPLOY_LOG}`),
          ],
        },
      );
      await expect(conversation).toSatisfyJudge(
        RubricJudge,
        rubric({ pass: ["The reply says the launch date is March 14."] }),
      );

      expect(conversation.compactions).toBeGreaterThan(0);
      expect(conversation.turns.map((turn) => turn.status)).toEqual([
        "succeeded",
      ]);
      expect(conversation.replies).toHaveLength(1);
    },
  );

  test("when a tool call is interrupted at a turn deadline, continue the task to completion with a message that arrived in between", async ({
    agent,
  }) => {
    // The first release push lands remotely but stalls past the turn deadline.
    // The runtime records the interrupted call as timed out and resumes the
    // turn, so the resumed turn knows that the push happened.
    // The deadline must fall during the push, not during the model requests
    // before it. Live model requests can take more than 15 seconds, so a run
    // that can make them needs 30 seconds. Strict replay returns every
    // request at once and never makes a live one, so 10 seconds are enough
    // there. The push stalls for 45 seconds.
    // A person writes again while the turn waits to continue. The continued
    // turn takes that message too.
    const { run } = await agent({
      plugins: defineJuniorPlugins([evalOperation]),
      limits: {
        turnTimeoutMs:
          process.env.VITEST_EVALS_REPLAY_MODE === "replay" ? 10_000 : 30_000,
      },
    });
    let sentWhilePaused = false;
    const conversation = await run(
      slackMention(
        "Ship the release with mcp__eval-operation__release-push, then tell me the final remote status from mcp__eval-operation__release-status.",
      ),
      {
        onProgress: async (progress, { send }) => {
          if (progress.type === "paused" && !sentWhilePaused) {
            sentWhilePaused = true;
            await send(
              slackMention("Also end your reply with the line: Owner: Dana"),
            );
          }
        },
      },
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
    expect(sentWhilePaused).toBe(true);
    expect(conversation.replies[0]!.text).toContain("Owner: Dana");
  });

  test("when the model provider rejects a request, Junior posts a safe failure reply and answers the next message", async ({
    run,
  }) => {
    rejectNextModelRequest();
    const conversation = await run(
      slackMention("The code word for the launch is maple. Reply with: noted"),
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual(["failed"]);
    expect(conversation.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("content policy"),
    ]);
    // The reply does not have the text of the provider.
    expect(conversation.replies[0]!.text).not.toContain("flagged");
    expect(conversation.statuses[0]).not.toBe("");
    expect(conversation.statuses.at(-1)).toBe("");

    const next = await conversation.continue(
      slackMention("Which code word did I give you for the launch?"),
    );

    expect(next.turns.map((turn) => turn.status)).toEqual(["succeeded"]);
    expect(next.replies).toHaveLength(1);
    expect(next.replies[0]!.text).toMatch(/maple/i);
  });
});
