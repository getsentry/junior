import { describe } from "vitest";
import { slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: OAuth Workflows", () => {
  const mcpAuthResumeThread = {
    id: "thread-auth-resume",
    channel_id: "C-auth-resume",
    thread_ts: "17000000.auth-resume",
  };

  slackEval("oauth: mcp skill auth resume keeps prior thread context", {
    behavior: {
      auto_complete_mcp_oauth: ["eval-auth"],
      plugin_dirs: ["evals/plugins"],
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
    behavior: {
      auto_complete_oauth: ["eval-oauth"],
      plugin_dirs: ["evals/plugins"],
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
});
