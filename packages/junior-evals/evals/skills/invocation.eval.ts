import { describe, expect } from "vitest";
import { heartbeat, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { toolCallsOf } from "@junior-evals/fixture/results";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Skills", () => {
  test("when an explicit skill runs twice in one thread, keep its replies ordered", async ({
    run,
  }) => {
    const brief = (incident: string) =>
      rubric({
        pass: [
          `The reply is an incident brief about ${incident}.`,
          "The reply contains the requested incident name, Investigating status, and On-call owner.",
        ],
      });

    const first = await run(slackMention("/incident-brief Checkout latency"));
    await expect(first).toSatisfyJudge(RubricJudge, brief("Checkout latency"));
    const second = await first.continue(
      slackMention("/incident-brief Search errors"),
    );
    await expect(second).toSatisfyJudge(RubricJudge, brief("Search errors"));

    expect(first.replies).toHaveLength(1);
    expect(second.replies).toHaveLength(1);
  });

  test("when an invoked skill names manual-only skills, load each one it names", async ({
    run,
  }) => {
    // `launch-review` names `launch-checks`, which names `launch-signoff`.
    // Only `launch-signoff` has the code, and it becomes loadable only after
    // `launch-checks` loads.
    const result = await run(slackMention("/launch-review Atlas"));

    const loads = toolCallsOf("loadSkill", result);
    expect(loads.map((call) => call.status)).not.toContain("error");
    expect(
      loads.filter((call) => call.status === "completed").length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]!.text).toContain("ORCHID-42");
  });

  test("when an automation runs a manual-only skill, follow that skill with its context", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: {
        kind: "skill",
        skill: "weather-lookup",
        context: "Report the weather in Vienna.",
      },
    });

    const delivery = await run(heartbeat());

    expect(delivery.replies).toHaveLength(1);
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply is a weather report for Vienna.",
          "The reply includes the simulated data: 72°F or 22°C.",
        ],
      }),
    );
    // The Automation put the skill in the run, so the agent does not load it.
    expect(
      toolCallsOf("loadSkill", delivery).map(
        (call) => (call.input as { skill_name?: unknown }).skill_name,
      ),
    ).not.toContain("weather-lookup");
  });
});
