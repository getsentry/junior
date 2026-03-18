// Slack assistant.threads.setStatus enforces a 50-char limit on the status field.
const SLACK_STATUS_MAX_LENGTH = 50;

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

export function truncateStatusText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return truncateWithEllipsis(trimmed, SLACK_STATUS_MAX_LENGTH);
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

export function compactStatusText(
  value: unknown,
  maxLength = 80,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateWithEllipsis(trimmed, maxLength);
}

function readShellToken(
  command: string,
  startIndex: number,
): { token: string; nextIndex: number } | undefined {
  let index = startIndex;
  while (index < command.length && /\s/.test(command[index] ?? "")) {
    index += 1;
  }

  if (index >= command.length) {
    return undefined;
  }

  let token = "";
  let quote: '"' | "'" | undefined;

  while (index < command.length) {
    const char = command[index];
    if (!char) {
      break;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        index += 1;
        continue;
      }

      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        token += command[index + 1];
        index += 2;
        continue;
      }

      token += char;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      break;
    }

    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      token += command[index + 1];
      index += 2;
      continue;
    }

    token += char;
    index += 1;
  }

  return { token, nextIndex: index };
}

export function compactStatusCommand(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let index = 0;
  while (index < trimmed.length) {
    const parsed = readShellToken(trimmed, index);
    if (!parsed) {
      return undefined;
    }

    index = parsed.nextIndex;
    if (!parsed.token) {
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parsed.token)) {
      continue;
    }

    const normalized = parsed.token.replace(/[\\/]+$/g, "");
    if (!normalized) {
      return undefined;
    }

    const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
    const command = parts.length > 0 ? parts[parts.length - 1] : normalized;
    return compactStatusText(command, 40);
  }

  return undefined;
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
