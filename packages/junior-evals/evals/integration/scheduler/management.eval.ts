import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals, threadMessage } from "../../../src/helpers";
import {
  scheduledTaskCreateCalls,
  scheduledTaskUpdateCalls,
  seedScheduledTask,
} from "../../scheduler/helpers";

describeEval("Schedule Management", slackEvals, (it) => {
  it("when asked to reschedule an existing task, replace its cadence", async ({
    run,
  }) => {
    const thread = {
      channel_type: "channel" as const,
      channel_id: "CSCHEDMANAGE",
      id: "thread-scheduler-reschedule",
      thread_ts: "1700000000.877000",
    };
    const author = {
      user_id: "UALICE",
      user_name: "alice",
      full_name: "Alice Example",
    };
    await seedScheduledTask({
      createdBy: {
        slackUserId: author.user_id,
        userName: author.user_name,
        fullName: author.full_name,
      },
      id: "sched_planning_reminder",
      taskText: "Post a planning reminder in this channel.",
      thread,
    });
    const result = await run({
      initialEvents: [
        mention(
          "@bot prepare to change the scheduled planning reminder to Tuesdays at 10am Pacific, but ask me before applying the change.",
          { thread, author },
        ),
      ],
      events: [
        threadMessage("Yes, apply that schedule change now.", {
          thread,
          is_mention: true,
          author,
        }),
      ],
      criteria: rubric({
        pass: [
          "After the requested confirmation, the reply confirms that the scheduled task now runs every Tuesday at 10am Pacific.",
        ],
        fail: [
          "Do not claim the task still runs on Monday at 9am.",
          "Do not ask for another confirmation after the user says to apply the change.",
        ],
      }),
    });

    const createCalls = scheduledTaskCreateCalls(result.session);
    const updateCalls = scheduledTaskUpdateCalls(result.session);
    expect(createCalls).toEqual([]);
    const scheduleUpdate = updateCalls.find(
      (call) => call.arguments?.schedule !== undefined,
    );
    expect(scheduleUpdate?.arguments).toMatchObject({
      schedule: {
        kind: "recurring",
        frequency: "weekly",
        time: "10:00",
        weekdays: ["tuesday"],
      },
    });
    for (const updateCall of updateCalls) {
      expect(updateCall.arguments).not.toHaveProperty("next_run_at");
    }
  });
});
