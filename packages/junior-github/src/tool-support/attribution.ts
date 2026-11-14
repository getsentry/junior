import * as z from "zod";
import type {
  Actor,
  Identity,
  PluginEgress,
  PluginLogger,
  Source,
  User,
} from "@sentry/junior-plugin-api";
import { githubApi, githubErrorMessage } from "./github-api.js";

export const GITHUB_REQUEST_ATTRIBUTION_START =
  "<!-- junior-request-attribution:start -->";
export const GITHUB_REQUEST_ATTRIBUTION_END =
  "<!-- junior-request-attribution:end -->";

const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;
// Only a safe login character set; exact GitHub rules vary. Enterprise Managed
// User logins add an `_shortcode` suffix, so underscores must stay valid.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Return a GitHub login without a leading `@`, when it is a valid login. */
export function parseGitHubLogin(
  value: string | undefined,
): string | undefined {
  const login = value?.trim().replace(/^@/, "");
  return login && GITHUB_LOGIN_PATTERN.test(login) ? login : undefined;
}

/**
 * Return the GitHub login linked to a user, when it is a valid login.
 *
 * Attribution mentions, PR assignment, and review requests use this login so
 * the requester gets GitHub notifications for the issue or pull request.
 */
export function linkedGitHubLogin(user: User | undefined): string | undefined {
  return parseGitHubLogin(
    user?.identities.find((identity) => identity.provider === "github")?.handle,
  );
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

/** Render the attribution block wire format parsed by `parseExistingLabels`. */
function formatAttributionBlock(labels: string[]): string {
  return `${GITHUB_REQUEST_ATTRIBUTION_START}\nvia ${labels.join(", ")}.\n${GITHUB_REQUEST_ATTRIBUTION_END}`;
}

const ATTRIBUTION_BLOCK = new RegExp(
  `${GITHUB_REQUEST_ATTRIBUTION_START}([\\s\\S]*?)${GITHUB_REQUEST_ATTRIBUTION_END}`,
);

function blockLabels(body: string | undefined): string[] {
  const contents = body?.match(ATTRIBUTION_BLOCK)?.[1];
  return contents === undefined ? [] : parseExistingLabels(contents);
}

/**
 * Merge requesters from the body on GitHub, the new body, and the current
 * Actor, in that order and without duplicates.
 */
function applyAttribution(
  body: string,
  label: string | undefined,
  currentBody: string | undefined,
): string {
  const normalizedBody = body.trimEnd();
  const labels = [
    ...new Set([
      ...blockLabels(currentBody),
      ...blockLabels(normalizedBody),
      ...(label ? [label] : []),
    ]),
  ];
  const attribution = labels.length
    ? formatAttributionBlock(labels)
    : undefined;
  if (ATTRIBUTION_BLOCK.test(normalizedBody)) {
    return attribution
      ? normalizedBody.replace(ATTRIBUTION_BLOCK, attribution)
      : normalizedBody.replace(ATTRIBUTION_BLOCK, "").trimEnd();
  }
  if (!attribution) {
    return normalizedBody;
  }
  return normalizedBody ? `${normalizedBody}\n\n${attribution}` : attribution;
}

/**
 * Replace a person's name labels in the attribution block with their GitHub
 * mention, so GitHub subscribes them. Use it after they link their GitHub
 * account. Return undefined when the body has no label of that person.
 */
export function mentionLinkedRequester(
  body: string,
  user: User,
): string | undefined {
  const login = linkedGitHubLogin(user);
  if (!login) return undefined;
  const names = new Set(
    [
      user.displayName,
      ...user.identities.flatMap((identity) => [
        identity.displayName,
        identity.handle,
      ]),
    ]
      .map((name) => cleanDisplayValue(name))
      .filter((name): name is string => Boolean(name))
      .map((name) => `**${name.replaceAll("*", "\\*")}**`),
  );
  const labels = blockLabels(body);
  if (!labels.some((label) => names.has(label))) return undefined;
  const mentioned = [
    ...new Set(labels.map((label) => (names.has(label) ? `@${login}` : label))),
  ];
  return body.replace(ATTRIBUTION_BLOCK, formatAttributionBlock(mentioned));
}

/**
 * Read the body that is on GitHub now, so an update keeps its requesters.
 * The model sees descriptions with the attribution block removed.
 */
export async function readGitHubBody(
  egress: PluginEgress,
  input: { operation: string; path: string },
): Promise<string | undefined> {
  const response = await githubApi(egress, input);
  if (!response.ok) {
    throw new Error(
      `GitHub read before update failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`,
    );
  }
  return (
    z.object({ body: z.string().nullable().optional() }).parse(response.body)
      .body ?? undefined
  );
}

/** The stored Junior identity and user of the Actor that makes a GitHub write. */
export interface GitHubRequester {
  identity?: Identity;
  user?: User;
}

/**
 * Look up the current Actor once for one GitHub write. The attribution block,
 * the saved pull request requester, and the assignee all use this one result.
 *
 * System actors have no requester. The lookup is best effort: a failure is
 * logged and gives no requester, so it never blocks the write.
 */
export async function resolveGitHubRequester(ctx: {
  actor?: Actor;
  log: PluginLogger;
  users: {
    resolveActor(): Promise<GitHubRequester | undefined>;
  };
}): Promise<GitHubRequester | undefined> {
  if (!ctx.actor || ctx.actor.platform === "system") return undefined;
  try {
    return await ctx.users.resolveActor();
  } catch (error) {
    ctx.log.warn("github.requester.resolve_actor.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Append or replace runtime-owned requester attribution in a GitHub body.
 * Pass `currentBody` on updates so requesters already on GitHub are kept.
 * With no stored requester, the label falls back to the already-hydrated
 * actor profile.
 */
export function appendGitHubRequesterAttribution(
  body: string,
  ctx: {
    actor?: Actor;
    automationLink?: { url: string };
    source?: Source;
  },
  requester: GitHubRequester | undefined,
  currentBody?: string,
): string {
  return applyAttribution(
    body,
    requesterLabel({
      actor: ctx.actor,
      automationUrl: ctx.automationLink?.url,
      identity: requester?.identity,
      source: ctx.source,
      user: requester?.user,
    }),
    currentBody,
  );
}
