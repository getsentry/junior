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
      requireRequesterMention("Remind sam lee to submit the timesheet.", actor),
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
    ]) {
      expect(() => requireRequesterMention(instruction, actor)).not.toThrow();
    }
  });
});
