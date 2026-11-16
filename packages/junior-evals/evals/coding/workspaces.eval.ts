import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertWorkspace } from "@junior-evals/fixture/insert";
import { toolCallsOf } from "@junior-evals/fixture/results";
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
});
