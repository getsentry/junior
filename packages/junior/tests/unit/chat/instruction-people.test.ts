import { describe, expect, it } from "vitest";
import { requireInstructionPeople } from "@/chat/automations/instruction-people";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const creator = { slackUserId: "UALICE", fullName: "Alice Park" };
const requester = { slackUserId: "U0TEST", fullName: "Sam Lee" };

describe("requireInstructionPeople", () => {
  it("rejects the creator's mention or name and asks for the Automation creator", () => {
    for (const instruction of [
      "Remind <@UALICE> to submit the timesheet.",
      "Remind alice park to submit the timesheet.",
    ]) {
      expect(() =>
        requireInstructionPeople(instruction, { creator, requester }),
      ).toThrow(
        new ToolInputError(
          'The instruction names Alice Park, the Automation creator. Write "the Automation creator" for this person; each run knows who that is.',
        ),
      );
    }
  });

  it("rejects another requester's name when the mention is missing", () => {
    expect(() =>
      requireInstructionPeople("Remind sam lee to submit the timesheet.", {
        creator,
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
      // The edit keeps a creator mention that was already there.
      ["Remind <@UALICE> and <@U0TEST>.", "Remind <@UALICE>."],
    ] as const) {
      expect(() =>
        requireInstructionPeople(instruction, {
          creator,
          requester,
          previousInstruction,
        }),
      ).not.toThrow();
    }
  });
});
