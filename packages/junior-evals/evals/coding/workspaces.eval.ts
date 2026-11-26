import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertWorkspace } from "@junior-evals/fixture/insert";
import { toolCallsOf, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Workspaces", () => {
  test("when someone creates a Workspace after the first turn, switch to it in a later turn", async ({
    run,
  }) => {
    const first = await run(slackMention("Reply with exactly: ready"));
    // Only the Workspace list changes between the two turns. Its name does
    // not say which repository it has.
    await insertWorkspace({
      name: "payments-stack",
      repos: [{ provider: "github", repo: "getsentry/billing-api" }],
    });
    const second = await first.continue(
      slackMention(
        "Get me a sandbox with getsentry/billing-api checked out. I'll ask about the code next.",
      ),
    );

    expect(
      toolCallsOf("switchWorkspace", second).map((call) => call.input),
    ).toContainEqual({ name: "payments-stack" });
  });

  test("when a Workspace snapshot is still building, end the Turn instead of waiting for it", async ({
    run,
  }) => {
    // A new Workspace has no snapshot, so the switch returns building with a
    // subscription to the ready and failed events.
    await insertWorkspace({
      name: "payments-stack",
      repos: [{ provider: "github", repo: "getsentry/billing-api" }],
    });
    const conversation = await run(
      slackMention(
        "Get me a sandbox with getsentry/billing-api checked out. I'll ask about the code next.",
      ),
    );

    const building = conversation.turns.find((turn) =>
      toolCallsOf("switchWorkspace", turn).some(
        (call) =>
          (toolOutput(call) as { status?: unknown } | undefined)?.status ===
          "building",
      ),
    );
    expect(
      building,
      "No building switch: this run does not test the wait",
    ).toBeDefined();
    // The subscription starts a later Turn, so this Turn switches once and
    // does not sleep to wait for the snapshot.
    expect(toolCallsOf("switchWorkspace", building!)).toHaveLength(1);
    expect(
      toolCallsOf("bash", building!).map(
        (call) => (call.input as { command?: unknown } | undefined)?.command,
      ),
    ).not.toContainEqual(expect.stringMatching(/\bsleep\b/));
  });
});
