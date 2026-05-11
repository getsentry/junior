/** Parse Slack archive URLs into structured message references. */

export interface SlackMessageReference {
  channelId: string;
  messageTs: string;
  threadTs?: string;
  url?: string;
}

type ParseResult =
  | { ok: true; reference: SlackMessageReference }
  | { ok: false; error: string };

const SLACK_HOST_PATTERN = /^[a-z0-9-]+\.slack(?:-gov)?\.com$/;
const ARCHIVE_PATH_PATTERN =
  /^\/archives\/([A-Z][A-Z0-9_]+)\/p(\d{10})(\d{6})$/;

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

  if (!SLACK_HOST_PATTERN.test(parsed.hostname)) {
    return { ok: false, error: "Not a Slack archive URL" };
  }

  const pathMatch = ARCHIVE_PATH_PATTERN.exec(parsed.pathname);
  if (!pathMatch) {
    return { ok: false, error: "URL path does not match Slack archive format" };
  }

  const channelId = pathMatch[1]!;
  const messageTs = pTimestampToTs(pathMatch[2]!, pathMatch[3]!);

  // Handle HTML-encoded ampersands from some Slack contexts.
  const searchString = parsed.search.replace(/&amp;/g, "&");
  const params = new URLSearchParams(searchString.replace(/^\?/, ""));

  const threadTs = params.get("thread_ts") || undefined;

  return {
    ok: true,
    reference: {
      channelId,
      messageTs,
      threadTs,
      url: raw,
    },
  };
}
