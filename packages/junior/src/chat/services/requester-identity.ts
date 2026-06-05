const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{5,}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface ActorIdentityInput {
  email?: string;
  fullName?: string;
  userId?: string;
  userName?: string;
}

export interface SlackActorProfile {
  email?: string;
  fullName?: string;
  userName?: string;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSyntheticActorUserId(value: string): boolean {
  return value.toLowerCase() === "unknown";
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

function isSlackUserId(value: string): boolean {
  return SLACK_USER_ID_PATTERN.test(value);
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

/** Keep authority ids exact while attaching optional presentation fields. */
export function buildActorIdentity(
  requester: ActorIdentityInput | undefined,
  requesterId?: string,
): ActorIdentityInput | undefined {
  const contextUserId = parseActorUserId(requesterId);
  if (requesterId !== undefined && !contextUserId) {
    return undefined;
  }
  const requesterUserId = parseActorUserId(requester?.userId);
  if (requester?.userId !== undefined && !requesterUserId) {
    return undefined;
  }
  const userId = contextUserId ?? requesterUserId;
  const canUseRequesterIdentity =
    !contextUserId || !requesterUserId || contextUserId === requesterUserId;
  const email = canUseRequesterIdentity
    ? cleanActorEmail(requester?.email)
    : undefined;
  const fullName = canUseRequesterIdentity
    ? cleanActorDisplayName(requester?.fullName, userId)
    : undefined;
  const userName = canUseRequesterIdentity
    ? cleanActorDisplayName(requester?.userName, userId)
    : undefined;
  const identity: ActorIdentityInput = {
    ...(email ? { email } : {}),
    ...(fullName ? { fullName } : {}),
    ...(userId ? { userId } : {}),
    ...(userName ? { userName } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

/** Use Slack profile data only as presentation around the exact user id. */
export function slackActorIdentity(
  userId: string,
  profile: SlackActorProfile | null | undefined,
): ActorIdentityInput {
  const actorUserId = parseActorUserId(userId);
  if (!actorUserId) {
    throw new Error("Slack actor identity requires a user id");
  }
  const identity = buildActorIdentity(
    {
      email: profile?.email,
      fullName: profile?.fullName,
      userId: actorUserId,
      userName: profile?.userName,
    },
    actorUserId,
  );
  if (!identity?.userId) {
    throw new Error("Slack actor identity requires a user id");
  }
  return identity;
}
