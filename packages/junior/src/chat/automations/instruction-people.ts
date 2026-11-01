import { slackMention } from "@/chat/slack/mrkdwn";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** A person account in the workspace of the Automation Destination. */
type InstructionPerson = { slackUserId: string; fullName?: string };

function namesPerson(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

function refersTo(text: string, person: InstructionPerson): boolean {
  return (
    text.includes(slackMention(person.slackUserId)) ||
    (!!person.fullName && namesPerson(text, person.fullName))
  );
}

/**
 * Reject an instruction that names a person in a way that the run cannot use.
 *
 * An Automation runs later without the request. Each run reads "the Automation
 * creator" as its creator, so the instruction calls the creator that. Every
 * other requester needs their Slack mention, because a display name does not
 * notify the person and it can match another person. A reference that the
 * previous instruction already had stays allowed, so an edit does not have to
 * rewrite text that the requester did not change.
 */
export function requireInstructionPeople(
  instruction: string,
  people: {
    creator: InstructionPerson;
    requester?: InstructionPerson;
    previousInstruction?: string;
  },
): void {
  const { creator, requester, previousInstruction = "" } = people;
  if (
    refersTo(instruction, creator) &&
    !refersTo(previousInstruction, creator)
  ) {
    const reference = creator.fullName ?? slackMention(creator.slackUserId);
    throw new ToolInputError(
      `The instruction names ${reference}, the Automation creator. Write "the Automation creator" for this person; each run knows who that is.`,
    );
  }
  if (!requester?.fullName || requester.slackUserId === creator.slackUserId) {
    return;
  }
  const mention = slackMention(requester.slackUserId);
  if (instruction.includes(mention)) return;
  if (namesPerson(instruction, requester.fullName)) {
    throw new ToolInputError(
      `The instruction names ${requester.fullName} without a Slack mention. Write ${mention} for this person.`,
    );
  }
}
