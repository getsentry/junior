import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import type { HarnessRun } from "vitest-evals/harness";
import { beforeAll, expect } from "vitest";
import {
  assistantTextContent,
  authorizationCompletions,
  rubric,
  slackEvals,
  threadMessage,
  visibleAssistantText,
} from "../../../src/helpers";
import { readEvalEgressFixtureState } from "../../../src/setup";
import { warmSandboxSnapshot } from "../../../src/snapshot-warmup";

type EvalRun = HarnessRun;
const SNAPSHOT_WARMUP_TIMEOUT_MS = 10 * 60 * 1000;

function publicOAuthUrls(result: EvalRun): string[] {
  return (
    visibleAssistantText(result.session).match(
      /https?:\/\/[^\s|>]*(?:oauth|authorize|callback)[^\s|>]*/gi,
    ) ?? []
  );
}

function evalOauthIdentityCalls(result: EvalRun) {
  return toolCalls(result.session).filter((call) => {
    const command = call.arguments?.command;
    return (
      call.name === "bash" &&
      typeof command === "string" &&
      command.includes("https://example.com/junior-eval-oauth/whoami")
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

function matchingThreadReplies(
  result: EvalRun,
  thread: { channel_id: string; thread_ts: string },
  pattern: RegExp,
) {
  return assistantMessages(result.session).filter(
    (message) =>
      message.metadata?.channel === thread.channel_id &&
      message.metadata?.thread_ts === thread.thread_ts &&
      pattern.test(assistantTextContent(message.content)),
  );
}

describeEval("OAuth Workflows", slackEvals, (it) => {
  beforeAll(async () => {
    await warmSandboxSnapshot();
  }, SNAPSHOT_WARMUP_TIMEOUT_MS);

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
          "A one-time Eval Auth authorization notice before the connection completes is expected and does not count as a failure.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "After authorization completes, do not claim Eval Auth is unavailable, ask the user to reconnect, or post a generic failure message.",
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
    expect(publicOAuthUrls(result)).toEqual([]);
    expect(
      matchingThreadReplies(result, mcpAuthResumeThread, /\bFriday\b/i),
    ).not.toHaveLength(0);
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
          "A one-time eval-oauth authorization notice before the connection completes is expected and does not count as a failure.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "After authorization completes, do not claim eval-oauth is unavailable, ask the user to reconnect, or post a generic failure message.",
        ],
      }),
    });
    expect(publicOAuthUrls(result)).toEqual([]);
    expect(authorizationCompletions(result)).toEqual([
      {
        credentialStored: true,
        delivery: "ephemeral",
        kind: "plugin",
        provider: "eval-oauth",
        userId: "U0TEST",
      },
    ]);
    expect(
      matchingToolCalls(result, "loadSkill", { skill_name: "eval-oauth" }),
    ).toHaveLength(0);
    expect(evalOauthIdentityCalls(result)).not.toHaveLength(0);
    expect(evalOauthIdentityCalls(result).length).toBeGreaterThanOrEqual(3);
    expect(
      matchingThreadReplies(result, oauthResumeThread, /\bFriday\b/i),
    ).not.toHaveLength(0);
    expect(
      matchingThreadReplies(result, oauthResumeThread, /eval-oauth-user/i),
    ).not.toHaveLength(0);
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
    });

    expect(publicOAuthUrls(result)).toEqual([]);
    expect(authorizationCompletions(result)).toEqual([]);
    const fixtureState = await readEvalEgressFixtureState<{
      evalOAuthIdentityRequests: number;
      evalOAuthRefreshTokens: string[];
    }>();
    expect(fixtureState.evalOAuthRefreshTokens).toContain(
      "eval-oauth-refresh-token",
    );
    expect(fixtureState.evalOAuthIdentityRequests).toBeGreaterThanOrEqual(1);
    expect(
      matchingThreadReplies(result, oauthRefreshThread, /eval-oauth-user/i),
    ).not.toHaveLength(0);
  });

  const oauthConnectThread = {
    id: "thread-oauth-connect",
    channel_id: "COAUTHCONNECT",
    thread_ts: "17000000.1003",
  };

  it("when the user explicitly asks to connect, confirm the completed connection", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_oauth: ["eval-oauth"],
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        threadMessage("Connect my eval-oauth account so I can use it here.", {
          thread: oauthConnectThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "After authorization completes, the assistant briefly confirms that the eval-oauth account is ready to use.",
        ],
        fail: [
          "Do not ask the user to authorize again after the connection has already completed.",
          "Do not post a generic failure message.",
          "Do not invent or continue with an unrelated task after confirming the connection.",
        ],
      }),
    });
    expect(publicOAuthUrls(result)).toEqual([]);
    expect(authorizationCompletions(result)).toEqual([
      {
        credentialStored: true,
        delivery: "ephemeral",
        kind: "plugin",
        provider: "eval-oauth",
        userId: "U0TEST",
      },
    ]);
    expect(
      matchingToolCalls(result, "loadSkill", { skill_name: "eval-oauth" }),
    ).not.toHaveLength(0);
    expect(evalOauthIdentityCalls(result)).not.toHaveLength(0);
    expect(
      matchingThreadReplies(result, oauthConnectThread, /\S/),
    ).not.toHaveLength(0);
  });
});
