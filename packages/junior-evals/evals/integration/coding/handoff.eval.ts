import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { rubric } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { handoffHistory } from "./handoff-history";

// Memory defines the terse request. Prior work is complete, so the continuation
// must act on the new request rather than repeat old work. Both cases switch
// profiles; the task must succeed with either handoff history strategy.
describe("Handoff task continuity", () => {
  for (const [label, instruction] of [
    ["terse request", "Deslop"],
    [
      "explicit request control",
      "Simplify work-object.ts: remove the unnecessary class and factory while keeping workObjectId and its stable ID behavior. Keep the change local.",
    ],
  ] as const) {
    test(`finishes the cleanup after handoff: ${label}`, async ({ run }) => {
      await insertMemory({
        content:
          "Deslop means cleaning the entire changeset: code, tests, comments, commit artifacts, pull-request title, and pull-request description. Remove jargon, follow repository terminology and practices, delete overbuilt or duplicate work, and keep the smallest clear patch.",
        kind: "procedure",
      });
      const conversation = await run(
        mention(`Switch to the other configured profile first. ${instruction}`),
        {
          history: handoffHistory(),
          criteria: rubric({
            pass: [
              "Explains that the cleanup removed the unnecessary class and factory while keeping workObjectId stable for the same provider and key.",
            ],
            fail: [
              "Do not claim that a pull request was pushed or that live rendering was verified unless the conversation shows that work.",
            ],
          }),
        },
      );

      const handoffIndex = conversation.toolCalls.findIndex(
        (call) => call.name === "handoff" && call.status === "completed",
      );
      expect(
        handoffIndex,
        "No handoff: this run does not test task loss",
      ).toBeGreaterThanOrEqual(0);
      const diffs = completedToolCalls("editFile", {
        toolCalls: conversation.toolCalls.slice(handoffIndex + 1),
      })
        .filter((call) =>
          String((call.input as { path?: unknown }).path).endsWith(
            "project/src/work-object.ts",
          ),
        )
        .map((call) => (toolOutput(call) as { diff?: string }).diff ?? "");
      expect(
        diffs,
        "The original cleanup needs a successful source edit after handoff",
      ).not.toHaveLength(0);
      expect(diffs.join("\n")).toMatch(/-.*class WorkObjectIdentityManager/);
      expect(diffs.join("\n")).toMatch(
        /-.*function createWorkObjectIdentityManager/,
      );
      expect(conversation.replies.length).toBeGreaterThan(0);
    });
  }
});
