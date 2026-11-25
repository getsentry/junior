/**
 * The Actor of the Turn that sent an agent message and a digest of its
 * credentials. An agent message stores them only so that a running Turn of
 * its target can check that both Turns act for the same Actor with the same
 * credentials. The message never carries the credentials themselves.
 */
import { actorSchema, type Actor } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { isUserActor } from "@/chat/actor";
import type { AgentRun } from "@/chat/agent/types";
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import { credentialContextDigest } from "@/chat/credentials/context";

/** The Turn facts that steering compares. */
export type SteeringSender = {
  actor: Actor;
  credentialContextDigest: string;
};

const steeringSenderMetadataSchema = z.object({
  steeringSender: z.object({
    actor: actorSchema,
    credentialContextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

/**
 * Return the steering facts of a Turn that acts for a person with that
 * person's own credentials: a person's Turn, or a child Turn that a parent
 * message started. An Event, Watch, timer, or Automation Turn returns
 * nothing, so its messages never steer.
 */
export function steeringSenderForRun(
  run: Pick<AgentRun, "actor" | "credentialContext" | "source">,
): SteeringSender | undefined {
  const { actor, credentialContext } = run;
  const kind = run.source.kind;
  if (
    !isUserActor(actor) ||
    !credentialContext ||
    !("type" in credentialContext.actor) ||
    !(isPersonInput(kind) || kind === "parent_message")
  ) {
    return undefined;
  }
  return {
    actor,
    credentialContextDigest: credentialContextDigest(credentialContext),
  };
}

/** Read the steering facts that an agent message stores, if any. */
export function readSteeringSender(
  metadata: unknown,
): SteeringSender | undefined {
  const parsed = steeringSenderMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.steeringSender : undefined;
}
