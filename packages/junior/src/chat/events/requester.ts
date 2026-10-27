/**
 * Requester instructions: text that the requester of a Watch wrote in an
 * Event, such as a pull request comment from the person who asked for the
 * pull request. See "Requester instructions" in `README.md`.
 */
import {
  slackActorSchema,
  type Event,
  type SlackActor,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { findLinkedSlackMember } from "@/chat/identities/linked-slack-member";
import { logInfo } from "@/chat/logging";
import type { Watch } from "@/chat/events/store";

/** Text that core proved the requester of a Watch wrote in one Event. */
export const requesterInstructionSchema = z
  .object({
    actor: slackActorSchema,
    text: z.string().min(1),
  })
  .strict();

export type RequesterInstruction = z.output<typeof requesterInstructionSchema>;

/**
 * Read the requester instructions that core saved on the Message that started
 * an Event Turn. Invalid values give none, so a resume never gains authority.
 */
export function parseRequesterInstructions(
  value: unknown,
): RequesterInstruction[] {
  const parsed = z.array(requesterInstructionSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * Resolve the Slack user behind the doer of an Event, when the Event also
 * carries text that the doer wrote.
 *
 * Only the doer's immutable provider account id can match, and only for an
 * account of the plugin that published the Event. The linked Slack user must
 * pass the same checks as Slack ingress. Returns undefined for every other
 * case. Slack and storage errors propagate.
 */
export async function resolveEventDoerSlackUserId(
  event: Event,
  args: { allowedDomains: readonly string[]; slackTeamId: string },
): Promise<string | undefined> {
  const doer = event.doneBy;
  if (
    !event.doneByText?.trim() ||
    !doer ||
    !("subjectId" in doer) ||
    !doer.subjectId ||
    doer.provider !== event.namespace
  ) {
    return undefined;
  }
  const member = await findLinkedSlackMember({
    allowedDomains: args.allowedDomains,
    provider: event.namespace,
    providerSubjectId: doer.subjectId,
    slackTeamId: args.slackTeamId,
  });
  if (member.status === "not_linked") {
    logInfo("event.doer.not_linked", {
      "app.event.event_type": event.eventType,
      "app.event.namespace": event.namespace,
      "app.event.doer.reason": member.reason,
    });
    return undefined;
  }
  return member.slackUserId;
}

/**
 * Return the requester instruction of one Watch, when the Event doer is the
 * requester of that Watch. A doer who is not the requester gives nothing.
 */
export function requesterInstructionFor(args: {
  doerSlackUserId: string | undefined;
  event: Pick<Event, "doneByText">;
  slackTeamId: string | undefined;
  subscription: Pick<Watch, "requester">;
}): RequesterInstruction | undefined {
  const requester: SlackActor | undefined = args.subscription.requester;
  const text = args.event.doneByText?.trim();
  if (
    !text ||
    !requester ||
    !args.doerSlackUserId ||
    requester.teamId !== args.slackTeamId ||
    requester.userId !== args.doerSlackUserId
  ) {
    return undefined;
  }
  return { actor: requester, text };
}
