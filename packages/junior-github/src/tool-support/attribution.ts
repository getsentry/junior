import type {
  Actor,
  Identity,
  PluginLogger,
  User,
} from "@sentry/junior-plugin-api";

export const GITHUB_REQUEST_ATTRIBUTION_START =
  "<!-- junior-request-attribution:start -->";
export const GITHUB_REQUEST_ATTRIBUTION_END =
  "<!-- junior-request-attribution:end -->";

const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;

/**
 * Match host actor display cleaning: drop blanks, unknown, the actor id, and
 * Slack user-id shaped values so attribution never publishes a raw subject id.
 */
function cleanDisplayValue(
  value: string | undefined,
  userId?: string,
): string | undefined {
  const cleaned = value?.replace(/[\r\n<>]/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.toLowerCase() === "unknown") {
    return undefined;
  }
  if (userId && cleaned === userId) {
    return undefined;
  }
  if (SLACK_USER_ID_DISPLAY_PATTERN.test(cleaned)) {
    return undefined;
  }
  return cleaned;
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
  return display ? `**${display.replaceAll("*", "\\*")}**` : undefined;
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

/**
 * Append or replace runtime-owned requester attribution in a GitHub body.
 *
 * Identity lookup is best-effort presentation data. A storage failure falls
 * back to the already-hydrated actor profile instead of blocking the write.
 */
export async function appendGitHubRequesterAttribution(
  body: string,
  ctx: {
    actor?: Actor;
    log: PluginLogger;
    users: {
      resolveActor(): Promise<{ identity?: Identity; user?: User } | undefined>;
    };
  },
): Promise<string> {
  let resolved:
    | {
        identity?: Identity;
        user?: User;
      }
    | undefined;
  if (ctx.actor) {
    try {
      resolved = await ctx.users.resolveActor();
    } catch (error) {
      ctx.log.warn("github.requester_attribution.resolve_actor.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
  }
  return applyAttribution(
    body,
    requesterLabel({
      actor: ctx.actor,
      identity: resolved?.identity,
      user: resolved?.user,
    }),
  );
}
