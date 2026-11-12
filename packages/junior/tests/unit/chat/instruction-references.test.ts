import { describe, expect, it } from "vitest";
import { requireAutomationTaskText } from "@/chat/automations/instruction-references";
import type { AutomationTask } from "@/chat/automations/task";

const creator = { slackUserId: "UALICE", fullName: "Alice Park" };
const requester = { slackUserId: "U0TEST", fullName: "Sam Lee" };

function instruction(text: string): AutomationTask {
  return { kind: "instruction", instruction: text };
}

describe("requireAutomationTaskText", () => {
  it("rejects the creator's mention or name and asks for the Automation creator", () => {
    for (const text of [
      "Remind <@UALICE> to submit the timesheet.",
      "Remind alice park to submit the timesheet.",
    ]) {
      expect(() =>
        requireAutomationTaskText(instruction(text), {
          creator,
          requester,
        }),
      ).toThrow(
        'The instruction names Alice Park, the Automation creator. Write "the Automation creator" for this person; each run knows who that is.',
      );
    }
  });

  it("rejects a reference to this conversation and says outcomes set where it posts", () => {
    expect(() =>
      requireAutomationTaskText(
        instruction("Post the digest in this channel."),
        { creator },
      ),
    ).toThrow(
      'The run does not see this conversation, and its outcomes already set where it posts. Remove "this channel" and do not say where to post. Where the run reads or changes a channel, name it with a channel mention.',
    );
  });

  it("rejects a legacy no-reply marker in a skill context", () => {
    expect(() =>
      requireAutomationTaskText(
        {
          kind: "skill",
          skill: "release-train",
          context:
            "Repo getsentry/warden. When nothing is pending, reply [[NO_REPLY]].",
        },
        { creator },
      ),
    ).toThrow(
      'Remove "[[NO_REPLY]]". Say when the run posts nothing; it then ends without a message.',
    );
  });

  it("rejects another requester's name when the mention is missing", () => {
    expect(() =>
      requireAutomationTaskText(
        instruction("Remind sam lee to submit the timesheet."),
        { creator, requester },
      ),
    ).toThrow(
      "The instruction names Sam Lee without a Slack mention. Write <@U0TEST> for this person.",
    );
  });

  it("accepts the Automation creator, mentioned requesters, skills, and unchanged text", () => {
    const cases: [AutomationTask, AutomationTask | undefined][] = [
      [
        instruction("Remind the Automation creator to submit the timesheet."),
        undefined,
      ],
      [instruction("Remind <@U0TEST> to submit the timesheet."), undefined],
      [
        instruction("Remind Sam Lee (<@U0TEST>) to submit the timesheet."),
        undefined,
      ],
      [instruction("Post the weekly digest."), undefined],
      [{ kind: "skill", skill: "tpm" }, undefined],
      // The name is part of another word.
      [instruction("Ask Sam Leeds for the report."), undefined],
      // The edit keeps problems that were already there.
      [
        instruction("Remind <@UALICE> and <@U0TEST>."),
        instruction("Remind <@UALICE>."),
      ],
      [
        instruction("Post a reminder in this channel to bring the agenda."),
        instruction("Post a reminder in this channel."),
      ],
      [
        instruction("Check CI. If green, end with exactly [[NO_REPLY]]."),
        instruction("If green, end with exactly [[NO_REPLY]]."),
      ],
    ];
    for (const [task, current] of cases) {
      expect(() =>
        requireAutomationTaskText(task, {
          creator,
          requester,
          current,
        }),
      ).not.toThrow();
    }
  });
});
