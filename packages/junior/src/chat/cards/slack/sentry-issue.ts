import type { resolveCardTemplate } from "@/chat/cards/template";
import type { SlackRenderedMessage } from "@/chat/tools/types";

interface SentryIssueCardData {
  shortId?: unknown;
  title?: unknown;
  permalink?: unknown;
  status?: unknown;
  project?: unknown;
  level?: unknown;
  count?: unknown;
  userCount?: unknown;
  lastSeen?: unknown;
  assignee?: unknown;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function escapeMrkdwn(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatField(
  label: string,
  value: string | number | undefined,
): {
  type: "mrkdwn";
  text: string;
} | null {
  if (value === undefined || value === "") {
    return null;
  }

  return {
    type: "mrkdwn",
    text: `*${escapeMrkdwn(label)}*\n${escapeMrkdwn(String(value))}`,
  };
}

function getStatusTone(
  status: string,
  level?: string,
): {
  color: string;
  label: string;
} {
  const normalizedStatus = status.trim().toLowerCase();
  const normalizedLevel = level?.trim().toLowerCase();

  if (normalizedStatus === "resolved") {
    return { color: "#2EB67D", label: "Resolved" };
  }
  if (normalizedStatus === "ignored") {
    return { color: "#6B7280", label: "Ignored" };
  }
  if (normalizedLevel === "warning") {
    return { color: "#ECB22E", label: "Warning" };
  }
  return { color: "#E01E5A", label: "Unresolved" };
}

function buildFooterText(data: {
  lastSeen?: string;
  project?: string;
  count?: string;
  userCount?: number;
}): string {
  const parts = ["Sentry issue"];

  if (data.project) {
    parts.push(`Project ${data.project}`);
  }
  if (data.count) {
    parts.push(`${data.count} events`);
  }
  if (typeof data.userCount === "number") {
    parts.push(`${data.userCount} users`);
  }
  if (data.lastSeen) {
    parts.push(`Last seen ${data.lastSeen}`);
  }

  return parts.map(escapeMrkdwn).join("  •  ");
}

/** Build a Slack-native issue card payload for Sentry issue results. */
export function renderSlackSentryIssueCard(input: {
  data: Record<string, unknown>;
  resolved: ReturnType<typeof resolveCardTemplate>;
}): SlackRenderedMessage {
  const raw = input.data as SentryIssueCardData;
  const shortId = asText(raw.shortId);
  const title = asText(raw.title);
  const permalink = asText(raw.permalink);
  const status = asText(raw.status);
  const project = asText(raw.project);
  const level = asText(raw.level);
  const count = asText(raw.count);
  const lastSeen = asText(raw.lastSeen);
  const assignee = asText(raw.assignee) ?? "Unassigned";
  const userCount =
    typeof raw.userCount === "number" && Number.isFinite(raw.userCount)
      ? raw.userCount
      : undefined;

  if (!shortId || !title || !permalink || !status) {
    throw new Error(
      "Sentry issue card requires shortId, title, permalink, and status",
    );
  }

  const statusTone = getStatusTone(status, level);
  const fields = [
    formatField("Status", statusTone.label),
    formatField("Level", level),
    formatField("Project", project),
    formatField("Assignee", assignee),
    formatField("Events", count),
    formatField("Users", userCount),
  ].filter((field): field is NonNullable<typeof field> => Boolean(field));

  return {
    attachments: [
      {
        color: statusTone.color,
        fallback: input.resolved.fallbackText,
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: buildFooterText({
                  lastSeen,
                  project,
                  count,
                  userCount,
                }),
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*<${permalink}|${escapeMrkdwn(shortId)}>*\n${escapeMrkdwn(title)}`,
            },
            accessory: {
              type: "button",
              text: {
                type: "plain_text",
                text: "Open in Sentry",
                emoji: true,
              },
              url: permalink,
              action_id: "open_sentry_issue",
            },
          },
          ...(fields.length > 0
            ? [
                {
                  type: "section",
                  fields,
                },
              ]
            : []),
        ],
      },
    ],
  };
}
