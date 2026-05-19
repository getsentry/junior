const SLACK_FILE_ID_PATTERN = /^F[A-Z0-9]{4,}$/i;
const SLACK_CANVAS_PATH_PATTERN =
  /^\/(?:docs|canvas|files)\/(?:T[A-Z0-9]+\/)?(?:U[A-Z0-9]+\/)?(F[A-Z0-9]{4,})(?:\/|$)/i;

function isSlackHost(hostname: string): boolean {
  return hostname === "slack.com" || hostname.endsWith(".slack.com");
}

function normalizeReferenceInput(input: string): string {
  let value = input.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1);
  }
  return value.split("|", 1)[0]?.trim() ?? "";
}

/** Resolve a Slack Canvas/file ID from a bare ID or Slack docs/canvas/files URL. */
export function extractCanvasId(input: string): string | undefined {
  const trimmed = normalizeReferenceInput(input);
  if (!trimmed) return undefined;

  if (SLACK_FILE_ID_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  try {
    const url = new URL(trimmed);
    if (!isSlackHost(url.hostname)) {
      return undefined;
    }
    const urlMatch = url.pathname.match(SLACK_CANVAS_PATH_PATTERN);
    return urlMatch?.[1]?.toUpperCase();
  } catch {
    return undefined;
  }
}
