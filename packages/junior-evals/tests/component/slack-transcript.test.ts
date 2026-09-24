import { expect, it } from "vitest";
import { runEvalScenario } from "../../src/behavior-harness";
import { toEvalHarnessRun } from "../../src/eval-result";
import {
  mention,
  threadMessage,
  serializeVisibleTranscript,
} from "../../src/helpers";

it("records each delivered reply once and in turn order", async () => {
  const thread = {
    id: "slack:CTRANSCRIPT:17000000.1",
    channel_id: "CTRANSCRIPT",
    thread_ts: "17000000.1",
  };
  const result = await runEvalScenario({
    initialEvents: [],
    events: [
      mention("What is 2+2?", { thread }),
      threadMessage("And 3+3?", { thread, is_mention: true }),
    ],
    overrides: { reply_texts: ["**4**", "**6**"] },
  });
  expect(result.posts.map((post) => post.text)).toEqual(["**4**", "**6**"]);
  expect(
    JSON.parse(serializeVisibleTranscript(toEvalHarnessRun(result, 0).session)),
  ).toEqual([
    { role: "user", author: "Test User", content: "What is 2+2?" },
    { role: "assistant", content: "**4**" },
    { role: "user", author: "Test User", content: "And 3+3?" },
    { role: "assistant", content: "**6**" },
  ]);
});
