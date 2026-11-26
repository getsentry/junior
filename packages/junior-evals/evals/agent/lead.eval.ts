import { describe, expect } from "vitest";
import { webMessage } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedToolCalls,
  toolCallsOf,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const CRON_WORK =
  "draft three steps for moving our billing cron jobs off Heroku Scheduler onto GitHub Actions";

// The shared GitHub HTTP fixture serves this pull request as merged, with its
// required check passing.
const MERGED_PULL_REQUEST = "getsentry/craft#983";

function input(call: ToolCall): Record<string, unknown> {
  return (call.input as Record<string, unknown> | undefined) ?? {};
}

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

  // `listAgents` lists the team without a filter, and searches with one.
  // The case measures whether the Lead searches for work outside its team.
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
      completedToolCalls("listAgents", conversation).filter((call) => {
        const input = (call.input ?? {}) as Record<string, unknown>;
        return Boolean(
          input["query"] || input["annotation"] || input["participating"],
        );
      }).length,
    ).toBeGreaterThan(0);
    expect(conversation.replies.length).toBeGreaterThan(0);
    // A question about outside work does not ask to move it.
    expect(toolCallsOf("moveConversationToSpace", conversation)).toEqual([]);
  });

  // Before the Lead could move Conversations, it started a Conversation to
  // do the move. The case measures whether it moves the work itself.
  test("when a person asks their Lead to move work into its Space, it moves the Conversation", async ({
    agent,
  }) => {
    const { readConversationSpace, run } = await agent();
    const work = await run(webMessage(CRON_WORK));

    const conversation = await run(
      webMessage(
        "the billing cron migration I started earlier belongs here. move it into this space",
        { lead: true },
      ),
    );

    expect(await readConversationSpace(work.conversationId)).toMatchObject({
      name: "Eval work",
    });
    expect(toolCallsOf("startAgent", conversation)).toEqual([]);
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
    expect(toolCallsOf("startAgent", conversation)).toEqual([]);
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
    expect(toolCallsOf("startAgent", conversation)).toEqual([]);
  });

  // A request to look into something is the Lead's to hand off. The case
  // measures whether it starts the work instead of asking how to scope it.
  test("when a member asks their Lead to dig into something, it starts a Thread without asking first", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "go dig into how the scheduler's coordinator prompt is put together and tell me what's off about it",
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startAgent", conversation).length,
    ).toBeGreaterThan(0);
    expect(toolCallsOf("askUserQuestion", conversation)).toEqual([]);
  });

  // The Lead has no provider tools, so a child reads the pull request. The
  // case measures whether the Lead gets the state checked and reports it,
  // instead of answering from memory.
  test("when a member asks about the state of a pull request, the Lead has a child read it and reports the result", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        `is ${MERGED_PULL_REQUEST} merged, and did its required checks pass?`,
        { lead: true },
      ),
    );

    expect(
      completedToolCalls("startAgent", conversation).length,
    ).toBeGreaterThan(0);
    expect(conversation.replies.at(-1)?.text).toMatch(/merged/i);
  });

  // The member changes one thing about running work. The case measures
  // whether the Lead sends only that change, not the whole brief again or
  // a new Thread.
  test("when a member re-scopes running work, the Lead sends the Thread only that change", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "start a thread to fix the 'recieve' typo in the getsentry/junior README and open a PR for it",
        { lead: true },
      ),
    );
    expect(completedToolCalls("startAgent", conversation)).toHaveLength(1);

    const rescoped = await conversation.continue(
      webMessage("re-scope it to no PR, just post the diff in the thread"),
    );

    expect(toolCallsOf("startAgent", rescoped)).toEqual([]);
    const messages = completedToolCalls("messageAgent", rescoped);
    expect(messages).toHaveLength(1);
    const text = String(input(messages[0]!)["text"] ?? "");
    expect(text).toMatch(/\bPR\b|pull request/i);
    // The Thread already has its brief.
    expect(text).not.toMatch(/recieve/i);
  });

  // Two changes to the same file conflict when they run at once. The case
  // measures whether the Lead gives each change a Thread, and tells the
  // second Thread to wait for the first.
  test("when two changes edit the same file, the Lead runs them one after the other", async ({
    agent,
  }) => {
    // The budget leaves the Lead room to search and start a Thread, and
    // keeps each Thread short.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 8 } });
    const conversation = await run(
      webMessage(
        "two changes for getsentry/junior, both in packages/junior/src/chat/system-prompt-rules.ts, one PR each: rename LEAD_RULES to LEAD_JOB_RULES, and add a JSDoc line above SAFETY_RULES that says Guardian enforces them",
        { lead: true },
      ),
    );

    const first = { toolCalls: conversation.turns[0]?.toolCalls ?? [] };
    const starts = toolCallsOf("startAgent", first);
    expect(starts).toHaveLength(2);
    // One brief says that its change waits on the other.
    expect(
      starts.map((call) => String(input(call)["task"] ?? "")).join("\n"),
    ).toMatch(/\b(wait|after|until|depends? on|hold)\b/i);
  });

  // The opposite of the case above: independent changes run at once.
  test("when two changes are independent, the Lead starts a Thread for each at once", async ({
    agent,
  }) => {
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 8 } });
    const conversation = await run(
      webMessage(
        "two separate things, one thread each: draft a three-line changelog entry for the new CSV export, and list five checks to run before a Postgres 17 upgrade",
        { lead: true },
      ),
    );

    const first = { toolCalls: conversation.turns[0]?.toolCalls ?? [] };
    expect(toolCallsOf("startAgent", first)).toHaveLength(2);
  });
});
