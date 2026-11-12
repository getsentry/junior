const MAX_CAUSE_DEPTH = 5;

/**
 * Format a failed CLI command with its cause chain. Drizzle wraps database
 * errors in "Failed query: ...", so the Postgres reason is only in `cause`.
 */
export function formatCliFailure(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  while (current !== undefined && lines.length < MAX_CAUSE_DEPTH) {
    if (!(current instanceof Error)) {
      lines.push(String(current));
      break;
    }
    const code = "code" in current ? current.code : undefined;
    lines.push(
      typeof code === "string" && code
        ? `${current.message.trim()} (${code})`
        : current.message.trim(),
    );
    current = current.cause;
  }
  return lines.join("\ncaused by: ");
}
