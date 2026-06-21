import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import type { HarnessRun } from "vitest-evals/harness";
import { expect } from "vitest";
import { rubric, slackEvals, threadMessage } from "../../src/helpers";

type EvalRun = HarnessRun;

function textContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function expectNoPublicOAuthUrl(result: EvalRun): void {
  const visibleText = assistantMessages(result.session)
    .map((message) => textContent(message.content))
    .join("\n");
  expect(visibleText).not.toMatch(
    /https?:\/\/[^\s|>]*(oauth|authorize|callback)[^\s|>]*/i,
  );
}

function expectEvalOauthIdentityCheck(result: EvalRun): void {
  expect(toolCalls(result.session)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "loadSkill",
        arguments: expect.objectContaining({
          skill_name: "eval-oauth",
        }),
      }),
      expect.objectContaining({
        name: "bash",
        arguments: expect.objectContaining({
          command: "curl -fsSL https://example.com/junior-eval-oauth/whoami",
        }),
      }),
    ]),
  );
}

function expectFinalThreadReply(
  result: EvalRun,
  thread: { channel_id: string; thread_ts: string },
  pattern: RegExp,
): void {
  const matchingPosts = assistantMessages(result.session).filter(
    (message) =>
      message.metadata?.channel === thread.channel_id &&
      message.metadata?.thread_ts === thread.thread_ts &&
      pattern.test(textContent(message.content)),
  );
  expect(matchingPosts.length).toBeGreaterThan(0);
}

describeEval("OAuth Workflows", slackEvals, (it) => {
  const mcpAuthResumeThread = {
    id: "thread-auth-resume",
    channel_id: "CAUTHRESUME",
    thread_ts: "17000000.auth-resume",
  };

  it("when MCP auth pauses a turn, resume in the same thread with prior context intact", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_mcp_oauth: ["eval-auth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      events: [
        threadMessage(
          "Remember this for later: the budget deadline is Friday.",
          {
            thread: mcpAuthResumeThread,
            is_mention: false,
          },
        ),
        threadMessage(
          "<@U_APP> /eval-auth Use the demo MCP connection, then tell me what budget deadline I mentioned earlier.",
          { thread: mcpAuthResumeThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The same Slack thread later gets a resumed answer after authorization completes.",
          "Because the eval harness auto-completes MCP authorization off-transcript, treat a later same-thread resumed answer as evidence that authorization completed.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
        ],
        fail: [
          "Do not post the authorization URL in the public thread.",
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    expectNoPublicOAuthUrl(result);
    expectFinalThreadReply(result, mcpAuthResumeThread, /\bFriday\b/i);
  });

  const oauthResumeThread = {
    id: "thread-oauth-resume",
    channel_id: "COAUTHRESUME",
    thread_ts: "17000000.oauth-resume",
  };

  it("when generic OAuth pauses a turn, resume in the same thread with prior context intact", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      events: [
        threadMessage(
          "Remember this for later: the budget deadline is Friday.",
          {
            thread: oauthResumeThread,
            is_mention: false,
          },
        ),
        threadMessage(
          "<@U_APP> /eval-oauth Connect the demo account, then tell me what budget deadline I mentioned earlier.",
          { thread: oauthResumeThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The same Slack thread gets a resumed answer after authorization completes.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
        ],
        fail: [
          "Do not post the authorization URL in the public thread.",
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    expectNoPublicOAuthUrl(result);
    expectEvalOauthIdentityCheck(result);
    expectFinalThreadReply(result, oauthResumeThread, /\bFriday\b/i);
  });

  const oauthReconnectThread = {
    id: "thread-oauth-reconnect",
    channel_id: "COAUTHRECONNECT",
    thread_ts: "17000000.oauth-reconnect",
  };

  it("when the user explicitly asks to reconnect, confirm reconnection without auto-resuming another task", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      events: [
        threadMessage(
          "<@U_APP> Disconnect my eval-oauth account and reconnect it so we can test the auth flow.",
          { thread: oauthReconnectThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The thread gets a connected or processing notice in the same thread.",
          "The reconnect flow ends with a short connected confirmation or success follow-up in the same thread.",
        ],
        fail: [
          "Do not ask the user to authorize again after the reconnect has already completed.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    expectNoPublicOAuthUrl(result);
    expectEvalOauthIdentityCheck(result);
    expectFinalThreadReply(
      result,
      oauthReconnectThread,
      /connected|reconnected/i,
    );
  });
});
