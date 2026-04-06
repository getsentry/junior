import { describe } from "vitest";
import { slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: OAuth Workflows", () => {
  const mcpAuthResumeThread = {
    id: "thread-auth-resume",
    channel_id: "C-auth-resume",
    thread_ts: "17000000.auth-resume",
  };

  slackEval("oauth: mcp skill auth resume keeps prior thread context", {
    overrides: {
      auto_complete_mcp_oauth: ["eval-auth"],
      plugin_dirs: ["evals/fixtures/plugins"],
    },
    events: [
      threadMessage("Remember this for later: the budget deadline is Friday.", {
        thread: mcpAuthResumeThread,
        is_mention: false,
      }),
      threadMessage(
        "<@U_APP> /eval-auth Use the demo MCP connection, then tell me what budget deadline I mentioned earlier.",
        { thread: mcpAuthResumeThread, is_mention: true },
      ),
    ],
    taskTimeout: 120_000,
    timeout: 300_000,
    criteria:
      "After the second turn starts the eval MCP skill workflow, it pauses for MCP authorization, then after the real callback/resume path it posts a connection or continuation notice and a resumed answer in the same thread. The resumed answer explicitly says the budget deadline mentioned earlier was Friday. It must not ask the user to repeat the deadline, behave as if prior thread context was lost, or post a generic failure message.",
  });

  const oauthResumeThread = {
    id: "thread-oauth-resume",
    channel_id: "C-oauth-resume",
    thread_ts: "17000000.oauth-resume",
  };

  slackEval("oauth: generic skill auth resume keeps prior thread context", {
    overrides: {
      auto_complete_oauth: ["eval-oauth"],
      plugin_dirs: ["evals/fixtures/plugins"],
    },
    events: [
      threadMessage("Remember this for later: the budget deadline is Friday.", {
        thread: oauthResumeThread,
        is_mention: false,
      }),
      threadMessage(
        "<@U_APP> /eval-oauth Connect the demo account, then tell me what budget deadline I mentioned earlier.",
        { thread: oauthResumeThread, is_mention: true },
      ),
    ],
    taskTimeout: 120_000,
    timeout: 300_000,
    criteria:
      "After the second turn starts the eval generic OAuth skill workflow, it pauses for generic OAuth authorization, then after the real callback/resume path it posts a connection or continuation notice and a resumed answer in the same thread. The resumed answer explicitly says the budget deadline mentioned earlier was Friday. It must not ask the user to repeat the deadline, behave as if prior thread context was lost, or post a generic failure message.",
  });

  const oauthReconnectThread = {
    id: "thread-oauth-reconnect",
    channel_id: "C-oauth-reconnect",
    thread_ts: "17000000.oauth-reconnect",
  };

  slackEval("oauth: explicit reconnect request does not auto-resume", {
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
    criteria:
      "The assistant treats this as an explicit reconnect request: it may unlink first, then it sends a private auth link and stops. After the OAuth callback, the thread gets a simple connected confirmation. It must not post a 'Processing your request' continuation message, ask the user to click a second auth link for the same turn, or behave as if there is a pending non-auth request to resume.",
  });
});
