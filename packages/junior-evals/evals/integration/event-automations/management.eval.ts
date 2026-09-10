import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../../src/helpers";
import {
  eventAutomationCreateCalls,
  eventAutomationManagementCalls,
  seedEventAutomation,
} from "./helpers";

function eventAutomationCallEvents(
  call: ReturnType<typeof eventAutomationCreateCalls>[number],
): string[] {
  const trigger = call.arguments?.trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    throw new Error("Event automation call did not contain a trigger");
  }
  const events = trigger.events;
  if (
    !Array.isArray(events) ||
    !events.every((event) => typeof event === "string")
  ) {
    throw new Error("Event automation trigger did not contain string events");
  }
  return events;
}

describeEval("Event automation management", slackEvals, (it) => {
  it("when asked what events are available, search without creating anything", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        github_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "What GitHub events can you watch for me here, either just in this thread or as something ongoing for the channel? Just list the options—don't set anything up yet.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply explains available GitHub resource types and gives representative supported events.",
          "The reply distinguishes temporary thread watches from durable channel event automations.",
        ],
        fail: [
          "Do not claim that a watch, event automation, or scheduled automation was created.",
          "Do not ask the user to provide an event type before showing what is available.",
        ],
      }),
    });

    const calls = toolCalls(result.session);
    expect(
      calls.filter(
        (call) => call.name === "searchEventTypes" && call.status === "ok",
      ),
    ).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
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
      }),
    ]);
    expect(calls.map((call) => call.name)).not.toContain("watchEvents");
    expect(calls.map((call) => call.name)).not.toContain(
      "createEventAutomation",
    );
    expect(calls.map((call) => call.name)).not.toContain(
      "slackScheduleCreateAutomation",
    );
  });

  it("when a resource supports the requested event, create the requested event automation", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        github_events: true,
        plugin_dirs: ["fixtures/event-plugins"],
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "$eval-events Create a pull request in getsentry/junior titled 'Automate review handling'. Whenever a reviewer requests changes, set up an event automation that summarizes the requested changes and posts a concrete fix plan in this channel. Don't use any of my connected credentials for that task.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms that an event automation was created for requested review changes on the new pull request.",
          "The reply describes summarizing the feedback and posting a fix plan when the event occurs.",
        ],
        fail: [
          "Do not claim a polling schedule or recurring timer was created.",
          "Do not claim creator credentials were authorized.",
        ],
      }),
    });

    const createCalls = eventAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(
      toolCalls(result.session).find(
        (call) => call.name === "callMcpTool" && call.status === "ok",
      )?.arguments,
    ).toMatchObject({
      arguments: { repository: "getsentry/junior" },
    });
    expect(createCalls[0]!.arguments).toMatchObject({
      outcomes: [
        { action: "send_message", destination: "current_conversation" },
      ],
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior#208",
        resourceType: "pull_request",
        label: "GitHub PR getsentry/junior#208",
        events: ["pull_request.review.changes_requested"],
      },
    });
    expect(createCalls[0]!.arguments?.credentialMode).toBe("system");
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "slackScheduleCreateAutomation",
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "watchEvents",
    );
  });

  it("when one GitHub issue has multiple requested states, create one event automation", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        github_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "Create one event automation for GitHub issue getsentry/junior#208. Whenever it is closed or reopened, summarize the state change in this channel.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms that one event automation will react when the issue is closed or reopened.",
          "The reply accurately describes summarizing the issue state change in this channel.",
        ],
        fail: [
          "Do not create separate tasks for closed and reopened.",
          "Do not claim a polling schedule, recurring timer, or watch was created.",
        ],
      }),
    });

    const createCalls = eventAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.arguments).toMatchObject({
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior#208",
        resourceType: "issue",
        events: expect.arrayContaining(["issue.closed", "issue.reopened"]),
      },
    });
    expect(new Set(eventAutomationCallEvents(createCalls[0]!))).toEqual(
      new Set(["issue.closed", "issue.reopened"]),
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "slackScheduleCreateAutomation",
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "watchEvents",
    );
  });

  it("when issue activity spans a repository, create one repo-wide event automation", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        github_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "Create one event automation for getsentry/junior. Whenever any issue is closed or reopened, summarize the state change in this channel.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms one repository-wide event automation for issue closures and reopenings.",
          "The reply accurately says matching issue state changes will be summarized in this channel.",
        ],
        fail: [
          "Do not narrow the task to one issue number.",
          "Do not create separate tasks for closed and reopened issues.",
          "Do not claim a polling schedule or watch was created.",
        ],
      }),
    });

    const createCalls = eventAutomationCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.arguments).toMatchObject({
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior",
        resourceType: "repository",
        events: expect.arrayContaining(["issue.closed", "issue.reopened"]),
      },
    });
    expect(new Set(eventAutomationCallEvents(createCalls[0]!))).toEqual(
      new Set(["issue.closed", "issue.reopened"]),
    );
  });

  it("when managing an existing event automation, list update and delete it", async ({
    run,
  }) => {
    const creationThread = {
      channel_type: "channel" as const,
      channel_id: "CEVENTMANAGE",
      id: "thread-event-automation-creation",
      thread_ts: "1700000000.918000",
    };
    const managementThread = {
      channel_type: "channel" as const,
      channel_id: creationThread.channel_id,
      id: "thread-event-automation-management",
      thread_ts: "1700000000.919000",
    };
    await seedEventAutomation({
      id: "evt_issue_state_summary",
      taskText: "Summarize issue closures and reopenings in this channel.",
      thread: creationThread,
    });

    const result = await run({
      overrides: {
        github_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention("Show me the event automations configured for this channel.", {
          thread: managementThread,
        }),
      ],
      events: [
        threadMessage(
          "Change the issue task so it only reacts when the issue is reopened and posts a reopening summary.",
          { thread: managementThread, is_mention: true },
        ),
        threadMessage("Delete that event automation now.", {
          thread: managementThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant first identifies the issue event automation created for this channel even though the request comes from another thread.",
          "The assistant updates that task to react only to issue reopenings and confirms the new behavior.",
          "The assistant then deletes the same event automation and confirms it no longer exists.",
        ],
        fail: [
          "Do not create a replacement event automation.",
          "Do not confuse the event automation with a temporary watch or scheduled automation.",
        ],
      }),
    });

    expect(
      eventAutomationManagementCalls(result.session, "listEventAutomations"),
    ).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          automations: [
            expect.objectContaining({
              id: "evt_issue_state_summary",
              triggerAvailable: true,
            }),
          ],
        }),
      }),
    ]);
    const updateCalls = eventAutomationManagementCalls(
      result.session,
      "updateEventAutomation",
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.arguments).toMatchObject({
      taskId: "evt_issue_state_summary",
      trigger: {
        events: ["issue.reopened"],
        identifier: "getsentry/junior#208",
        namespace: "github",
        resourceType: "issue",
      },
    });
    expect(
      eventAutomationManagementCalls(result.session, "deleteEventAutomation"),
    ).toEqual([
      expect.objectContaining({
        arguments: { taskId: "evt_issue_state_summary" },
      }),
    ]);
    expect(eventAutomationCreateCalls(result.session)).toEqual([]);
  });

  it("when a stored automation's plugin event is unavailable, explain that it cannot currently run", async ({
    run,
  }) => {
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CEVENTUNAVAILABLE",
      id: "thread-event-automation-unavailable",
      thread_ts: "1700000000.920000",
    };
    await seedEventAutomation({
      id: "evt_unavailable_issue_summary",
      taskText: "Summarize issue closures in this channel.",
      thread,
    });

    const result = await run({
      overrides: {
        github_events: false,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "Is the GitHub issue event automation in this channel currently able to receive events?",
          { thread },
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply says the task remains stored but its GitHub trigger is not currently available, so it cannot receive matching events until that plugin event is enabled again.",
        ],
        fail: [
          "Do not claim the task can currently receive GitHub events.",
          "Do not delete or replace the task.",
        ],
      }),
    });

    expect(
      eventAutomationManagementCalls(result.session, "listEventAutomations"),
    ).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          automations: [
            expect.objectContaining({
              id: "evt_unavailable_issue_summary",
              triggerAvailable: false,
            }),
          ],
        }),
      }),
    ]);
    expect(
      eventAutomationManagementCalls(result.session, "updateEventAutomation"),
    ).toEqual([]);
    expect(
      eventAutomationManagementCalls(result.session, "deleteEventAutomation"),
    ).toEqual([]);
  });
});
