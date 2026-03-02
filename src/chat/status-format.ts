// Slack assistant.threads.setStatus enforces a 50-char limit on the status field.
export const SLACK_STATUS_MAX_LENGTH = 50;

export function truncateStatusText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

export function compactStatusPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length <= 80) {
    return trimmed;
  }

  return `...${trimmed.slice(-77)}`;
}

export function compactStatusText(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const compacted = truncateStatusText(value, maxLength);
  return compacted || undefined;
}

export function compactStatusFilename(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  const filename = parts.length > 0 ? parts[parts.length - 1] : trimmed;
  return compactStatusText(filename, 80);
}

export function extractStatusUrlDomain(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}
