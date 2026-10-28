import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const alice = {
  fullName: "Alice Example",
  userId: "UALICE",
  userName: "alice",
};

describe("Schedule Destination Updates", () => {
  test("when asked what is scheduled here, list only the active channel", async ({
    run,
  }) => {
    const here = slackChannel();
    await insertScheduledAutomation({
      createdBy: alice,
      destination: here,
      task: "Post a planning reminder in this channel.",
    });
    await insertScheduledAutomation({
      createdBy: alice,
      destination: slackChannel(),
      task: "Post the ops handoff digest.",
    });

    const conversation = await run(
      slackMention("what scheduled automations are in this channel?", {
        author: alice,
        channel: here,
      }),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply mentions the planning reminder scheduled in this channel.",
        ],
        fail: [
          "Do not claim the ops handoff digest is scheduled in this channel.",
          "Do not ask the user to provide a channel ID.",
        ],
      }),
    );

    const lists = completedToolCalls(
      "slackScheduleListAutomations",
      conversation,
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect([undefined, null, here.channelId]).toContain(
        (list.input as { channel_id?: unknown } | undefined)?.channel_id,
      );
    }
    expect(
      completedToolCalls("slackScheduleUpdateAutomation", conversation),
    ).toEqual([]);
  });

  test("when asked once in the destination channel, update the requester task to deliver here", async ({
    run,
  }) => {
    const source = slackChannel();
    const { id } = await insertScheduledAutomation({
      createdBy: alice,
      credentialMode: "creator",
      destination: source,
      task: "Post a weekly planning reminder in this channel.",
    });

    const conversation = await run(
      slackMention(
        `move my weekly planning reminder from <#${source.channelId}> here`,
        { author: alice, channel: slackChannel() },
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms the weekly planning reminder now runs in the current destination conversation.",
        ],
        fail: [
          "Do not ask the user to open the source channel and list tasks first.",
          "Do not ask the user to copy or paste the task text.",
          "Do not ask for another confirmation after the move request.",
        ],
      }),
    );

    expect(
      completedToolCalls("slackScheduleListAutomations", conversation).length,
    ).toBeGreaterThan(0);
    const updates = completedToolCalls(
      "slackScheduleUpdateAutomation",
      conversation,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toMatchObject({
      automationId: id,
      destination: "here",
    });
    expect(
      completedToolCalls("slackScheduleCreateAutomation", conversation),
    ).toEqual([]);
    expect(
      completedToolCalls("slackScheduleDeleteAutomation", conversation),
    ).toEqual([]);
  });
});
