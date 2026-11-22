// TEMPORARY flake probe. Removed before review.
import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const reps = Number(process.env["PROBE_REPS"] ?? "1");

describe("Direct reminder probe", () => {
  for (let i = 0; i < reps; i++) {
    test(`probe ${i}`, async ({ run }) => {
      const conversation = await run(
        slackMention("send me a direct reminder in 1 minute to wash my hands"),
      );
      await expect(conversation).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The reply confirms that a one-off reminder to wash hands was scheduled.",
            "The reply does not ask the user to confirm first.",
          ],
          fail: [
            "Do not ask the user to confirm the reminder before creating it.",
            "Do not ask the user to provide a channel ID.",
            "Do not describe the reminder as a recurring schedule.",
          ],
        }),
      );
      const creates = completedToolCalls("createAutomation", conversation);
      expect(creates).toHaveLength(1);
      expect(creates[0]!.input).toMatchObject({
        outcomes: [{ action: "send_message", destination: "task_creator" }],
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "after", value: 1, unit: "minute" },
          },
        },
      });
      expect(creates[0]!.input).not.toHaveProperty("nextRunAt");
    });
  }
});
