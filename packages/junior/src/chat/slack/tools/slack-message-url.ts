/** Parse Slack archive URLs into structured message references. */
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

export interface SlackMessageReference {
  channelId: string;
  messageTs: SlackMessageTs;
  threadTs?: SlackMessageTs;
}

type ParseResult =
  | { ok: true; reference: SlackMessageReference }
  | { ok: false; error: string };

const SLACK_HOST_PATTERN = /^[a-z0-9-]+\.slack(?:-gov)?\.com$/;
const ARCHIVE_PATH_PATTERN = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/;

/**
 * Convert a Slack `pNNNNNNNNNNMMMMMM` path segment into a Slack
 * message timestamp (`NNNNNNNNNN.MMMMMM`).
 */
function pTimestampToTs(seconds: string, micros: string): string {
  return `${seconds}.${micros}`;
}

/**
 * Strip Slack mrkdwn angle-bracket wrappers.
 *
 * Handles `<url>` and `<url|label>` forms, returning the bare URL.
 */
function unwrapMrkdwn(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const inner = trimmed.slice(1, -1);
    const pipeIndex = inner.indexOf("|");
    return pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  }
  return trimmed;
}

/** Parse a Slack archive URL (or mrkdwn-wrapped URL) into a message reference. */
export function parseSlackMessageReference(input: string): ParseResult {
  const raw = unwrapMrkdwn(input);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Input is not a valid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Slack archive URL must use HTTPS" };
  }

  if (!SLACK_HOST_PATTERN.test(parsed.hostname)) {
    return { ok: false, error: "Not a Slack archive URL" };
  }

  const pathMatch = ARCHIVE_PATH_PATTERN.exec(parsed.pathname);
  if (!pathMatch) {
    return { ok: false, error: "URL path does not match Slack archive format" };
  }

  const channelId = pathMatch[1]!;
  const messageTs = parseSlackMessageTs(
    pTimestampToTs(pathMatch[2]!, pathMatch[3]!),
  );
  if (!messageTs) {
    return { ok: false, error: "Invalid message timestamp in URL" };
  }

  // Handle HTML-encoded ampersands from some Slack contexts.
  const params = new URLSearchParams(parsed.search.replace(/&amp;/g, "&"));
  const rawThreadTs = params.get("thread_ts") || undefined;
  const threadTs = rawThreadTs ? parseSlackMessageTs(rawThreadTs) : undefined;

  if (rawThreadTs && !threadTs) {
    return { ok: false, error: "Invalid thread timestamp in URL" };
  }

  return {
    ok: true,
    reference: { channelId, messageTs, threadTs },
  };
}
