import { describe, expect } from "vitest";
import type { ToolCall } from "@junior-evals/fixture/test";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

function credentialMode(call: ToolCall | undefined): unknown {
  const input = call?.input;
  return input && typeof input === "object" && "credential_mode" in input
    ? input.credential_mode
    : undefined;
}

describe("Scheduled Credentials", () => {
  test("when scheduled work may need user-bound authorization, use the creator default", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "every Monday at 9am Pacific post a digest of unresolved issues for the Acme Sentry organization here.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The recurring task is created without asking for separate confirmation to use credentials needed for the requested work.",
          "The reply may accurately say Junior's scheduled automation can use the creator's connected Sentry access; credential access alone does not mean the task executes as the user.",
        ],
        fail: [
          "Do not require the user to separately authorize routine connected credential use.",
          "Do not explicitly claim the scheduled run's actor is the user rather than Junior's scheduler.",
        ],
      }),
    );

    const creates = completedToolCalls("createAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      trigger: {
        type: "schedule",
        schedule: { kind: "recurring", frequency: "weekly" },
      },
    });
    expect([undefined, "creator"]).toContain(credentialMode(creates[0]));
  });
});
