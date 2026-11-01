import { slackMention } from "@/chat/slack/mrkdwn";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

function namesPerson(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

/**
 * Reject an instruction that names the requester without their Slack mention.
 * The requester is their account in the workspace of the Automation
 * Destination.
 *
 * An Automation runs later without the request. A display name does not
 * notify the person, and it can match another person.
 */
export function requireRequesterMention(
  instruction: string,
  requester: { slackUserId: string; fullName?: string } | undefined,
): void {
  if (!requester?.fullName) return;
  const mention = slackMention(requester.slackUserId);
  if (instruction.includes(mention)) return;
  if (namesPerson(instruction, requester.fullName)) {
    throw new ToolInputError(
      `The instruction names ${requester.fullName} without a Slack mention. Write ${mention} for this person.`,
    );
  }
}
