import type { Actor } from "@sentry/junior-plugin-api";

export const GITHUB_REQUEST_ATTRIBUTION_START =
  "<!-- junior-request-attribution:start -->";
export const GITHUB_REQUEST_ATTRIBUTION_END =
  "<!-- junior-request-attribution:end -->";

function cleanDisplayValue(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/[\r\n<>]/g, " ").trim();
  return cleaned || undefined;
}

function actorLabel(actor: Actor | undefined): string | undefined {
  if (!actor) {
    return undefined;
  }
  if (actor.platform === "system") {
    return `Junior system actor \`${actor.name}\``;
  }
  const display =
    cleanDisplayValue(actor.fullName) ??
    cleanDisplayValue(actor.userName) ??
    cleanDisplayValue(actor.userId);
  return display ? `**${display.replaceAll("*", "\\*")}**` : undefined;
}

/** Append or replace runtime-owned requester attribution in a GitHub body. */
export function appendGitHubRequesterAttribution(
  body: string,
  actor: Actor | undefined,
): string {
  const label = actorLabel(actor);
  const attribution = label
    ? `${GITHUB_REQUEST_ATTRIBUTION_START}\nRequested by ${label} via Junior.\n${GITHUB_REQUEST_ATTRIBUTION_END}`
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
