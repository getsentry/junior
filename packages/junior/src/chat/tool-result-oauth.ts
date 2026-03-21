function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return undefined;
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      return undefined;
    }
  }
}

function normalizeToolNameFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as { toolName?: unknown; name?: unknown };
  if (typeof record.toolName === "string" && record.toolName.length > 0) {
    return record.toolName;
  }
  if (typeof record.name === "string" && record.name.length > 0) {
    return record.name;
  }
  return undefined;
}

function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Boolean((result as { isError?: unknown }).isError);
}

function extractOAuthStartedPayload(
  value: unknown,
): { message?: string } | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonCandidate(value);
    return parsed === undefined
      ? undefined
      : extractOAuthStartedPayload(parsed);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractOAuthStartedPayload(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.oauth_started === true) {
    const message =
      typeof record.message === "string" ? record.message.trim() : undefined;
    return message ? { message } : {};
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text =
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : part;
      const found = extractOAuthStartedPayload(text);
      if (found) {
        return found;
      }
    }
  }

  for (const key of ["details", "output", "result", "stdout"]) {
    if (!(key in record)) {
      continue;
    }
    const found = extractOAuthStartedPayload(record[key]);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function extractOAuthStartedMessageFromToolResults(
  toolResults: unknown[],
): string | undefined {
  for (const result of toolResults) {
    if (
      normalizeToolNameFromResult(result) !== "bash" ||
      isToolResultError(result)
    ) {
      continue;
    }

    const found = extractOAuthStartedPayload(result);
    if (found?.message) {
      return found.message;
    }
  }

  return undefined;
}
