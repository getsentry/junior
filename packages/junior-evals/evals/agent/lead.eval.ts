import { describe, expect } from "vitest";
import { webMessage } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const CRON_WORK =
  "draft three steps for moving our billing cron jobs off Heroku Scheduler onto GitHub Actions";

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

  // A member who raises a worry asks the Lead to deal with it. The case
  // measures whether the Lead starts that work and its start is allowed,
  // instead of asking the member to confirm first.
  test("when a member tells their Lead about a worry, it starts a Conversation for it without asking first", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "I don't know how the color is chosen for the project avatars on the billing dashboard, but I'm worried a bunch of projects will get the same color and letter because they all start with acme",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startConversation", conversation).length,
    ).toBeGreaterThan(0);
  });

  // `searchConversations` is a catalog tool, but the Lead rules name it like
  // a tool in the list, so the model can call it directly. That call fails,
  // and its result names the `executeTool` call to make. The case measures
  // whether the search still runs.
  test("when a person asks their Lead about work they started, it searches their Conversations", async ({
    run,
  }) => {
    await run(webMessage(CRON_WORK));

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
    // A question about outside work does not ask to move it.
    expect(toolCallsOf("moveConversationToSpace", conversation)).toEqual([]);
  });

  // Before the Lead could move Conversations, it started a Conversation to
  // do the move. The case measures whether it moves the work itself.
  test("when a person asks their Lead to move work into its Space, it moves the Conversation", async ({
    run,
  }) => {
    const work = await run(webMessage(CRON_WORK));

    const conversation = await run(
      webMessage(
        "the billing cron migration I started earlier belongs here. move it into this space",
        { lead: true },
      ),
    );

    const moves = completedToolCalls("moveConversationToSpace", conversation);
    expect(moves.map((call) => toolOutput(call))).toContainEqual(
      expect.objectContaining({
        conversation_id: work.conversationId,
        space: expect.objectContaining({ name: "Eval work" }),
      }),
    );
    expect(toolCallsOf("startConversation", conversation)).toEqual([]);
  });

  // Only a member of a Space moves work into it. The case measures whether
  // the Lead tells the person, instead of moving the work another way.
  test("when a person asks their Lead to move work into a Space they are not in, it tells them and moves nothing", async ({
    agent,
  }) => {
    const { createOtherSpace, run } = await agent();
    const other = await createOtherSpace("Payments platform");
    await run(webMessage(CRON_WORK));

    const conversation = await run(
      webMessage(
        `move the billing cron migration I started earlier into the payments platform space: https://junior.example.com/spaces/${other.id}`,
        { lead: true },
      ),
    );

    expect(completedToolCalls("moveConversationToSpace", conversation)).toEqual(
      [],
    );
    expect(toolCallsOf("startConversation", conversation)).toEqual([]);
    expect(toolCallsOf("messageAgent", conversation)).toEqual([]);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says the conversation was not moved because the person must join the Payments platform Space first, or asks them to join it.",
        ],
        fail: ["The reply says the conversation was moved."],
      }),
    );
  });

  // Space names are not unique, so the move takes an ID. The case measures
  // whether the Lead finds the named Space, sees that the person is not a
  // member, and moves nothing.
  test("when a person names a Space without a link, their Lead finds it and moves nothing into a Space they are not in", async ({
    agent,
  }) => {
    const { createOtherSpace, run } = await agent();
    await createOtherSpace("Payments platform");
    await run(webMessage(CRON_WORK));

    const conversation = await run(
      webMessage(
        "move the billing cron migration I started earlier into the payments platform space",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("listSpaces", conversation).length,
    ).toBeGreaterThan(0);
    expect(completedToolCalls("moveConversationToSpace", conversation)).toEqual(
      [],
    );
    expect(toolCallsOf("startConversation", conversation)).toEqual([]);
  });
});
