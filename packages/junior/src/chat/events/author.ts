/**
 * Event authors: who wrote the content of an Event, whether core trusts them,
 * and the text that counts as their instruction.
 *
 * Core decides trust once for each published Event (`decideAuthorTrust`).
 * An Event with no author is a system Event and runs as before. Core drops an
 * Event from an untrusted author before it joins a batch or a Turn. The own
 * text of a Trusted author is stored with the Event and counts as a message
 * from them, in the task input and in action review. The author never becomes
 * the Turn Actor and lends no credentials.
 */
import {
  slackActorSchema,
  type Event,
  type SlackActor,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  decideAuthorTrust,
  type UntrustedAuthorReason,
} from "@/chat/identities/trust";
import { slackMention } from "@/chat/slack/mrkdwn";

/** Text that a Trusted author wrote in one Event, saved with the Event. */
export const authorInstructionSchema = z
  .object({
    /** The Slack member behind the author, when core linked one. */
    actor: slackActorSchema.optional(),
    bot: z.literal(true).optional(),
    handle: z.string().min(1),
    /** Provider namespace of the Event. */
    provider: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

export type AuthorInstruction = z.output<typeof authorInstructionSchema>;

/** The trust decision for the author of one Event. */
export type EventAuthorTrust =
  | { status: "system" }
  | { status: "trusted"; actor?: SlackActor; instruction?: AuthorInstruction }
  | { status: "untrusted"; reason: UntrustedAuthorReason };

/** Decide whether core trusts the author of an Event. */
export async function decideEventAuthorTrust(
  event: Event,
  args: { allowedDomains: readonly string[]; slackTeamId: string | undefined },
): Promise<EventAuthorTrust> {
  const author = event.author;
  if (!author) return { status: "system" };
  const trust = await decideAuthorTrust(
    {
      kind: "account",
      listed: author.trusted === true,
      // An Event names an author only on the provider that published it.
      provider: event.namespace,
      ...(author.subjectId ? { subjectId: author.subjectId } : undefined),
    },
    args,
  );
  if (!trust.trusted) return { status: "untrusted", reason: trust.reason };
  const text = author.text?.trim();
  return {
    status: "trusted",
    ...(trust.actor ? { actor: trust.actor } : undefined),
    ...(text
      ? {
          instruction: {
            ...(trust.actor ? { actor: trust.actor } : undefined),
            ...(author.bot ? { bot: true as const } : undefined),
            handle: author.handle,
            provider: event.namespace,
            text,
          },
        }
      : undefined),
  };
}

/**
 * Return a function that decides the author trust of an Event at most once,
 * when a matching Watch or Event automation first needs it. Events that match
 * nothing need no lookup.
 */
export function eventAuthorTrustOnce(
  event: Event,
  args: { allowedDomains: readonly string[]; slackTeamId: string | undefined },
): () => Promise<EventAuthorTrust> {
  let pending: Promise<EventAuthorTrust> | undefined;
  return () => (pending ??= decideEventAuthorTrust(event, args));
}

/**
 * Read the author trust of an Event for a delivery path. An authored Event
 * with no trust check fails closed, so a caller that forgets the check never
 * delivers untrusted text.
 */
export async function requireEventAuthorTrust(
  event: Pick<Event, "author">,
  authorTrust: (() => Promise<EventAuthorTrust>) | undefined,
): Promise<EventAuthorTrust> {
  if (!event.author) return { status: "system" };
  return authorTrust
    ? await authorTrust()
    : { status: "untrusted", reason: "unknown_author" };
}

// Handles come from a plugin. Keep a label to one line of ID characters, so
// it cannot open a tag or start another labeled line.
function safeHandle(value: string): string {
  return value.replace(/[^A-Za-z0-9._:@/#+[\]-]/g, "_");
}

/**
 * The one label for the author of an instruction, in task input and in
 * action review: a Slack mention for a linked person, else the handle.
 */
export function authorInstructionLabel(instruction: AuthorInstruction): string {
  if (instruction.actor) return slackMention(instruction.actor.userId);
  return `${safeHandle(instruction.handle)} on ${safeHandle(instruction.provider)}${instruction.bot ? " (a bot)" : ""}`;
}

/**
 * Read the author instructions that core saved on the Message that started
 * an Event Turn. Invalid values give none, so a resume never gains authority.
 */
export function parseAuthorInstructions(value: unknown): AuthorInstruction[] {
  const parsed = z.array(authorInstructionSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
