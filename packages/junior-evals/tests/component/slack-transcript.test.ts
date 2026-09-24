import { expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentRun } from "@/chat/agent/types";

// The scenario preloads the first exchange through the runtime stores and
// delivers one real reply through the agent's delivery port.
vi.mock("@/chat/agent", () => ({
  executeAgentRun: vi.fn(async (run: AgentRun) => {
    await run.delivery?.(fauxAssistantMessage("**6**"));
    return {
      status: "completed",
      result: {
        text: "**6**",
        diagnostics: { outcome: "success", modelId: "eval-test" },
      },
    };
  }),
}));

import { runEvalScenario } from "../../src/behavior-harness";
import { toEvalHarnessRun } from "../../src/eval-result";
import {
  mention,
  reply,
  threadMessage,
  serializeVisibleTranscript,
} from "../../src/helpers";

it("records preloaded history and each delivered reply once, in turn order", async () => {
  const thread = {
    id: "slack:CTRANSCRIPT:17000000.1",
    channel_id: "CTRANSCRIPT",
    thread_ts: "17000000.1",
  };
  const result = await runEvalScenario({
    history: [mention("What is 2+2?", { thread }), reply("**4**", { thread })],
    initialEvents: [threadMessage("And 3+3?", { thread, is_mention: true })],
  });
  expect(result.posts.map((post) => post.text)).toEqual(["**6**"]);
  expect(
    JSON.parse(serializeVisibleTranscript(toEvalHarnessRun(result, 0).session)),
  ).toEqual([
    { role: "user", author: "Test User", content: "What is 2+2?" },
    { role: "assistant", content: "**4**" },
    { role: "user", author: "Test User", content: "And 3+3?" },
    { role: "assistant", content: "**6**" },
  ]);
});
