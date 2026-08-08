import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { getDb } from "@/chat/db";
import {
  createSchedulerSqlStore,
  type SchedulerDb,
} from "@/chat/scheduled-tasks";
import { mention, rubric, slackEvals } from "../../../src/helpers";
import {
  scheduledTaskCreateCalls,
  scheduledTaskDeleteCalls,
  scheduledTaskListCalls,
  scheduledTaskUpdateCalls,
  seedScheduledTask,
} from "./helpers";

describeEval("Schedule Destination Updates", slackEvals, (it) => {
  it("when asked what is scheduled here, list only the active channel", async ({
    run,
  }) => {
    const author = {
      user_id: "UALICE",
      user_name: "alice",
      full_name: "Alice Example",
    };
    const here = {
      channel_type: "channel" as const,
      channel_id: "CSCHEDHERE",
      id: "thread-scheduler-list-here",
      thread_ts: "1700000000.901000",
    };
    const elsewhere = {
      channel_id: "CSCHEDELSE",
    };
    await seedScheduledTask({
      createdBy: {
        slackUserId: author.user_id,
        userName: author.user_name,
        fullName: author.full_name,
      },
      id: "sched_here_planning",
      taskText: "Post a planning reminder in this channel.",
      thread: here,
    });
    await seedScheduledTask({
      createdBy: {
        slackUserId: author.user_id,
        userName: author.user_name,
        fullName: author.full_name,
      },
      id: "sched_elsewhere_ops",
      taskText: "Post the ops handoff digest.",
      thread: elsewhere,
    });

    const result = await run({
      initialEvents: [
        mention("@bot what scheduled tasks are in this channel?", {
          thread: here,
          author,
        }),
      ],
      criteria: rubric({
        pass: [
          "The reply mentions the planning reminder scheduled in this channel.",
        ],
        fail: [
          "Do not claim the ops handoff digest is scheduled in this channel.",
          "Do not ask the user to provide a channel ID.",
        ],
      }),
    });

    const listCalls = scheduledTaskListCalls(result.session);
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) {
      expect(call.arguments?.channel_id == null || call.arguments?.channel_id === here.channel_id).toBe(
        true,
      );
    }
    expect(scheduledTaskUpdateCalls(result.session)).toEqual([]);
  });

  it("when asked once in the destination channel, update the requester task to deliver here", async ({
    run,
  }) => {
    const author = {
      user_id: "UALICE",
      user_name: "alice",
      full_name: "Alice Example",
    };
    const source = {
      channel_id: "CSOURCEPLAN",
    };
    const target = {
      channel_type: "group" as const,
      channel_id: "GTARGETPLAN",
      id: "thread-scheduler-move-here",
      thread_ts: "1700000000.902000",
    };
    const taskId = "sched_move_planning_reminder";
    await seedScheduledTask({
      createdBy: {
        slackUserId: author.user_id,
        userName: author.user_name,
        fullName: author.full_name,
      },
      credentialMode: "creator",
      id: taskId,
      taskText: "Post a weekly planning reminder in this channel.",
      thread: source,
    });

    const result = await run({
      initialEvents: [
        mention(
          `@bot move my weekly planning reminder from <#${source.channel_id}> here`,
          {
            thread: target,
            author,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms the weekly planning reminder now runs in the current destination conversation.",
        ],
        fail: [
          "Do not ask the user to open the source channel and list tasks first.",
          "Do not ask the user to copy or paste the task text.",
          "Do not ask for another confirmation after the move request.",
        ],
      }),
    });

    expect(scheduledTaskListCalls(result.session).length).toBeGreaterThan(0);
    const updateCalls = scheduledTaskUpdateCalls(result.session);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.arguments).toMatchObject({
      task_id: taskId,
      destination: "here",
    });
    expect(scheduledTaskCreateCalls(result.session)).toEqual([]);
    expect(scheduledTaskDeleteCalls(result.session)).toEqual([]);

    const stored = await createSchedulerSqlStore(
      getDb() as unknown as SchedulerDb,
    ).getTask(taskId);
    expect(stored).toMatchObject({
      id: taskId,
      credentialMode: "creator",
      destination: {
        platform: "slack",
        teamId: "TEVAL",
        channelId: target.channel_id,
      },
      conversationAccess: {
        audience: "group",
        visibility: "private",
      },
      task: { text: "Post a weekly planning reminder in this channel." },
      createdBy: { slackUserId: author.user_id },
    });
  });
});
