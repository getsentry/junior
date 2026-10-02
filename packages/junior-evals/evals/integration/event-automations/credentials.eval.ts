import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { describe, expect } from "vitest";
import type { ToolCall } from "../../../src/fixture/test";
import { mention } from "../../../src/fixture/inputs";
import {
  insertEventAutomation,
  slackChannel,
} from "../../../src/fixture/insert";
import { rubric } from "../../../src/fixture/judge";
import { completedToolCalls, toolOutput } from "../../../src/fixture/results";
import { test } from "../../../src/fixture/test";

const alice = {
  fullName: "Alice Example",
  userId: "UALICE",
  userName: "alice",
};

const bob = {
  fullName: "Bob Example",
  userId: "UBOBBB",
  userName: "bob",
};

const issueTrigger = {
  events: ["issue.closed", "issue.reopened"],
  identifier: "getsentry/junior#208",
  label: "GitHub issue getsentry/junior#208",
  namespace: "github",
  resourceType: "issue",
};

function credentialMode(call: ToolCall | undefined): unknown {
  const input = call?.input;
  return input && typeof input === "object" && "credentialMode" in input
    ? input.credentialMode
    : undefined;
}

describe("Event automation credentials", () => {
  test("when event work may need user-bound authorization, use the creator default", async ({
    agent,
  }) => {
    const { run } = await agent({
      plugins: defineJuniorPlugins([githubPlugin()]),
    });
    const conversation = await run(
      mention(
        "When review changes are requested on GitHub PR getsentry/junior#691, create an event automation that looks at the feedback and posts a fix plan in this channel.",
      ),
      {
        criteria: rubric({
          pass: [
            "The event automation is created without asking for separate confirmation to use credentials needed for the requested work.",
            "The reply may accurately say the event automation can use the creator's connected GitHub access; credential access alone does not mean the task executes as the user.",
          ],
          fail: [
            "Do not require the user to separately authorize routine connected credential use.",
            "Do not explicitly claim the event automation's actor is the user instead of Junior.",
          ],
        }),
      },
    );

    const creates = completedToolCalls("createEventAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      trigger: {
        events: ["pull_request.review.changes_requested"],
        namespace: "github",
        identifier: "getsentry/junior#691",
      },
    });
    expect([undefined, "creator"]).toContain(credentialMode(creates[0]));
  });

  test("when another channel member requests creator credentials, explain who can enable them", async ({
    agent,
  }) => {
    const { run } = await agent({
      plugins: defineJuniorPlugins([githubPlugin()]),
    });
    const channel = slackChannel();
    const { id } = await insertEventAutomation({
      createdBy: alice,
      destination: channel,
      task: "Post a GitHub issue digest in this channel.",
      trigger: issueTrigger,
    });

    const conversation = await run(
      mention(
        "Update that event automation to use my connected credentials instead.",
        { author: bob, channel },
      ),
      {
        criteria: rubric({
          pass: [
            "The reply does not enable credentials and explains that Alice, the task creator, is the person who can enable creator credential use.",
          ],
          fail: [
            "Do not attempt to enable creator credentials for Bob.",
            "Do not delete or replace Alice's task in this turn.",
          ],
        }),
      },
    );

    expect(completedToolCalls("createEventAutomation", conversation)).toEqual(
      [],
    );
    expect(completedToolCalls("deleteEventAutomation", conversation)).toEqual(
      [],
    );
    expect(
      conversation.toolCalls.filter(
        (call) =>
          call.name === "updateEventAutomation" &&
          credentialMode(call) === "creator",
      ),
    ).toEqual([]);
    expect(
      completedToolCalls("listEventAutomations", conversation).map(toolOutput),
    ).toEqual([
      expect.objectContaining({
        automations: [
          expect.objectContaining({
            createdBy: expect.objectContaining({ username: "alice" }),
            id,
            isCreator: false,
          }),
        ],
      }),
    ]);
  });

  test("when the creator requests credential use, enable creator mode", async ({
    agent,
  }) => {
    const { run } = await agent({
      plugins: defineJuniorPlugins([githubPlugin()]),
    });
    const channel = slackChannel();
    const { id } = await insertEventAutomation({
      createdBy: alice,
      destination: channel,
      task: "Post a GitHub issue digest in this channel.",
      trigger: issueTrigger,
    });

    const conversation = await run(
      mention(
        "Enable my connected credentials for that event automation now.",
        { author: alice, channel },
      ),
      {
        criteria: rubric({
          pass: [
            "The reply confirms that the creator's connected credentials are now available to the event automation when needed.",
          ],
          fail: ["Do not create a replacement event automation."],
        }),
      },
    );

    expect(completedToolCalls("createEventAutomation", conversation)).toEqual(
      [],
    );
    expect(
      completedToolCalls("listEventAutomations", conversation).map(toolOutput),
    ).toEqual([
      expect.objectContaining({
        automations: [
          expect.objectContaining({
            createdBy: expect.objectContaining({ username: "alice" }),
            id,
            isCreator: true,
          }),
        ],
      }),
    ]);
    expect(
      completedToolCalls("updateEventAutomation", conversation).filter(
        (call) => credentialMode(call) === "creator",
      ),
    ).toHaveLength(1);
  });
});
