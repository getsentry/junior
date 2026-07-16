import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import type { HarnessRun } from "vitest-evals/harness";
import { expect } from "vitest";
import {
  authorizationCompletions,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";
import { readEvalEgressFixtureState } from "../../src/setup";

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
    ]),
  );
  expect(evalOauthIdentityCalls(result)).not.toHaveLength(0);
}

function evalOauthIdentityCalls(result: EvalRun) {
  return toolCalls(result.session).filter((call) => {
    const command = call.arguments?.command;
    return (
      call.name === "bash" &&
      typeof command === "string" &&
      command.includes(
        "curl -fsSL https://example.com/junior-eval-oauth/whoami",
      )
    );
  });
}

function matchingToolCalls(
  result: EvalRun,
  name: string,
  argumentsMatch: Record<string, unknown>,
) {
  return toolCalls(result.session).filter(
    (call) =>
      call.name === name &&
      Object.entries(argumentsMatch).every(
        ([key, value]) => call.arguments?.[key] === value,
      ),
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
    thread_ts: "17000000.1001",
  };

  it("when MCP auth pauses a turn, resume and reuse the stored credential on the next turn", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_mcp_oauth: ["eval-auth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        threadMessage("Remember: the budget deadline is Friday.", {
          thread: mcpAuthResumeThread,
          is_mention: false,
        }),
      ],
      events: [
        threadMessage(
          "/eval-auth Connect, then tell me the budget deadline I mentioned.",
          { thread: mcpAuthResumeThread, is_mention: true },
        ),
        threadMessage(
          "/eval-auth Use the connection again and confirm the lookup works.",
          { thread: mcpAuthResumeThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
          "The later request also completes successfully using the demo MCP connection.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    expect(authorizationCompletions(result)).toEqual([
      {
        credentialStored: true,
        delivery: "ephemeral",
        kind: "mcp",
        provider: "eval-auth",
        userId: "U0TEST",
      },
    ]);
    expect(
      matchingToolCalls(result, "callMcpTool", {
        tool_name: "mcp__eval-auth__budget-echo",
      }),
    ).toHaveLength(2);
    expectNoPublicOAuthUrl(result);
    expectFinalThreadReply(result, mcpAuthResumeThread, /\bFriday\b/i);
  });

  const oauthResumeThread = {
    id: "thread-oauth-resume",
    channel_id: "COAUTHRESUME",
    thread_ts: "17000000.1002",
  };

  it("when generic OAuth pauses a turn, resume and reuse the stored credential on the next turn", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        threadMessage("Remember: the budget deadline is Friday.", {
          thread: oauthResumeThread,
          is_mention: false,
        }),
      ],
      events: [
        threadMessage(
          "/eval-oauth Connect, then tell me the budget deadline I mentioned.",
          { thread: oauthResumeThread, is_mention: true },
        ),
        threadMessage(
          "/eval-oauth Check again and tell me which eval identity is active.",
          { thread: oauthResumeThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
          "The later request identifies the connected account as eval-oauth-user.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    });
    expectNoPublicOAuthUrl(result);
    expect(authorizationCompletions(result)).toEqual([
      {
        credentialStored: true,
        delivery: "ephemeral",
        kind: "plugin",
        provider: "eval-oauth",
        userId: "U0TEST",
      },
    ]);
    expectEvalOauthIdentityCheck(result);
    expect(evalOauthIdentityCalls(result).length).toBeGreaterThanOrEqual(3);
    expectFinalThreadReply(result, oauthResumeThread, /\bFriday\b/i);
    expectFinalThreadReply(result, oauthResumeThread, /eval-oauth-user/i);
  });

  const oauthRefreshThread = {
    id: "thread-oauth-refresh",
    channel_id: "COAUTHREFRESH",
    thread_ts: "17000000.1004",
  };

  it("refreshes an expired generic OAuth credential during a normal turn", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        expired_oauth_tokens: ["eval-oauth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        threadMessage(
          "/eval-oauth Tell me which eval identity is currently active.",
          { thread: oauthRefreshThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The response identifies the active account as eval-oauth-user.",
          "The request completes without asking the user to authorize or reconnect.",
        ],
        fail: [
          "Do not post a generic failure message.",
          "Do not ask the user to authorize, connect, or reconnect the account.",
        ],
      }),
    });

    expectEvalOauthIdentityCheck(result);
    expect(authorizationCompletions(result)).toEqual([]);
    expect(
      await readEvalEgressFixtureState<{
        evalOAuthRefreshTokens: string[];
      }>(),
    ).toEqual({ evalOAuthRefreshTokens: ["eval-oauth-refresh-token"] });
    expectFinalThreadReply(result, oauthRefreshThread, /eval-oauth-user/i);
  });

  const oauthReconnectThread = {
    id: "thread-oauth-reconnect",
    channel_id: "COAUTHRECONNECT",
    thread_ts: "17000000.1003",
  };

  it("when the user explicitly asks to reconnect, confirm reconnection without auto-resuming another task", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        threadMessage(
          "Disconnect my eval-oauth account and reconnect it so we can test the auth flow.",
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
    expect(authorizationCompletions(result)).toEqual([
      {
        credentialStored: true,
        delivery: "ephemeral",
        kind: "plugin",
        provider: "eval-oauth",
        userId: "U0TEST",
      },
    ]);
    expectEvalOauthIdentityCheck(result);
    expectFinalThreadReply(
      result,
      oauthReconnectThread,
      /connected|reconnected/i,
    );
  });
});
