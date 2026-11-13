import { defineJuniorPlugins } from "@sentry/junior";
import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import {
  insertEventAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const issueTrigger = {
  events: ["issue.closed", "issue.reopened"],
  identifier: "getsentry/junior#208",
  label: "GitHub issue getsentry/junior#208",
  namespace: "github",
  resourceType: "issue",
};

describe("Event automation management", () => {
  test("when asked what events are available, search without creating anything", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "What GitHub events can you watch for me here, either just in this thread or as something ongoing for the channel? Just list the options—don't set anything up yet.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply explains available GitHub resource types and gives representative supported events.",
          "The reply distinguishes temporary thread watches from durable channel event automations.",
        ],
        fail: [
          "Do not claim that a watch, event automation, or scheduled automation was created.",
          "Do not ask the user to provide an event type before showing what is available.",
        ],
      }),
    );

    expect(
      completedToolCalls("searchEventTypes", conversation).map(toolOutput),
    ).toEqual([
      expect.objectContaining({
        resource_types: expect.arrayContaining([
          expect.objectContaining({
            namespace: "github",
            type: "issue",
            supported_events: expect.arrayContaining([
              "issue.closed",
              "issue.reopened",
            ]),
          }),
        ]),
      }),
    ]);
    const names = conversation.toolCalls.map((call) => call.name);
    expect(names).not.toContain("watchEvents");
    expect(names).not.toContain("createAutomation");
  });

  test("when a resource supports the requested event, create the requested event automation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Whenever a reviewer requests changes on GitHub PR getsentry/junior#691, set up an event automation that summarizes the requested changes and posts a concrete fix plan in this channel. Use system credentials for the event automation instead of my connected credentials.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms that an event automation was created for requested review changes on the pull request.",
          "The reply describes summarizing the feedback and posting a fix plan when the event occurs.",
        ],
        fail: [
          "Do not claim a polling schedule or recurring timer was created.",
          "Do not claim creator credentials were authorized.",
        ],
      }),
    );

    const creates = completedToolCalls("createAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      credential_mode: "system",
      outcomes: [
        { action: "send_message", destination: "current_conversation" },
      ],
      trigger: {
        type: "event",
        namespace: "github",
        events: ["pull_request.review.changes_requested"],
        match: { repo: "getsentry/junior", pull_request: 691 },
      },
    });
    const names = conversation.toolCalls.map((call) => call.name);
    expect(names).not.toContain("watchEvents");
  });

  test("when managing an existing event automation, list and update it, and ask the person before a delete", async ({
    run,
  }) => {
    const channel = slackChannel();
    const { id } = await insertEventAutomation({
      destination: channel,
      task: "Summarize issue closures and reopenings in this channel.",
      trigger: issueTrigger,
    });

    // The automation came from another thread in the same channel.
    const listing = await run(
      slackMention(
        "Show me the event automations configured for this channel.",
        {
          channel,
        },
      ),
    );
    await expect(listing).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply identifies the issue event automation created for this channel even though the request comes from another thread.",
        ],
        fail: [
          "Do not confuse the event automation with a temporary watch or scheduled automation.",
        ],
      }),
    );
    const update = await listing.continue(
      slackMention(
        "Change the issue task so it only reacts when the issue is reopened and posts a reopening summary.",
      ),
    );
    await expect(update).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms that the task now reacts only to issue reopenings.",
        ],
        fail: ["Do not create a replacement event automation."],
      }),
    );
    const removal = await listing.continue(
      slackMention("Delete that event automation now."),
    );
    await expect(removal).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says that the event automation is not deleted yet, because the delete needs the person's approval.",
        ],
        fail: [
          "Do not say that the event automation was deleted.",
          "Do not create a replacement event automation.",
        ],
      }),
    );

    expect(
      completedToolCalls("searchAutomations", listing).map(toolOutput),
    ).toEqual([
      expect.objectContaining({
        automations: [
          expect.objectContaining({
            id,
            trigger: expect.objectContaining({ available: true }),
          }),
        ],
      }),
    ]);
    const updates = completedToolCalls(
      "updateAutomation",
      listing,
      update,
      removal,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toMatchObject({
      automation_id: id,
      trigger: { type: "event", events: ["issue.reopened"] },
    });
    // A saved trigger with an identifier keeps it when the tools edit it.
    expect(toolOutput(updates[0]!)).toMatchObject({
      automation: {
        id,
        trigger: {
          events: ["issue.reopened"],
          identifier: "getsentry/junior#208",
          namespace: "github",
          resource_type: "issue",
        },
      },
    });
    // `deleteAutomation` asks the person. Core stores the call, and it does
    // not run before the person approves it.
    expect(
      toolCallsOf("deleteAutomation", listing, update, removal).map(
        (call) => call.input,
      ),
    ).toContainEqual({ automation_id: id });
    expect(
      completedToolCalls("deleteAutomation", listing, update, removal),
    ).toEqual([]);
    expect(
      completedToolCalls("createAutomation", listing, update, removal),
    ).toEqual([]);
  });

  test("when asked to pause and then resume an event automation, change its status", async ({
    run,
  }) => {
    const channel = slackChannel();
    const { id } = await insertEventAutomation({
      destination: channel,
      task: "Summarize issue closures and reopenings in this channel.",
      trigger: issueTrigger,
    });

    const paused = await run(
      slackMention("Pause the issue event automation in this channel.", {
        channel,
      }),
    );
    const resumed = await paused.continue(slackMention("Resume it now."));

    expect(
      completedToolCalls("updateAutomation", paused, resumed).map(toolOutput),
    ).toEqual([
      expect.objectContaining({
        automation: expect.objectContaining({ id, status: "paused" }),
      }),
      expect.objectContaining({
        automation: expect.objectContaining({ id, status: "active" }),
      }),
    ]);
    const names = [...paused.toolCalls, ...resumed.toolCalls].map(
      (call) => call.name,
    );
    expect(names).not.toContain("deleteAutomation");
    expect(names).not.toContain("createAutomation");
  });

  test("when a stored automation's plugin event is unavailable, explain that it cannot currently run", async ({
    agent,
  }) => {
    // This agent has no GitHub plugin, so the GitHub trigger is unavailable.
    const { run } = await agent({ plugins: defineJuniorPlugins([]) });
    const channel = slackChannel();
    const { id } = await insertEventAutomation({
      destination: channel,
      task: "Summarize issue closures in this channel.",
      trigger: issueTrigger,
    });

    const conversation = await run(
      slackMention(
        "Is the GitHub issue event automation in this channel currently able to receive events?",
        { channel },
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says the task remains stored but its GitHub trigger is not currently available, so it cannot receive matching events until that plugin event is enabled again.",
        ],
        fail: [
          "Do not claim the task can currently receive GitHub events.",
          "Do not delete or replace the task.",
        ],
      }),
    );

    expect(
      completedToolCalls("searchAutomations", conversation).map(toolOutput),
    ).toEqual([
      expect.objectContaining({
        automations: [
          expect.objectContaining({
            id,
            trigger: expect.objectContaining({ available: false }),
          }),
        ],
      }),
    ]);
    expect(completedToolCalls("updateAutomation", conversation)).toEqual([]);
    expect(completedToolCalls("deleteAutomation", conversation)).toEqual([]);
  });
});
