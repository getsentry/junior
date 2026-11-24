import { describe, expect } from "vitest";
import { webMessage } from "@junior-evals/fixture/inputs";
import { completedToolCalls, toolCallsOf } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Lead", () => {
  // The Lead could write a short draft in its own reply. The case measures
  // whether it hands the work to a Conversation instead.
  test("when a person asks their Lead for work, it starts a Conversation for it and does not do it itself", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "can you write a short changelog entry for the new CSV export on the billing page? three bullets max",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startAgent", conversation).length +
        completedToolCalls("messageAgent", conversation).length,
    ).toBeGreaterThan(0);
  });

  // The person started this work in their own root, not through the Lead,
  // so only a query finds it.
  test("when a person asks their Lead about work they started, it searches with listAgents", async ({
    run,
  }) => {
    await run(
      webMessage(
        "draft three steps for moving our billing cron jobs off Heroku Scheduler onto GitHub Actions",
      ),
    );

    const conversation = await run(
      webMessage(
        "where's the billing cron migration I started earlier? link me to it",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("listAgents", conversation).filter(
        (call) =>
          typeof (call.input as { query?: unknown })?.query === "string",
      ).length,
    ).toBeGreaterThan(0);
    expect(conversation.replies.length).toBeGreaterThan(0);
  });

  // The Lead started the root, so it is on the Lead's team. The case
  // measures whether the Lead archives it itself instead of telling the
  // person to do it.
  test("when a person tells their Lead that work it started is done, it archives that work", async ({
    run,
  }) => {
    const started = await run(
      webMessage(
        "start a conversation that writes a two-line poem about invoices",
        { lead: true },
      ),
    );
    expect(completedToolCalls("startAgent", started)).toHaveLength(1);

    const conversation = await run(
      webMessage("thanks, I'm done with the invoice poem. archive it.", {
        lead: true,
      }),
    );

    expect(toolCallsOf("archiveAgent", conversation)).not.toEqual([]);
  });

  // The person started this root without the Lead. It is still on the
  // Lead's team, so the case measures whether the Lead finds and archives
  // it instead of telling the person to do it.
  test("when a person tells their Lead that work they started themselves is done, it archives that work", async ({
    run,
  }) => {
    await run(webMessage("write a two-line poem about late invoices"));

    const conversation = await run(
      webMessage(
        "I'm done with the late invoices poem I started earlier. archive it.",
        { lead: true },
      ),
    );

    expect(completedToolCalls("archiveAgent", conversation)).not.toEqual([]);
  });
});
