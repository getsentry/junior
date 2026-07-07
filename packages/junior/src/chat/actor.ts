/**
 * Canonical actor identity.
 *
 * Runtime actors are platform-scoped actors. Stored Slack actor parsing
 * remains explicit so durable conversation metadata is not repaired on read.
 */
import { z } from "zod";
import { actorSchema } from "@sentry/junior-plugin-api";
import { parseSlackTeamId } from "@/chat/slack/ids";

const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const exactStoredStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

export const storedSlackActorSchema = z
  .object({
    email: exactStoredStringSchema.optional(),
    fullName: exactStoredStringSchema.optional(),
    platform: z.literal("slack").optional(),
    slackUserId: exactStoredStringSchema.optional(),
    slackUserName: exactStoredStringSchema.optional(),
    teamId: exactStoredStringSchema.optional(),
  })
  .strict();

interface BaseActor {
  email?: string;
  fullName?: string;
  userId: string;
  userName?: string;
}

export interface SlackActor extends BaseActor {
  platform: "slack";
  teamId: string;
}

export interface LocalActor extends BaseActor {
  platform: "local";
}

export interface SystemActor {
  platform: "system";
  name: string;
}

export type UserActor = SlackActor | LocalActor;
export type Actor = UserActor | SystemActor;

export interface SlackActorProfile {
  email?: string;
  fullName?: string;
  userName?: string;
}

export type StoredSlackActor = z.output<typeof storedSlackActorSchema>;

/** Parse a serialized runtime actor that crossed a durable boundary. */
export function parseActor(value: unknown): Actor | undefined {
  const result = actorSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Return whether an actor is a platform-scoped user actor. */
export function isUserActor(actor: Actor | undefined): actor is UserActor {
  return Boolean(actor && "userId" in actor);
}

interface ActorInput {
  email?: string;
  fullName?: string;
  platform?: UserActor["platform"];
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

function cleanActorDisplayName(
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

function cleanActorEmail(value: string | undefined): string | undefined {
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

/** Build Junior's canonical platform actor from exact actor ids and profile data. */
export function createActor(
  input: ActorInput | undefined,
  context: {
    platform?: UserActor["platform"];
    teamId?: string;
    userId?: string;
  },
): UserActor | undefined {
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
  const actorUserId = contextUserId ?? inputUserId;
  if (!actorUserId) {
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
  const actorTeamId = contextTeamId ?? inputTeamId;
  if (platform === "slack" && !actorTeamId) {
    return undefined;
  }

  const canUseInputProfile =
    (!contextUserId || !inputUserId || contextUserId === inputUserId) &&
    (platform !== "slack" ||
      !contextTeamId ||
      !inputTeamId ||
      contextTeamId === inputTeamId);
  const actor = {
    ...(canUseInputProfile && cleanActorEmail(input?.email)
      ? { email: cleanActorEmail(input?.email) }
      : {}),
    ...(canUseInputProfile &&
    cleanActorDisplayName(input?.fullName, actorUserId)
      ? {
          fullName: cleanActorDisplayName(input?.fullName, actorUserId),
        }
      : {}),
    platform,
    userId: actorUserId,
    ...(canUseInputProfile &&
    cleanActorDisplayName(input?.userName, actorUserId)
      ? {
          userName: cleanActorDisplayName(input?.userName, actorUserId),
        }
      : {}),
  };
  if (platform === "slack") {
    return { ...actor, platform, teamId: actorTeamId! };
  }
  return { ...actor, platform };
}

/** Build Junior's canonical actor from Slack profile data. */
export function createSlackActor(
  teamId: string,
  userId: string,
  profile: SlackActorProfile | null | undefined,
): SlackActor {
  const actorUserId = parseActorUserId(userId);
  const actorTeamId = parseSlackTeamId(teamId);
  if (!actorTeamId || !actorUserId) {
    throw new Error("Slack actor requires team and user ids");
  }
  const actor = createActor(
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
  if (!actor || actor.platform !== "slack") {
    throw new Error("Slack actor requires team and user ids");
  }
  return actor;
}

/** Parse a serialized Slack actor that crossed a runtime boundary. */
export function parseStoredSlackActor(
  value: unknown,
): StoredSlackActor | undefined {
  const parsed = storedSlackActorSchema.safeParse(value);
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

/** Convert a runtime Slack actor into its durable session shape. */
export function toStoredSlackActor(actor: SlackActor): StoredSlackActor {
  return {
    ...(actor.email ? { email: actor.email } : {}),
    ...(actor.fullName ? { fullName: actor.fullName } : {}),
    platform: actor.platform,
    slackUserId: actor.userId,
    ...(actor.userName ? { slackUserName: actor.userName } : {}),
    teamId: actor.teamId,
  };
}

/** Resolve a Slack resume actor from stored profile data and the active actor. */
export function createSlackResumeActor(args: {
  actor?: UserActor;
  teamId: string;
  userId: string;
}): SlackActor {
  if (args.actor) {
    if (
      args.actor.platform !== "slack" ||
      args.actor.teamId !== args.teamId ||
      args.actor.userId !== args.userId
    ) {
      throw new Error("Stored Slack actor did not match resume actor");
    }
  }
  const actor = createActor(args.actor, {
    platform: "slack",
    teamId: args.teamId,
    userId: args.userId,
  });
  if (!actor || actor.platform !== "slack") {
    throw new Error("Slack actor requires team and user ids");
  }
  return actor;
}
