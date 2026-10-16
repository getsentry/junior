import type { ReplyAttribution } from "@sentry/junior-plugin-api";

/** Name the Automation in the footer of the replies that its runs post. */
export function automationReplyAttribution(
  title: string | undefined,
): ReplyAttribution {
  const detail = (title ?? "").replace(/\s+/g, " ").trim().slice(0, 128).trim();
  return detail ? { label: "Automation", detail } : { label: "Automation" };
}
