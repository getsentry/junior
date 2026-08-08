import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../../src/helpers";
import {
  eventTaskCreateCalls,
  eventTaskManagementCalls,
  seedEventTask,
} from "./helpers";

describeEval("Event Task Credentials", slackEvals, (it) => {
  it("when event work may need user-bound authorization, use the creator default", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        github_resource_events: true,
        plugin_dirs: ["fixtures/resource-event-plugins"],
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "$eval-resource-events Create a pull request titled 'Credentialed review handling'. When review changes are requested, create an event task that looks at the feedback and posts a fix plan in this channel.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The event task is created without asking for separate confirmation to use credentials needed for the requested work.",
          "The reply may accurately say the event task can use the creator's connected GitHub access; credential access alone does not mean the task executes as the user.",
        ],
        fail: [
          "Do not require the user to separately authorize routine connected credential use.",
          "Do not explicitly claim the event task's actor is the user instead of Junior.",
        ],
      }),
    });

    const createCalls = eventTaskCreateCalls(result.session);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.arguments).toMatchObject({
      trigger: {
        events: ["pull_request.review.changes_requested"],
        namespace: "github",
        identifier: "getsentry/junior#208",
      },
    });
    expect([undefined, "creator"]).toContain(
      createCalls[0]!.arguments?.credentialMode,
    );
  });

  it("when another channel member requests creator credentials, explain who can enable them", async ({
    run,
  }) => {
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CEVENTAUTH",
      id: "thread-event-task-credential-other-user",
      thread_ts: "1700000000.921000",
    };
    await seedEventTask({
      createdBy: {
        slackUserId: "UALICE",
        userName: "alice",
        fullName: "Alice Example",
      },
      credentialMode: "system",
      id: "evt_alice_system_credentials",
      taskText: "Post a GitHub issue digest in this channel.",
      thread,
    });

    const result = await run({
      overrides: {
        github_resource_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "Update that event task to use my connected credentials instead.",
          {
            thread,
            author: {
              user_id: "UBOBBB",
              user_name: "bob",
              full_name: "Bob Example",
            },
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply does not enable credentials and explains that Alice, the task creator, is the person who can enable creator credential use.",
        ],
        fail: [
          "Do not attempt to enable creator credentials for Bob.",
          "Do not replace Alice's task with a new event task.",
        ],
      }),
    });

    expect(eventTaskCreateCalls(result.session)).toEqual([]);
    expect(
      toolCalls(result.session).filter(
        (call) =>
          call.name === "updateEventTask" &&
          call.arguments?.credentialMode === "creator",
      ),
    ).toEqual([]);
    expect(eventTaskManagementCalls(result.session, "listEventTasks")).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          tasks: [
            expect.objectContaining({
              createdBy: expect.objectContaining({
                slackUserId: "UALICE",
              }),
              id: "evt_alice_system_credentials",
            }),
          ],
        }),
      }),
    ]);
  });

  it("when the creator requests credential use, enable creator mode", async ({
    run,
  }) => {
    const author = {
      user_id: "UALICE",
      user_name: "alice",
      full_name: "Alice Example",
    };
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CEVENTAUTH",
      id: "thread-event-task-credential-creator",
      thread_ts: "1700000000.922000",
    };
    await seedEventTask({
      createdBy: {
        slackUserId: author.user_id,
        userName: author.user_name,
        fullName: author.full_name,
      },
      credentialMode: "system",
      id: "evt_creator_system_credentials",
      taskText: "Post a GitHub issue digest in this channel.",
      thread,
    });

    const result = await run({
      overrides: {
        github_resource_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention("Enable my connected credentials for that event task now.", {
          thread,
          author,
        }),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms that the creator's connected credentials are now available to the event task when needed.",
        ],
        fail: ["Do not create a replacement event task."],
      }),
    });

    expect(eventTaskCreateCalls(result.session)).toEqual([]);
    expect(eventTaskManagementCalls(result.session, "listEventTasks")).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          tasks: [
            expect.objectContaining({
              createdBy: expect.objectContaining({
                slackUserId: "UALICE",
              }),
              id: "evt_creator_system_credentials",
            }),
          ],
        }),
      }),
    ]);
    expect(
      eventTaskManagementCalls(result.session, "updateEventTask").filter(
        (call) => call.arguments?.credentialMode === "creator",
      ),
    ).toHaveLength(1);
  });
});
