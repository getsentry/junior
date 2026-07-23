import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals, threadMessage } from "../../src/helpers";
import { scheduledTaskCreateCalls, scheduledTaskUpdateCalls } from "./helpers";

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
    const result = await run({
      initialEvents: [
        mention(
          "@bot every Monday at 9am Pacific post a planning reminder here.",
          { thread, author },
        ),
      ],
      events: [
        threadMessage(
          "@bot change that scheduled task to Tuesdays at 10am Pacific.",
          { thread, is_mention: true, author },
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms that the scheduled task now runs every Tuesday at 10am Pacific.",
        ],
        fail: ["Do not claim the task still runs on Monday at 9am."],
      }),
    });

    const createCalls = scheduledTaskCreateCalls(result.session);
    const updateCalls = scheduledTaskUpdateCalls(result.session);
    expect(createCalls).toHaveLength(1);
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
