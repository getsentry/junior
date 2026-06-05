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
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isSlackUserId(value: string): boolean {
  return SLACK_USER_ID_PATTERN.test(value);
}

function cleanActorDisplayName(
  value: string | undefined,
  userId?: string,
): string | undefined {
  const normalized = clean(value);
  if (!normalized) {
    return undefined;
  }
  if (userId && normalized === userId) {
    return undefined;
  }
  return isSlackUserId(normalized) ? undefined : normalized;
}

function cleanActorEmail(value: string | undefined): string | undefined {
  const normalized = clean(value);
  return normalized && EMAIL_PATTERN.test(normalized) ? normalized : undefined;
}

/** Normalize a requester object without promoting platform IDs into display identity. */
export function normalizeActorIdentity(
  requester: ActorIdentityInput | undefined,
  requesterId?: string,
): ActorIdentityInput | undefined {
  const contextUserId = clean(requesterId);
  const requesterUserId = clean(requester?.userId);
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

/** Build Slack actor identity from the resolved Slack profile source of truth. */
export function slackActorIdentity(
  userId: string,
  profile: SlackActorProfile | null | undefined,
): ActorIdentityInput {
  const actorUserId = clean(userId);
  if (!actorUserId) {
    throw new Error("Slack actor identity requires a user id");
  }
  return (
    normalizeActorIdentity(
      {
        email: profile?.email,
        fullName: profile?.fullName,
        userId: actorUserId,
        userName: profile?.userName,
      },
      actorUserId,
    ) ?? { userId: actorUserId }
  );
}
