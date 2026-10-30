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
 * Reject an instruction that does not name the requester exactly.
 *
 * An Automation runs later without the request. A display name does not
 * notify the person, and it can match another person. Each run reads "me" and
 * "my" as the Automation creator, so a requester who did not create the
 * Automation must use their mention instead.
 */
export function requireRequesterMention(
  instruction: string,
  actor: Actor | undefined,
  requester: { isCreator: boolean },
): void {
  if (actor?.platform !== "slack") return;
  const mention = slackMention(actor.userId);
  if (!requester.isCreator && /\b(?:me|my)\b/i.test(instruction)) {
    throw new ToolInputError(
      `The requester did not create this Automation, and each run reads "me" and "my" as the Automation creator. Write ${mention} for the requester.`,
    );
  }
  if (!actor.fullName || instruction.includes(mention)) return;
  if (namesPerson(instruction, actor.fullName)) {
    throw new ToolInputError(
      `The instruction names ${actor.fullName} without a Slack mention. Write ${mention} for this person.`,
    );
  }
}
