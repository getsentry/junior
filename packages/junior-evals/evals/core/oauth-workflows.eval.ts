import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { rubric, slackEvals, threadMessage } from "../helpers";

type EvalOutput = {
  assistant_posts?: Array<{
    text?: string;
    channel?: string;
    thread_ts?: string;
  }>;
  observed_tool_invocations?: Array<{
    tool?: string;
    skill_name?: string;
    bash_command?: string;
  }>;
};

function outputOf(result: { output?: unknown }): EvalOutput {
  return (result.output ?? {}) as EvalOutput;
}

function postTexts(output: EvalOutput): string[] {
  return output.assistant_posts?.map((post) => post.text ?? "") ?? [];
}

function expectNoPublicOAuthUrl(output: EvalOutput): void {
  expect(postTexts(output).join("\n")).not.toMatch(
    /https?:\/\/[^\s|>]*(oauth|authorize|callback)[^\s|>]*/i,
  );
}

function expectEvalOauthIdentityCheck(output: EvalOutput): void {
  expect(output.observed_tool_invocations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        tool: "loadSkill",
        skill_name: "eval-oauth",
      }),
      expect.objectContaining({
        tool: "bash",
        bash_command: "curl -fsSL https://example.com/junior-eval-oauth/whoami",
      }),
    ]),
  );
}

function expectFinalThreadReply(
  output: EvalOutput,
  thread: { channel_id: string; thread_ts: string },
  pattern: RegExp,
): void {
  const matchingPosts =
    output.assistant_posts?.filter(
      (post) =>
        post.channel === thread.channel_id &&
        post.thread_ts === thread.thread_ts &&
        pattern.test(post.text ?? ""),
    ) ?? [];
  expect(matchingPosts.length).toBeGreaterThan(0);
}

describeEval("OAuth Workflows", slackEvals, (it) => {
  const mcpAuthResumeThread = {
    id: "thread-auth-resume",
    channel_id: "C-auth-resume",
    thread_ts: "17000000.auth-resume",
  };

  it("when MCP auth pauses a turn, resume in the same thread with prior context intact", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_mcp_oauth: ["eval-auth"],
        plugin_dirs: ["evals/fixtures/plugins"],
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
        contract:
          "After MCP authorization completes, the same thread gets a resumed answer that keeps prior context.",
        pass: [
          "The same Slack thread later gets a resumed answer after authorization completes.",
          "Because the eval harness auto-completes MCP authorization off-transcript, treat a later same-thread resumed answer as evidence that authorization completed.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
        ],
        allow: [
          "A private auth-link handoff is expected and does not need to appear in assistant_posts.",
          "A single URL-free public acknowledgement that authorization is needed, including a note to check the private link, is acceptable before the resumed answer.",
          "A concise resumed answer that only restates the budget deadline is acceptable.",
          "A brief connection or continuation notice is acceptable before the resumed answer.",
        ],
        fail: [
          "Do not post the authorization URL in the public thread.",
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    const output = outputOf(result);
    expectNoPublicOAuthUrl(output);
    expectFinalThreadReply(output, mcpAuthResumeThread, /\bFriday\b/i);
  });

  const oauthResumeThread = {
    id: "thread-oauth-resume",
    channel_id: "C-oauth-resume",
    thread_ts: "17000000.oauth-resume",
  };

  it("when generic OAuth pauses a turn, resume in the same thread with prior context intact", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["evals/fixtures/plugins"],
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
        contract:
          "After generic OAuth authorization completes, the same thread gets a resumed answer that keeps prior context.",
        pass: [
          "The same Slack thread gets a resumed answer after authorization completes.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
        ],
        allow: [
          "A private auth-link handoff is expected and does not need to appear in assistant_posts.",
          "A single URL-free public acknowledgement that authorization is needed, including a note to check the private link, is acceptable before the resumed answer.",
          "A concise resumed answer that only restates the budget deadline is acceptable.",
          "A brief connection or continuation notice is acceptable before the resumed answer or in the same message as the resumed answer.",
        ],
        fail: [
          "Do not post the authorization URL in the public thread.",
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    const output = outputOf(result);
    expectNoPublicOAuthUrl(output);
    expectEvalOauthIdentityCheck(output);
    expectFinalThreadReply(output, oauthResumeThread, /\bFriday\b/i);
  });

  const oauthReconnectThread = {
    id: "thread-oauth-reconnect",
    channel_id: "C-oauth-reconnect",
    thread_ts: "17000000.oauth-reconnect",
  };

  it("when the user explicitly asks to reconnect, confirm reconnection without auto-resuming another task", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["evals/fixtures/plugins"],
      },
      events: [
        threadMessage(
          "<@U_APP> Disconnect my eval-oauth account and reconnect it so we can test the auth flow.",
          { thread: oauthReconnectThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        contract:
          "An explicit reconnect request can drive a fresh authorization cycle to completion in the same thread.",
        pass: [
          "The thread gets a connected or processing notice in the same thread.",
          "The reconnect flow ends with a short connected confirmation or success follow-up in the same thread.",
        ],
        allow: [
          "A brief 'Processing your request' continuation notice is acceptable if the final follow-up stays focused on the reconnect result.",
          "A single initial auth-needed notice is acceptable before the harness auto-completes authorization.",
          "The auth-link handoff itself may happen off-thread and does not need to appear in the visible thread transcript.",
        ],
        fail: [
          "Do not ask the user to authorize again after the reconnect has already completed.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    const output = outputOf(result);
    expectNoPublicOAuthUrl(output);
    expectEvalOauthIdentityCheck(output);
    expectFinalThreadReply(
      output,
      oauthReconnectThread,
      /connected|reconnected/i,
    );
  });
});
