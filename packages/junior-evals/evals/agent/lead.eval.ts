import { describe, expect } from "vitest";
import { webMessage } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Lead", () => {
  // The Lead could write a short draft in its own reply. The case measures
  // whether it hands the work to a child Conversation instead.
  test("when a person asks their Lead for work, it starts a child Conversation for it and does not do it itself", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "can you write a short changelog entry for the new CSV export on the billing page? three bullets max",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startAgent", conversation).length,
    ).toBeGreaterThan(0);
  });

  // A member who raises a worry asks the Lead to deal with it. The case
  // measures whether the Lead starts that work and its start is allowed,
  // instead of asking the member to confirm first.
  test("when a member tells their Lead about a worry, it starts a child Conversation for it without asking first", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "I don't know how the color is chosen for the project avatars on the billing dashboard, but I'm worried a bunch of projects will get the same color and letter because they all start with acme",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startAgent", conversation).length,
    ).toBeGreaterThan(0);
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
