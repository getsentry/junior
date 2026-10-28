import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { handoffHistory } from "./handoff-history";

// A handoff replaces the history with a summary. The history says that the
// work is complete, and only memory defines the request, so the summary cannot
// carry it. The request must still be the active request after the handoff.
// It needs one tool call and no sandbox, so the turn stays short.
describe("Handoff task continuity", () => {
  test("when the turn hands off, do the new request", async ({ run }) => {
    await insertMemory({
      content:
        "Gut check means reviewing the approach just taken in the thread as a code reviewer. Give the verdict as a reaction on the request: thumbsup to keep it, thumbsdown to redo it. Then name the biggest risk in one sentence. Answer from the thread; do not read files or run commands.",
      kind: "procedure",
    });
    const conversation = await run(
      slackMention("Switch to the other configured profile first. Gut check"),
      { history: handoffHistory() },
    );

    const handoffIndex = conversation.toolCalls.findIndex(
      (call) => call.name === "handoff" && call.status === "completed",
    );
    expect(
      handoffIndex,
      "No handoff: this run does not test task loss",
    ).toBeGreaterThanOrEqual(0);
    expect(
      completedToolCalls("addReaction", {
        toolCalls: conversation.toolCalls.slice(handoffIndex + 1),
      }),
      "The request needs a verdict reaction after the handoff",
    ).not.toHaveLength(0);
    expect(conversation.replies.length).toBeGreaterThan(0);
  });
});
