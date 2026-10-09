import { defineJuniorPlugins } from "@sentry/junior";
import { describe, expect } from "vitest";
import type { ToolCall } from "@junior-evals/fixture/test";
import { slackMention } from "@junior-evals/fixture/inputs";
import {
  insertEventAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const issueTrigger = {
  events: ["issue.closed", "issue.reopened"],
  identifier: "getsentry/junior#208",
  label: "GitHub issue getsentry/junior#208",
  namespace: "github",
  resourceType: "issue",
};

function triggerEvents(call: ToolCall): string[] {
  const input = call.input as { trigger?: { events?: unknown } } | undefined;
  const events = input?.trigger?.events;
  if (
    !Array.isArray(events) ||
    !events.every((event) => typeof event === "string")
  ) {
    throw new Error("Event automation call did not contain trigger events");
  }
  return events;
}

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
        resourceTypes: expect.arrayContaining([
          expect.objectContaining({
            namespace: "github",
            type: "issue",
            supportedEvents: expect.arrayContaining([
              "issue.closed",
              "issue.reopened",
            ]),
          }),
        ]),
      }),
    ]);
    const names = conversation.toolCalls.map((call) => call.name);
    expect(names).not.toContain("watchEvents");
    expect(names).not.toContain("createEventAutomation");
    expect(names).not.toContain("slackScheduleCreateAutomation");
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

    const creates = completedToolCalls("createEventAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      credentialMode: "system",
      outcomes: [
        { action: "send_message", destination: "current_conversation" },
      ],
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior#691",
        resourceType: "pull_request",
        events: ["pull_request.review.changes_requested"],
      },
    });
    const names = conversation.toolCalls.map((call) => call.name);
    expect(names).not.toContain("slackScheduleCreateAutomation");
    expect(names).not.toContain("watchEvents");
  });

  test("when one GitHub issue has multiple requested states, create one event automation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Create one event automation for GitHub issue getsentry/junior#208. Whenever it is closed or reopened, summarize the state change in this channel.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms that one event automation will react when the issue is closed or reopened.",
          "The reply accurately describes summarizing the issue state change in this channel.",
        ],
        fail: [
          "Do not create separate tasks for closed and reopened.",
          "Do not claim that `watchEvents`, a polling schedule, or a recurring timer was created instead of the event automation.",
        ],
      }),
    );

    const creates = completedToolCalls("createEventAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior#208",
        resourceType: "issue",
      },
    });
    expect(new Set(triggerEvents(creates[0]!))).toEqual(
      new Set(["issue.closed", "issue.reopened"]),
    );
    const names = conversation.toolCalls.map((call) => call.name);
    expect(names).not.toContain("slackScheduleCreateAutomation");
    expect(names).not.toContain("watchEvents");
  });

  test("when issue activity spans a repository, create one repo-wide event automation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Create one event automation for getsentry/junior. Whenever any issue is closed or reopened, summarize the state change in this channel.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms one repository-wide event automation for issue closures and reopenings.",
          "The reply accurately says matching issue state changes will be summarized in this channel.",
        ],
        fail: [
          "Do not narrow the task to one issue number.",
          "Do not create separate tasks for closed and reopened issues.",
          "Do not claim that `watchEvents` or a polling schedule was created instead of the event automation.",
        ],
      }),
    );

    const creates = completedToolCalls("createEventAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior",
        resourceType: "repository",
      },
    });
    expect(new Set(triggerEvents(creates[0]!))).toEqual(
      new Set(["issue.closed", "issue.reopened"]),
    );
  });

  test("when managing an existing event automation, list update and delete it", async ({
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
          "The reply confirms that the same event automation was deleted and no longer exists.",
        ],
        fail: ["Do not create a replacement event automation."],
      }),
    );

    expect(
      completedToolCalls("listEventAutomations", listing).map(toolOutput),
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
      "updateEventAutomation",
      listing,
      update,
      removal,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toMatchObject({
      automationId: id,
      trigger: {
        events: ["issue.reopened"],
        identifier: "getsentry/junior#208",
        namespace: "github",
        resourceType: "issue",
      },
    });
    expect(
      completedToolCalls("deleteEventAutomation", listing, update, removal).map(
        (call) => call.input,
      ),
    ).toEqual([{ automationId: id }]);
    expect(
      completedToolCalls("createEventAutomation", listing, update, removal),
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
      completedToolCalls("updateEventAutomation", paused, resumed).map(
        toolOutput,
      ),
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
    expect(names).not.toContain("deleteEventAutomation");
    expect(names).not.toContain("createEventAutomation");
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
      completedToolCalls("listEventAutomations", conversation).map(toolOutput),
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
    expect(completedToolCalls("updateEventAutomation", conversation)).toEqual(
      [],
    );
    expect(completedToolCalls("deleteEventAutomation", conversation)).toEqual(
      [],
    );
  });
});
