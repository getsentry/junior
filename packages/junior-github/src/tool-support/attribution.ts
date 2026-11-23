import * as z from "zod";
import {
  PluginToolInputError,
  type Actor,
  type PluginEgress,
  type PluginLogger,
  type PluginWorkOwner,
  type Source,
  type User,
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

/**
 * Whether a person started this Turn from its own surface. An Automation run,
 * Event, plugin dispatch, or Parent message acts for no person. Core's
 * Automation tools use the same rule.
 */
export function startedByPerson(ctx: {
  actor?: Actor | undefined;
  source?: Source | undefined;
}): boolean {
  return !!ctx.actor && ctx.actor.platform === ctx.source?.kind;
}

/**
 * Name the work owner of this write. For a person, prefer a linked GitHub
 * login as an `@` mention so GitHub subscribes them. Otherwise use the linked
 * user name, then the stored identity name/handle, then the Turn Actor's
 * already-hydrated profile. Never publish a raw actor id. A system owner,
 * such as an Automation run, is named by its record.
 */
function requesterLabel(
  owner: PluginWorkOwner | undefined,
): string | undefined {
  if (!owner) return undefined;
  if (owner.kind === "system") {
    const record = `${owner.name} \`${owner.id}\``;
    const label = owner.url ? `[${record}](${owner.url})` : record;
    return owner.runId ? `${label} · Run ID \`${owner.runId}\`` : label;
  }
  const { actor, identity, user } = owner;
  const login = linkedGitHubLogin(user);
  if (login) {
    return `@${login}`;
  }

  const userId = actor?.userId;
  const display =
    cleanDisplayValue(user?.displayName, userId) ??
    cleanDisplayValue(identity?.displayName, userId) ??
    cleanDisplayValue(identity?.handle, userId) ??
    cleanDisplayValue(actor?.fullName, userId) ??
    cleanDisplayValue(actor?.userName, userId);
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
  // mention, a system record label such as an Automation run, a legacy
  // system-actor label, or a legacy repeated "via") so a display name that
  // itself contains a comma is not broken into extra labels.
  return withoutLeadIn
    .split(/,\s*(?=\*\*|@|\[?[a-z][a-z ]* `|via\s)/i)
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

/**
 * Look up the requester once for one GitHub write. The attribution block,
 * the saved pull request requester, and the assignee all use this one result.
 * The host decides whose work the Turn does. When the lookup fails, a person
 * who runs the Turn keeps their hydrated profile, and a system Turn fails.
 */
export async function resolveGitHubRequester(ctx: {
  actor?: Actor | undefined;
  log: PluginLogger;
  resolveWorkOwner(): Promise<PluginWorkOwner | undefined>;
}): Promise<PluginWorkOwner | undefined> {
  try {
    return await ctx.resolveWorkOwner();
  } catch (error) {
    const { actor } = ctx;
    // Only a person Turn has a fallback. A system Turn rethrows, so a failed
    // lookup is not reported as work that nobody asked for.
    if (!actor || actor.platform === "system") throw error;
    ctx.log.warn("github.requester.resolve_work_owner.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return { kind: "person", actor };
  }
}

/** Return the requester when it is a person, for assignment and openers. */
export function requesterPerson(
  requester: PluginWorkOwner | undefined,
): Extract<PluginWorkOwner, { kind: "person" }> | undefined {
  return requester?.kind === "person" ? requester : undefined;
}

/**
 * Reject a pull request that would not say who it is for. The check uses the
 * same label as the attribution block, so a pull request that passes always
 * names its work owner.
 */
export function assertGitHubPullRequestRequester(
  requester: PluginWorkOwner | undefined,
): void {
  if (requesterLabel(requester)) return;
  throw new PluginToolInputError(
    requester?.kind === "person"
      ? "Cannot open a pull request: the person who asked for it has no linked GitHub account or name to attribute it to. Do not retry. Ask them to link their GitHub account and ask again, or report it as blocked."
      : "Cannot open a pull request: no person or Automation run asked for this work. Do not retry. Report it as blocked, so the person who wants it can ask for it.",
  );
}

/**
 * Append or replace runtime-owned requester attribution in a GitHub body.
 * Pass `currentBody` on updates so requesters already on GitHub are kept.
 * With no stored requester, the label falls back to the already-hydrated
 * actor profile.
 */
export function appendGitHubRequesterAttribution(
  body: string,
  requester: PluginWorkOwner | undefined,
  currentBody?: string,
): string {
  return applyAttribution(body, requesterLabel(requester), currentBody);
}
