import { describe, expect } from "vitest";
import { webMessage } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
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
      completedToolCalls("startConversation", conversation).length +
        completedToolCalls("messageAgent", conversation).length,
    ).toBeGreaterThan(0);
  });

  // The Lead is private, so it could ask in its reply. The case measures
  // whether it asks with an Inbox item, as every agent does.
  test("when the Lead needs a decision that is the person's, it asks with an inbox item", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "start a Conversation that renames our billing-api service. I haven't settled the new name yet, it's either payments-api or ledger-api, so check with me which one first",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("addInboxItem", conversation).filter(
        (call) => (call.input as { kind?: string }).kind === "action",
      ),
    ).not.toHaveLength(0);
  });

  // `searchConversations` is a catalog tool, but the Lead rules name it like
  // a tool in the list, so the model can call it directly. That call fails,
  // and its result names the `executeTool` call to make. The case measures
  // whether the search still runs.
  test("when a person asks their Lead about work they started, it searches their Conversations", async ({
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
      completedToolCalls("searchConversations", conversation).length,
    ).toBeGreaterThan(0);
    expect(conversation.replies.length).toBeGreaterThan(0);
  });
});
