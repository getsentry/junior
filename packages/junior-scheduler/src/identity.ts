import type { ScheduledTaskPrincipal } from "./types";

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{5,}$/;

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function cleanSlackUserId(value: string | undefined): string | undefined {
  const normalized = clean(value);
  return normalized && normalized.toLowerCase() !== "unknown"
    ? normalized
    : undefined;
}

function cleanDisplay(
  value: string | undefined,
  slackUserId: string,
): string | undefined {
  const normalized = clean(value);
  if (
    !normalized ||
    normalized.toLowerCase() === "unknown" ||
    normalized === slackUserId
  ) {
    return undefined;
  }
  return SLACK_USER_ID_PATTERN.test(normalized) ? undefined : normalized;
}

/** Keep scheduler creator metadata from promoting Slack IDs into display names. */
export function sanitizeScheduledTaskPrincipal(
  principal: ScheduledTaskPrincipal,
): ScheduledTaskPrincipal {
  const slackUserId = cleanSlackUserId(principal.slackUserId);
  if (!slackUserId) {
    throw new Error("Scheduled task principal requires a Slack user id");
  }
  const fullName = cleanDisplay(principal.fullName, slackUserId);
  const userName = cleanDisplay(principal.userName, slackUserId);
  return {
    slackUserId,
    ...(fullName ? { fullName } : {}),
    ...(userName ? { userName } : {}),
  };
}

/** Render scheduler creator metadata without inventing human profile fields. */
export function scheduledTaskPrincipalLabel(
  principal: ScheduledTaskPrincipal,
): string {
  const author = sanitizeScheduledTaskPrincipal(principal);
  if (author.fullName && author.userName) {
    return `${author.fullName} (@${author.userName})`;
  }
  if (author.fullName) {
    return author.fullName;
  }
  if (author.userName) {
    return `@${author.userName}`;
  }
  return `Slack User ${author.slackUserId}`;
}
