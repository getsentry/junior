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
          "After MCP authorization completes, the interrupted turn resumes in the same thread and keeps prior context.",
        pass: [
          "The workflow pauses for MCP authorization and then resumes through the real callback path.",
          "The thread gets a connection or continuation notice and then a resumed answer in the same thread.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
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
          "After generic OAuth authorization completes, the interrupted turn resumes in the same thread and keeps prior context.",
        pass: [
          "The workflow pauses for generic OAuth authorization and then resumes through the real callback path.",
          "The thread gets a connection or continuation notice and then a resumed answer in the same thread.",
          "The resumed answer explicitly says the earlier budget deadline was Friday.",
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
          "An explicit reconnect request performs the reconnect flow without resuming a non-auth task afterward.",
        pass: [
          "The assistant treats this as an explicit reconnect request.",
          "It may unlink first, then it sends a private auth link and stops.",
          "After the OAuth callback, the thread gets a simple connected confirmation.",
        ],
        fail: [
          "Do not post a 'Processing your request' continuation message.",
          "Do not ask the user to click a second auth link for the same turn.",
          "Do not behave as if there is a pending non-auth request to resume.",
        ],
      }),
    },
  );
});
