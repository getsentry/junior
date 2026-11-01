import { describe, expect, it } from "vitest";
import { requireInstructionReferences } from "@/chat/automations/instruction-references";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const creator = { slackUserId: "UALICE", fullName: "Alice Park" };
const requester = { slackUserId: "U0TEST", fullName: "Sam Lee" };
const destinationChannelId = "C123";

describe("requireInstructionReferences", () => {
  it("rejects the creator's mention or name and asks for the Automation creator", () => {
    for (const instruction of [
      "Remind <@UALICE> to submit the timesheet.",
      "Remind alice park to submit the timesheet.",
    ]) {
      expect(() =>
        requireInstructionReferences(instruction, {
          creator,
          destinationChannelId,
          requester,
        }),
      ).toThrow(
        new ToolInputError(
          'The instruction names Alice Park, the Automation creator. Write "the Automation creator" for this person; each run knows who that is.',
        ),
      );
    }
  });

  it("rejects a reference to this conversation and names the channel", () => {
    expect(() =>
      requireInstructionReferences("Post the digest in this channel.", {
        creator,
        destinationChannelId,
      }),
    ).toThrow(
      new ToolInputError(
        'The run does not see this conversation. Write <#C123> instead of "this channel".',
      ),
    );
  });

  it("rejects another requester's name when the mention is missing", () => {
    expect(() =>
      requireInstructionReferences("Remind sam lee to submit the timesheet.", {
        creator,
        destinationChannelId,
        requester,
      }),
    ).toThrow(
      new ToolInputError(
        "The instruction names Sam Lee without a Slack mention. Write <@U0TEST> for this person.",
      ),
    );
  });

  it("accepts the Automation creator, mentioned requesters, and unchanged references", () => {
    for (const [instruction, previousInstruction] of [
      ["Remind the Automation creator to submit the timesheet.", undefined],
      ["Remind <@U0TEST> to submit the timesheet.", undefined],
      ["Remind Sam Lee (<@U0TEST>) to submit the timesheet.", undefined],
      ["Post the weekly digest.", undefined],
      // The name is part of another word.
      ["Ask Sam Leeds for the report.", undefined],
      // The edit keeps references that were already there.
      ["Remind <@UALICE> and <@U0TEST>.", "Remind <@UALICE>."],
      [
        "Post a reminder in this channel to bring the agenda.",
        "Post a reminder in this channel.",
      ],
    ] as const) {
      expect(() =>
        requireInstructionReferences(instruction, {
          creator,
          destinationChannelId,
          requester,
          previousInstruction,
        }),
      ).not.toThrow();
    }
  });
});
