/**
 * Canonical requester identity.
 *
 * Runtime requesters are platform-scoped actors. Stored Slack requester parsing
 * remains explicit so durable conversation metadata is not repaired on read.
 */
import { z } from "zod";
import { requesterSchema } from "@sentry/junior-plugin-api";
import { parseSlackTeamId } from "@/chat/slack/ids";

const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;
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

interface BaseRequester {
  email?: string;
  fullName?: string;
  userId: string;
  userName?: string;
}

export interface SlackRequester extends BaseRequester {
  platform: "slack";
  teamId: string;
}

export interface LocalRequester extends BaseRequester {
  platform: "local";
}

export type Requester = SlackRequester | LocalRequester;

export interface SlackRequesterProfile {
  email?: string;
  fullName?: string;
  userName?: string;
}

export type StoredSlackRequester = z.output<typeof storedSlackRequesterSchema>;

/** Parse a serialized runtime requester that crossed a durable boundary. */
export function parseRequester(value: unknown): Requester | undefined {
  const result = requesterSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

interface RequesterInput {
  email?: string;
  fullName?: string;
  platform?: Requester["platform"];
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
  return SLACK_USER_ID_DISPLAY_PATTERN.test(value);
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

/** Build Junior's canonical platform requester from exact actor ids and profile data. */
export function createRequester(
  input: RequesterInput | undefined,
  context: {
    platform?: Requester["platform"];
    teamId?: string;
    userId?: string;
  },
): Requester | undefined {
  const platform = context.platform ?? input?.platform;
  if (!platform) {
    return undefined;
  }
  const contextUserId = parseActorUserId(context.userId);
  if (context.userId !== undefined && !contextUserId) {
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

  const contextTeamId = parseSlackTeamId(context.teamId);
  if (context.teamId !== undefined && !contextTeamId) {
    return undefined;
  }
  const inputTeamId = parseSlackTeamId(input?.teamId);
  if (input?.teamId !== undefined && !inputTeamId) {
    return undefined;
  }
  const requesterTeamId = contextTeamId ?? inputTeamId;
  if (platform === "slack" && !requesterTeamId) {
    return undefined;
  }

  const canUseInputProfile =
    (!contextUserId || !inputUserId || contextUserId === inputUserId) &&
    (platform !== "slack" ||
      !contextTeamId ||
      !inputTeamId ||
      contextTeamId === inputTeamId);
  const requester = {
    ...(canUseInputProfile && cleanRequesterEmail(input?.email)
      ? { email: cleanRequesterEmail(input?.email) }
      : {}),
    ...(canUseInputProfile &&
    cleanRequesterDisplayName(input?.fullName, requesterUserId)
      ? {
          fullName: cleanRequesterDisplayName(input?.fullName, requesterUserId),
        }
      : {}),
    platform,
    userId: requesterUserId,
    ...(canUseInputProfile &&
    cleanRequesterDisplayName(input?.userName, requesterUserId)
      ? {
          userName: cleanRequesterDisplayName(input?.userName, requesterUserId),
        }
      : {}),
  };
  if (platform === "slack") {
    return { ...requester, platform, teamId: requesterTeamId! };
  }
  return { ...requester, platform };
}

/** Build Junior's canonical requester from Slack profile data. */
export function createSlackRequester(
  teamId: string,
  userId: string,
  profile: SlackRequesterProfile | null | undefined,
): SlackRequester {
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
  if (!requester || requester.platform !== "slack") {
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
  requester: SlackRequester,
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

/** Resolve a Slack resume requester from stored profile data and the active actor. */
export function createSlackResumeRequester(args: {
  requester?: Requester;
  teamId: string;
  userId: string;
}): SlackRequester {
  if (args.requester) {
    if (
      args.requester.platform !== "slack" ||
      args.requester.teamId !== args.teamId ||
      args.requester.userId !== args.userId
    ) {
      throw new Error("Stored Slack requester did not match resume actor");
    }
  }
  const requester = createRequester(args.requester, {
    platform: "slack",
    teamId: args.teamId,
    userId: args.userId,
  });
  if (!requester || requester.platform !== "slack") {
    throw new Error("Slack requester requires team and user ids");
  }
  return requester;
}
