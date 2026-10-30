import { describe, expect, it } from "vitest";
import { requireRequesterMention } from "@/chat/automations/requester-mention";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const actor = {
  platform: "slack" as const,
  teamId: "T1",
  userId: "U0TEST",
  fullName: "Sam Lee",
};

describe("requireRequesterMention", () => {
  it("rejects the requester's name when the mention is missing", () => {
    expect(() =>
      requireRequesterMention(
        "Remind sam lee to submit the timesheet.",
        actor,
        { isCreator: true },
      ),
    ).toThrow(
      new ToolInputError(
        "The instruction names Sam Lee without a Slack mention. Write <@U0TEST> for this person.",
      ),
    );
  });

  it("accepts an instruction that mentions the requester or names nobody", () => {
    for (const instruction of [
      "Remind <@U0TEST> to submit the timesheet.",
      "Remind Sam Lee (<@U0TEST>) to submit the timesheet.",
      "Post the weekly digest.",
      // The name is part of another word.
      "Ask Sam Leeds for the report.",
      // Older instructions and the creator's own edits can still say "me".
      "Remind me to submit my timesheet.",
    ]) {
      expect(() =>
        requireRequesterMention(instruction, actor, { isCreator: true }),
      ).not.toThrow();
    }
  });

  it('rejects "me" from a requester who did not create the Automation', () => {
    // Each run reads "me" as the Automation creator, a different person.
    expect(() =>
      requireRequesterMention("Remind me to review the PR.", actor, {
        isCreator: false,
      }),
    ).toThrow(
      new ToolInputError(
        'The requester did not create this Automation, and each run reads "me" and "my" as the Automation creator. Write <@U0TEST> for the requester.',
      ),
    );
    expect(() =>
      requireRequesterMention("Remind <@U0TEST> to review the PR.", actor, {
        isCreator: false,
      }),
    ).not.toThrow();
  });
});
