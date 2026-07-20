import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  scheduledTaskDue,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

const REMINDER_ONLY_FORBIDDEN_TOOLS = [
  "webSearch",
  "webFetch",
  "bash",
  "readFile",
  "editFile",
  "grep",
  "findFiles",
  "listDir",
  "writeFile",
  "callMcpTool",
  "slackThreadRead",
  "slackChannelListMessages",
] as const;

function scheduledTaskCreateCall(session: Parameters<typeof toolCalls>[0]) {
  const calls = toolCalls(session).filter(
    (call) =>
      call.name === "scheduler_slackScheduleCreateTask" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

function expectNoToolCalls(
  session: Parameters<typeof toolCalls>[0],
  names: readonly string[],
) {
  expect(
    toolCalls(session)
      .map((call) => call.name)
      .filter((name) => names.includes(name)),
  ).toEqual([]);
}

describeEval("Scheduler", slackEvals, (it) => {
  it("when asked for a simple one-off reminder, create it without asking for confirmation", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("@bot remind me in 1 minute to wash my hands")],
      criteria: rubric({
        pass: [
          "The reply confirms that a one-off reminder to wash hands was scheduled.",
          "The reply does not ask the user to confirm first.",
        ],
        fail: [
          "Do not ask the user to confirm the reminder before creating it.",
          "Do not ask the user to provide a channel ID.",
          "Do not describe the reminder as a recurring schedule.",
        ],
      }),
    });
    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments).toMatchObject({ schedule_kind: "one_off" });
    expect(createCall.arguments).not.toHaveProperty("recurrence");
  });

  it("when asked for a terse one-off reminder, create it without recurrence", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("@bot remind me to drink water in 1m")],
      criteria: rubric({
        pass: [
          "The reply confirms that a one-off reminder to drink water was scheduled.",
          "The reply does not ask the user to retry with a different one-time format.",
        ],
        fail: [
          "Do not reject the request as an invalid one-off task format.",
          "Do not ask the user to confirm the reminder before creating it.",
          "Do not describe the reminder as a recurring schedule.",
        ],
      }),
    });
    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments).toMatchObject({ schedule_kind: "one_off" });
    expect(createCall.arguments).not.toHaveProperty("recurrence");
  });

  it("when asked for a specific one-off reminder, preserve the future work in the schedule", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot remind me in 2 minutes to tell the channel standup moved",
        ),
      ],
      criteria: rubric({
        pass: [
          "The observed scheduler_slackScheduleCreateTask task is the reminder work to perform later, not instructions for how to create or manage a schedule.",
        ],
        fail: [
          "Do not store task text that tells Junior to schedule a reminder later.",
          "Do not ask the user to confirm before creating this clear reminder.",
        ],
      }),
    });
    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments).toMatchObject({ schedule_kind: "one_off" });
    expect(createCall.arguments).not.toHaveProperty("recurrence");
  });

  it("when asked to schedule clear recurring work, create it without confirmation", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot schedule this every Monday at 9am Pacific: check open GitHub issues about the scheduler and post a short digest here.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The created task describes checking scheduler-related GitHub issues, not creating a schedule.",
          "The reply confirms the recurring schedule was created for Monday at 9am Pacific.",
        ],
        fail: [
          "Do not ask the user to confirm before creating the clear recurring task.",
          "Do not ask the user to provide a channel ID.",
          "Do not only give instructions for how the user can set up an external cron.",
        ],
      }),
    });
    expect(scheduledTaskCreateCall(result.session).arguments).toMatchObject({
      schedule_kind: "recurring",
      recurrence: "weekly",
    });
  });

  it("when the creator explicitly authorizes connected credentials, enable creator mode", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot create this recurring task now: every Monday at 9am Pacific check my private Sentry issues and post a digest here. I explicitly authorize this scheduled task to use my connected credentials.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The recurring task is created and the reply states that the creator's connected credentials are authorized for scheduled execution.",
        ],
        fail: [
          "Do not ask for another confirmation after the user explicitly authorized connected credential use.",
          "Do not claim the scheduled run executes as the user rather than as Junior's scheduler.",
        ],
      }),
    });

    expect(scheduledTaskCreateCall(result.session).arguments).toMatchObject({
      credential_mode: "creator",
      schedule_kind: "recurring",
    });
  });

  it("when scheduled credential use is ambiguous, ask before creating", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot every Monday at 9am Pacific check my private Sentry issues and post a digest here using my account if needed.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply asks whether the user authorizes future scheduled use of their connected credentials.",
          "No scheduled task is created yet.",
        ],
        fail: [
          "Do not silently enable creator credentials.",
          "Do not create the task before resolving credential authorization.",
        ],
      }),
    });

    expectNoToolCalls(result.session, ["scheduler_slackScheduleCreateTask"]);
  });

  it("when the creator denies connected credential use, create in system mode", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot every Monday at 9am Pacific post a Sentry digest here, but do not use any of my connected credentials.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The recurring task is created without creator credential delegation.",
        ],
        fail: [
          "Do not enable creator credentials after the user denied them.",
          "Do not ask for confirmation when the denial is explicit.",
        ],
      }),
    });

    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments?.credential_mode).not.toBe("creator");
    expect(
      toolCalls(result.session).filter(
        (call) =>
          call.name === "scheduler_slackScheduleUpdateTask" &&
          call.arguments?.credential_mode === "creator",
      ),
    ).toEqual([]);
  });

  it("when another channel member requests creator credentials, do not enable them", async ({
    run,
  }) => {
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CSCHEDAUTH",
      id: "thread-scheduler-credential-creator",
      thread_ts: "1700000000.875000",
    };
    const result = await run({
      initialEvents: [
        mention(
          "@bot every Monday at 9am Pacific post a Sentry digest here. Do not use my connected credentials.",
          {
            thread,
            author: {
              user_id: "UALICE",
              user_name: "alice",
              full_name: "Alice Example",
            },
          },
        ),
      ],
      events: [
        threadMessage(
          "@bot update that scheduled task to use my connected credentials instead.",
          {
            thread,
            is_mention: true,
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
          "The assistant does not enable creator credentials and explains that only the task creator can authorize or re-enable them.",
        ],
        fail: [
          "Do not replace Alice's task with a new task delegated to Bob.",
          "Do not claim Bob's credentials were enabled for Alice's task.",
        ],
      }),
    });

    const createCall = scheduledTaskCreateCall(result.session);
    expect(createCall.arguments?.credential_mode).not.toBe("creator");
    expect(
      toolCalls(result.session).filter(
        (call) =>
          call.name === "scheduler_slackScheduleUpdateTask" &&
          call.arguments?.credential_mode === "creator",
      ),
    ).toEqual([]);
  });

  it("when the creator ambiguously requests connected credentials later, ask before enabling them", async ({
    run,
  }) => {
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CSCHEDAUTH",
      id: "thread-scheduler-credential-reenable",
      thread_ts: "1700000000.876000",
    };
    const author = {
      user_id: "UALICE",
      user_name: "alice",
      full_name: "Alice Example",
    };
    const result = await run({
      initialEvents: [
        mention(
          "@bot every Monday at 9am Pacific post a Sentry digest here. Do not use my connected credentials.",
          { thread, author },
        ),
      ],
      events: [
        threadMessage(
          "@bot update that scheduled task to use my account if needed.",
          {
            thread,
            is_mention: true,
            author,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant asks whether Alice authorizes future scheduled use of her connected credentials before enabling creator mode.",
        ],
        fail: [
          "Do not enable creator credentials before Alice explicitly authorizes future scheduled use.",
        ],
      }),
    });

    expect(
      toolCalls(result.session).filter(
        (call) =>
          call.name === "scheduler_slackScheduleUpdateTask" &&
          call.arguments?.credential_mode === "creator",
      ),
    ).toEqual([]);
  });

  it("when a one-off reminder becomes due, deliver the reminder outcome", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        scheduledTaskDue("Post this reminder: Standup moved to 10:30 today.", {
          schedule: "Once at noon UTC",
          schedule_kind: "one_off",
        }),
      ],
      criteria: rubric({
        pass: [
          "The normalized session includes a Slack channel message saying standup moved to 10:30 today.",
          "The delivered message is the reminder content itself, not a schedule creation confirmation.",
          "The delivered message does not ask for clarification or confirmation.",
        ],
        fail: [
          "Do not say that a reminder was scheduled or will be scheduled.",
          "Do not omit the 10:30 standup update.",
          "Do not ask the user what to do with the reminder.",
        ],
      }),
    });
    expectNoToolCalls(result.session, REMINDER_ONLY_FORBIDDEN_TOOLS);
  });

  it("when a recurring scheduled task becomes due, deliver that occurrence", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        scheduledTaskDue(
          "Post this reminder: Submit timesheets by 5pm today.",
          {
            recurrence: "weekly",
            schedule: "Weekly on Monday at noon UTC",
            schedule_kind: "recurring",
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The normalized session includes a Slack channel message reminding people to submit timesheets by 5pm today.",
          "The delivered message treats this as the current due occurrence.",
          "The delivered message is not just a confirmation that a recurring task exists.",
        ],
        fail: [
          "Do not say only that a weekly reminder was scheduled.",
          "Do not omit the timesheets by 5pm content.",
          "Do not ask the user to confirm the recurring task before posting.",
        ],
      }),
    });
    expectNoToolCalls(result.session, REMINDER_ONLY_FORBIDDEN_TOOLS);
  });
});
