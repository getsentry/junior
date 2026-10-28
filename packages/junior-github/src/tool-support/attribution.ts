import type {
  Actor,
  Identity,
  PluginLogger,
  Source,
  User,
} from "@sentry/junior-plugin-api";

export const GITHUB_REQUEST_ATTRIBUTION_START =
  "<!-- junior-request-attribution:start -->";
export const GITHUB_REQUEST_ATTRIBUTION_END =
  "<!-- junior-request-attribution:end -->";
const GITHUB_REQUEST_ATTRIBUTION_BLOCK = new RegExp(
  `${GITHUB_REQUEST_ATTRIBUTION_START}([\\s\\S]*?)${GITHUB_REQUEST_ATTRIBUTION_END}`,
);

const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;
// Only a safe login character set; exact GitHub rules vary. Enterprise Managed
// User logins add an `_shortcode` suffix, so underscores must stay valid.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * Return the GitHub login linked to a user, when it is a valid login.
 *
 * Attribution mentions and PR assignment use this login so the requester gets
 * GitHub notifications for the issue or pull request.
 */
export function linkedGitHubLogin(user: User | undefined): string | undefined {
  const login = user?.identities
    .find((identity) => identity.provider === "github")
    ?.handle?.trim()
    .replace(/^@/, "");
  return login && GITHUB_LOGIN_PATTERN.test(login) ? login : undefined;
}

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

/** Name the Automation run that made this write. */
function automationLabel(
  source: Source | undefined,
  automationUrl: string | undefined,
): string | undefined {
  if (
    (source?.kind !== "event_automation" &&
      source?.kind !== "scheduled_automation") ||
    !source.automationId
  ) {
    return undefined;
  }
  const automation = `automation \`${source.automationId}\``;
  const label = automationUrl
    ? `[${automation}](${automationUrl})`
    : automation;
  return source.automationRunId
    ? `${label} · Run ID \`${source.automationRunId}\``
    : label;
}

/**
 * Resolve the requester display label through the host identity path first.
 *
 * Automation runs use the automation label. Other system actors get no label
 * because their names are internal. For people, prefer a linked GitHub login
 * as an `@` mention so GitHub subscribes the requester. Otherwise use the
 * linked user name, then the stored identity name/handle, then the
 * already-hydrated actor profile. Never publish a raw actor id.
 */
function requesterLabel(args: {
  actor: Actor | undefined;
  automationUrl?: string;
  identity?: Identity;
  source?: Source;
  user?: User;
}): string | undefined {
  const { actor, identity, user } = args;
  const automation = automationLabel(args.source, args.automationUrl);
  if (automation) {
    return automation;
  }
  if (!actor || actor.platform === "system") {
    return undefined;
  }

  const login = linkedGitHubLogin(user);
  if (login) {
    return `@${login}`;
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

/**
 * Recover the ordered list of prior requester labels from an existing
 * attribution block, including the legacy `Requested by` and `via A, via B`
 * wordings, so a new requester can be appended instead of replacing them.
 */
function parseExistingLabels(blockContents: string): string[] {
  const trimmed = blockContents.trim().replace(/\.$/, "");
  if (!trimmed) {
    return [];
  }
  const withoutLeadIn = trimmed.replace(/^(?:Requested by|via)\s+/i, "");
  // Only split on a comma that starts the next label (bold markdown, a GitHub
  // mention, an automation label, a system-actor label, or a legacy repeated
  // "via") so a display name that itself contains a comma is not broken into
  // extra labels.
  return withoutLeadIn
    .split(/,\s*(?=\*\*|@|\[?automation `|Junior system actor `|via\s)/i)
    .map((entry) => entry.trim().replace(/^via\s+/i, ""))
    .filter(Boolean);
}

/**
 * Return the GitHub login of the first requester in an attribution block.
 *
 * The block names a login only when that requester linked a GitHub account.
 * Anyone can write the block, so trust the result only for bodies that the
 * Junior bot wrote.
 */
export function attributedRequesterLogin(
  body: string | null | undefined,
): string | undefined {
  const contents = body?.match(GITHUB_REQUEST_ATTRIBUTION_BLOCK)?.[1];
  const first = contents ? parseExistingLabels(contents)[0] : undefined;
  const login = first?.startsWith("@") ? first.slice(1) : undefined;
  return login && GITHUB_LOGIN_PATTERN.test(login) ? login : undefined;
}

/** Render the attribution block wire format parsed by `parseExistingLabels`. */
function formatAttributionBlock(labels: string[]): string {
  return `${GITHUB_REQUEST_ATTRIBUTION_START}\nvia ${labels.join(", ")}.\n${GITHUB_REQUEST_ATTRIBUTION_END}`;
}

function applyAttribution(body: string, label: string | undefined): string {
  const normalizedBody = body.trimEnd();
  const existingMatch = normalizedBody.match(GITHUB_REQUEST_ATTRIBUTION_BLOCK);
  const existingLabels =
    existingMatch?.[1] !== undefined
      ? parseExistingLabels(existingMatch[1])
      : [];
  const labels =
    label && !existingLabels.includes(label)
      ? [...existingLabels, label]
      : existingLabels;
  const attribution = labels.length
    ? formatAttributionBlock(labels)
    : undefined;
  if (existingMatch) {
    return attribution
      ? normalizedBody.replace(GITHUB_REQUEST_ATTRIBUTION_BLOCK, attribution)
      : normalizedBody.replace(GITHUB_REQUEST_ATTRIBUTION_BLOCK, "").trimEnd();
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
    automationLink?: { url: string };
    log: PluginLogger;
    source?: Source;
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
      automationUrl: ctx.automationLink?.url,
      identity: resolved?.identity,
      source: ctx.source,
      user: resolved?.user,
    }),
  );
}
