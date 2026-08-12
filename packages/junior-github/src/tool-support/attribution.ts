import type {
  Actor,
  Identity,
  ToolRegistrationHookContext,
  User,
} from "@sentry/junior-plugin-api";

export const GITHUB_REQUEST_ATTRIBUTION_START =
  "<!-- junior-request-attribution:start -->";
export const GITHUB_REQUEST_ATTRIBUTION_END =
  "<!-- junior-request-attribution:end -->";

function cleanDisplayValue(
  value: string | undefined,
  userId?: string,
): string | undefined {
  const cleaned = value?.replace(/[\r\n<>]/g, " ").trim();
  if (!cleaned || cleaned === userId) {
    return undefined;
  }
  return cleaned;
}

function boldLabel(value: string): string {
  return `**${value.replaceAll("*", "\\*")}**`;
}

/**
 * Resolve the requester display label through the host identity path first.
 *
 * Prefer the linked user name, then the stored identity name/handle, then the
 * already-hydrated actor profile. Never publish a raw actor id.
 */
function requesterLabel(args: {
  actor: Actor | undefined;
  identity?: Identity;
  user?: User;
}): string | undefined {
  const { actor, identity, user } = args;
  if (!actor) {
    return undefined;
  }
  if (actor.platform === "system") {
    return `Junior system actor \`${actor.name}\``;
  }

  const userId = actor.userId;
  const display =
    cleanDisplayValue(user?.displayName, userId) ??
    cleanDisplayValue(identity?.displayName, userId) ??
    cleanDisplayValue(identity?.handle, userId) ??
    cleanDisplayValue(actor.fullName, userId) ??
    cleanDisplayValue(actor.userName, userId);
  return display ? boldLabel(display) : undefined;
}

function applyAttribution(body: string, label: string | undefined): string {
  const attribution = label
    ? `${GITHUB_REQUEST_ATTRIBUTION_START}\nRequested by ${label}.\n${GITHUB_REQUEST_ATTRIBUTION_END}`
    : undefined;
  const normalizedBody = body.trimEnd();
  const existing = new RegExp(
    `${GITHUB_REQUEST_ATTRIBUTION_START}[\\s\\S]*?${GITHUB_REQUEST_ATTRIBUTION_END}`,
  );
  if (existing.test(normalizedBody)) {
    return attribution
      ? normalizedBody.replace(existing, attribution)
      : normalizedBody.replace(existing, "").trimEnd();
  }
  if (!attribution) {
    return normalizedBody;
  }
  return normalizedBody ? `${normalizedBody}\n\n${attribution}` : attribution;
}

/** Append or replace runtime-owned requester attribution in a GitHub body. */
export async function appendGitHubRequesterAttribution(
  body: string,
  ctx: Pick<ToolRegistrationHookContext, "actor" | "users">,
): Promise<string> {
  const resolved = ctx.actor ? await ctx.users.resolveActor() : undefined;
  return applyAttribution(
    body,
    requesterLabel({
      actor: ctx.actor,
      identity: resolved?.identity,
      user: resolved?.user,
    }),
  );
}
