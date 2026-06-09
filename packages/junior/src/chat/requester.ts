/**
 * Canonical Slack requester identity.
 *
 * Runtime requesters are always workspace-scoped Slack actors. Stored requester
 * parsing remains explicit so legacy durable records can resume without
 * repairing malformed team or user ids.
 */
import { z } from "zod";
import { isSlackTeamId } from "@/chat/slack/ids";

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
    platform: z.literal("slack").optional(),
    slackUserId: exactStoredStringSchema.optional(),
    slackUserName: exactStoredStringSchema.optional(),
    teamId: exactStoredStringSchema.optional(),
  })
  .strict();

export interface Requester {
  email?: string;
  fullName?: string;
  platform: "slack";
  teamId: string;
  userId: string;
  userName?: string;
}

export interface SlackRequesterProfile {
  email?: string;
  fullName?: string;
  userName?: string;
}

export type StoredSlackRequester = z.output<typeof storedSlackRequesterSchema>;

interface RequesterInput {
  email?: string;
  fullName?: string;
  platform?: "slack";
  teamId?: string;
  userId?: string;
  userName?: string;
}

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

function parseSlackTeamId(value: unknown): string | undefined {
  return typeof value === "string" && isSlackTeamId(value) ? value : undefined;
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

/** Build Junior's canonical requester from exact Slack team/user ids and profile data. */
export function createRequester(
  input: RequesterInput | undefined,
  context: {
    teamId?: string;
    userId?: string;
  },
): Requester | undefined {
  const contextUserId = parseActorUserId(context.userId);
  if (context.userId !== undefined && !contextUserId) {
    return undefined;
  }
  const inputUserId = parseActorUserId(input?.userId);
  if (input?.userId !== undefined && !inputUserId) {
    return undefined;
  }
  const contextTeamId = parseSlackTeamId(context.teamId);
  if (context.teamId !== undefined && !contextTeamId) {
    return undefined;
  }
  const inputTeamId = parseSlackTeamId(input?.teamId);
  if (input?.teamId !== undefined && !inputTeamId) {
    return undefined;
  }

  const requesterUserId = contextUserId ?? inputUserId;
  const requesterTeamId = contextTeamId ?? inputTeamId;
  if (!requesterUserId || !requesterTeamId) {
    return undefined;
  }

  const canUseInputProfile =
    (!contextUserId || !inputUserId || contextUserId === inputUserId) &&
    (!contextTeamId || !inputTeamId || contextTeamId === inputTeamId);
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
    platform: "slack",
    teamId: requesterTeamId,
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
  teamId: string,
  userId: string,
  profile: SlackRequesterProfile | null | undefined,
): Requester {
  const actorUserId = parseActorUserId(userId);
  const actorTeamId = parseSlackTeamId(teamId);
  if (!actorTeamId || !actorUserId) {
    throw new Error("Slack requester requires team and user ids");
  }
  const requester = createRequester(
    {
      email: profile?.email,
      fullName: profile?.fullName,
      platform: "slack",
      teamId: actorTeamId,
      userId: actorUserId,
      userName: profile?.userName,
    },
    { teamId: actorTeamId, userId: actorUserId },
  );
  if (!requester) {
    throw new Error("Slack requester requires team and user ids");
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
  if (
    parsed.data.teamId !== undefined &&
    !parseSlackTeamId(parsed.data.teamId)
  ) {
    return undefined;
  }
  if (
    (parsed.data.platform !== undefined || parsed.data.teamId !== undefined) &&
    (!parsed.data.platform || !parsed.data.teamId)
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
    platform: requester.platform,
    slackUserId: requester.userId,
    ...(requester.userName ? { slackUserName: requester.userName } : {}),
    teamId: requester.teamId,
  };
}

/** Rebuild a runtime requester from durable Slack requester state. */
export function createRequesterFromStoredSlackRequester(args: {
  requester?: StoredSlackRequester;
  teamId: string;
  userId: string;
}): Requester {
  const actorUserId = parseActorUserId(args.userId);
  const actorTeamId = parseSlackTeamId(args.teamId);
  if (!actorTeamId || !actorUserId) {
    throw new Error("Slack requester requires team and user ids");
  }
  const storedUserId =
    args.requester?.slackUserId === undefined
      ? undefined
      : parseActorUserId(args.requester.slackUserId);
  const storedTeamId =
    args.requester?.teamId === undefined
      ? undefined
      : parseSlackTeamId(args.requester.teamId);
  if (args.requester?.slackUserId !== undefined && !storedUserId) {
    throw new Error("Stored Slack requester requires a user id");
  }
  if (args.requester?.teamId !== undefined && !storedTeamId) {
    throw new Error("Stored Slack requester requires a team id");
  }
  if (storedUserId && storedUserId !== actorUserId) {
    throw new Error("Stored Slack requester must match actor user id");
  }
  if (storedTeamId && storedTeamId !== actorTeamId) {
    throw new Error("Stored Slack requester must match actor team id");
  }
  const canUseStoredProfile = Boolean(storedUserId);
  return createSlackRequester(
    actorTeamId,
    actorUserId,
    canUseStoredProfile
      ? {
          email: args.requester?.email,
          fullName: args.requester?.fullName,
          userName: args.requester?.slackUserName,
        }
      : undefined,
  );
}
