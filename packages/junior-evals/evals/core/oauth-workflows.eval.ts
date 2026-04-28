import { describe } from "vitest";
import { rubric, slackEval, threadMessage } from "../helpers";

describe("OAuth Workflows", () => {
  const mcpAuthResumeThread = {
    id: "thread-auth-resume",
    channel_id: "C-auth-resume",
    thread_ts: "17000000.auth-resume",
  };

  slackEval(
    "when MCP auth pauses a turn, resume in the same thread with prior context intact",
    {
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
      taskTimeout: 120_000,
      timeout: 300_000,
      criteria: rubric({
        contract:
          "After MCP authorization completes, the same thread gets a resumed answer that keeps prior context.",
        pass: [
          "assistant_posts includes an access-needed message for Eval-auth.",
          "channel_posts or assistant_posts includes a same-thread resumed answer.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
        ],
        allow: [
          "A concise resumed answer that only restates the budget deadline is acceptable.",
          "A brief connection or continuation notice is acceptable before the resumed answer.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    },
  );

  const oauthResumeThread = {
    id: "thread-oauth-resume",
    channel_id: "C-oauth-resume",
    thread_ts: "17000000.oauth-resume",
  };

  slackEval(
    "when generic OAuth pauses a turn, resume in the same thread with prior context intact",
    {
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
      taskTimeout: 120_000,
      timeout: 300_000,
      criteria: rubric({
        contract:
          "After generic OAuth authorization completes, the same thread gets a connection notice and a resumed answer that keeps prior context.",
        pass: [
          "The same thread gets a connection or continuation notice that makes it clear the original request is continuing.",
          "The same thread then gets a resumed answer.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
        ],
        allow: [
          "A concise resumed answer that only restates the budget deadline is acceptable.",
          "A brief connection notice is acceptable before the resumed answer.",
        ],
        fail: [
          "Do not ask the user to repeat the deadline.",
          "Do not behave as if prior thread context was lost.",
          "Do not post a generic failure message.",
        ],
      }),
    },
  );

  const oauthReconnectThread = {
    id: "thread-oauth-reconnect",
    channel_id: "C-oauth-reconnect",
    thread_ts: "17000000.oauth-reconnect",
  };

  slackEval(
    "when the user explicitly asks to reconnect, confirm reconnection without auto-resuming another task",
    {
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
      taskTimeout: 120_000,
      timeout: 300_000,
      criteria: rubric({
        contract:
          "An explicit reconnect request can drive a fresh authorization cycle to completion in the same thread.",
        pass: [
          "The thread gets a connected or processing notice in the same thread.",
          "The reconnect flow ends with a short connected confirmation or success follow-up in the same thread.",
        ],
        allow: [
          "A brief 'Processing your request' continuation notice is acceptable if the final follow-up stays focused on the reconnect result.",
          "The auth-link handoff itself may happen off-thread and does not need to appear in the visible thread transcript.",
        ],
        fail: [
          "Do not ask the user to click a second auth link for the same turn.",
          "Do not post a generic failure message.",
        ],
      }),
    },
  );
});
