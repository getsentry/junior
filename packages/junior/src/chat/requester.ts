import type { AgentPluginRequester } from "@sentry/junior-plugin-api";
import { z } from "zod";

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{5,}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const exactStoredStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

export const storedSlackRequesterSchema = z
  .object({
    email: exactStoredStringSchema.optional(),
    fullName: exactStoredStringSchema.optional(),
    slackUserId: exactStoredStringSchema.optional(),
    slackUserName: exactStoredStringSchema.optional(),
  })
  .strict();

export type Requester = AgentPluginRequester & { userId: string };

export interface SlackRequesterProfile {
  email?: string;
  fullName?: string;
  userName?: string;
}

export type StoredSlackRequester = z.output<typeof storedSlackRequesterSchema>;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSyntheticActorUserId(value: string): boolean {
  return value.toLowerCase() === "unknown";
}

function isSlackUserId(value: string): boolean {
  return SLACK_USER_ID_PATTERN.test(value);
}

function cleanRequesterDisplayName(
  value: string | undefined,
  userId?: string,
): string | undefined {
  const displayName = clean(value);
  if (!displayName) {
    return undefined;
  }
  if (displayName.toLowerCase() === "unknown") {
    return undefined;
  }
  if (userId && displayName === userId) {
    return undefined;
  }
  return isSlackUserId(displayName) ? undefined : displayName;
}

function cleanRequesterEmail(value: string | undefined): string | undefined {
  const email = clean(value);
  return email && EMAIL_PATTERN.test(email) ? email : undefined;
}

/** Keep actor ids exact at platform boundaries before they enter owned state. */
export function parseActorUserId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (value !== value.trim() || isSyntheticActorUserId(value)) {
    return undefined;
  }
  return value;
}

/** Assert persisted actor ids without read-side repair. */
export function isActorUserId(value: string | undefined): value is string {
  return parseActorUserId(value) === value;
}

/** Build Junior's canonical requester from an exact actor id and profile data. */
export function createRequester(
  input: AgentPluginRequester | undefined,
  userId?: string,
): Requester | undefined {
  const contextUserId = parseActorUserId(userId);
  if (userId !== undefined && !contextUserId) {
    return undefined;
  }
  const inputUserId = parseActorUserId(input?.userId);
  if (input?.userId !== undefined && !inputUserId) {
    return undefined;
  }

  const requesterUserId = contextUserId ?? inputUserId;
  if (!requesterUserId) {
    return undefined;
  }

  const canUseInputProfile =
    !contextUserId || !inputUserId || contextUserId === inputUserId;
  return {
    ...(canUseInputProfile && cleanRequesterEmail(input?.email)
      ? { email: cleanRequesterEmail(input?.email) }
      : {}),
    ...(canUseInputProfile &&
    cleanRequesterDisplayName(input?.fullName, requesterUserId)
      ? {
          fullName: cleanRequesterDisplayName(input?.fullName, requesterUserId),
        }
      : {}),
    userId: requesterUserId,
    ...(canUseInputProfile &&
    cleanRequesterDisplayName(input?.userName, requesterUserId)
      ? {
          userName: cleanRequesterDisplayName(input?.userName, requesterUserId),
        }
      : {}),
  };
}

/** Build Junior's canonical requester from Slack profile data. */
export function createSlackRequester(
  userId: string,
  profile: SlackRequesterProfile | null | undefined,
): Requester {
  const actorUserId = parseActorUserId(userId);
  if (!actorUserId) {
    throw new Error("Slack requester requires a user id");
  }
  const requester = createRequester(
    {
      email: profile?.email,
      fullName: profile?.fullName,
      userId: actorUserId,
      userName: profile?.userName,
    },
    actorUserId,
  );
  if (!requester) {
    throw new Error("Slack requester requires a user id");
  }
  return requester;
}

/** Parse a serialized Slack requester that crossed a runtime boundary. */
export function parseStoredSlackRequester(
  value: unknown,
): StoredSlackRequester | undefined {
  const parsed = storedSlackRequesterSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  if (
    parsed.data.slackUserId !== undefined &&
    !parseActorUserId(parsed.data.slackUserId)
  ) {
    return undefined;
  }
  return parsed.data;
}

/** Convert a runtime Slack requester into its durable session shape. */
export function toStoredSlackRequester(
  requester: Requester,
): StoredSlackRequester {
  return {
    ...(requester.email ? { email: requester.email } : {}),
    ...(requester.fullName ? { fullName: requester.fullName } : {}),
    slackUserId: requester.userId,
    ...(requester.userName ? { slackUserName: requester.userName } : {}),
  };
}

/** Rebuild a runtime requester from durable Slack requester state. */
export function createRequesterFromStoredSlackRequester(args: {
  requester?: StoredSlackRequester;
  userId: string;
}): Requester {
  const actorUserId = parseActorUserId(args.userId);
  if (!actorUserId) {
    throw new Error("Slack requester requires a user id");
  }
  const storedUserId =
    args.requester?.slackUserId === undefined
      ? undefined
      : parseActorUserId(args.requester.slackUserId);
  if (args.requester?.slackUserId !== undefined && !storedUserId) {
    throw new Error("Stored Slack requester requires a user id");
  }
  if (storedUserId && storedUserId !== actorUserId) {
    throw new Error("Stored Slack requester must match actor user id");
  }
  return createSlackRequester(
    actorUserId,
    storedUserId
      ? {
          email: args.requester?.email,
          fullName: args.requester?.fullName,
          userName: args.requester?.slackUserName,
        }
      : undefined,
  );
}
