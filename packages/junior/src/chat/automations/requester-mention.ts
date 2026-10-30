import type { Actor } from "@/chat/actor";
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
 *
 * An Automation runs later without the request. A display name does not
 * notify the person, and it can match another person.
 */
export function requireRequesterMention(
  instruction: string,
  actor: Actor | undefined,
): void {
  if (actor?.platform !== "slack" || !actor.fullName) return;
  const mention = slackMention(actor.userId);
  if (instruction.includes(mention)) return;
  if (namesPerson(instruction, actor.fullName)) {
    throw new ToolInputError(
      `The instruction names ${actor.fullName} without a Slack mention. Write ${mention} for this person.`,
    );
  }
}
