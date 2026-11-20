// Port of `serializeGenAiAttribute` in chat/logging.ts and the secret
// redaction that it applies. A model request span of a public Conversation
// records its messages through it. Keep the two in step: the span drift test
// compares them.

const SECRETS_RE = [
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\bBearer\s+([A-Za-z0-9._\-+=]{20,})\b/gi,
  /\b[A-Z0-9_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*([^\s"']{8,})/gi,
];

function findNextBlankLineBoundary(
  input: string,
  start: number,
): { start: number; end: number } | null {
  const lfBoundary = input.indexOf("\n\n", start);
  const crlfBoundary = input.indexOf("\r\n\r\n", start);

  if (lfBoundary === -1 && crlfBoundary === -1) {
    return null;
  }
  if (lfBoundary === -1) {
    return { start: crlfBoundary, end: crlfBoundary + 4 };
  }
  if (crlfBoundary === -1 || lfBoundary < crlfBoundary) {
    return { start: lfBoundary, end: lfBoundary + 2 };
  }
  return { start: crlfBoundary, end: crlfBoundary + 4 };
}

function redactPrivateKeyBlocks(input: string): string {
  const beginPrefix = "-----BEGIN ";
  const footerMarker = "-----";
  let cursor = 0;
  let output = "";

  while (cursor < input.length) {
    const begin = input.indexOf(beginPrefix, cursor);
    if (begin === -1) {
      output += input.slice(cursor);
      break;
    }

    const labelStart = begin + beginPrefix.length;
    const labelEnd = input.indexOf(footerMarker, labelStart);
    if (labelEnd === -1) {
      output += input.slice(cursor);
      break;
    }

    const label = input.slice(labelStart, labelEnd);
    if (!label.endsWith("PRIVATE KEY")) {
      output += input.slice(cursor, labelEnd + footerMarker.length);
      cursor = labelEnd + footerMarker.length;
      continue;
    }

    const header = input.slice(begin, labelEnd + footerMarker.length);
    const footer = `-----END ${label}-----`;
    const footerStart = input.indexOf(footer, labelEnd + footerMarker.length);
    if (footerStart === -1) {
      const resumeBoundary = findNextBlankLineBoundary(
        input,
        labelEnd + footerMarker.length,
      );
      output += input.slice(cursor, begin);
      output += `${header}\n...redacted...`;
      if (!resumeBoundary) {
        break;
      }
      output += input.slice(resumeBoundary.start, resumeBoundary.end);
      cursor = resumeBoundary.end;
      continue;
    }

    output += input.slice(cursor, begin);
    output += `${header}\n...redacted...\n${footer}`;
    cursor = footerStart + footer.length;
  }

  return output;
}

function redactSecrets(input: string): string {
  let out = redactPrivateKeyBlocks(input);
  for (const pattern of SECRETS_RE) {
    out = out.replace(pattern, (full, token: string) => {
      if (typeof token !== "string") {
        return "***";
      }
      if (token.length < 12) {
        return full.replace(token, "***");
      }
      return full.replace(token, `${token.slice(0, 4)}...${token.slice(-4)}`);
    });
  }
  return out;
}

const GEN_AI_DEFAULT_MAX_ATTRIBUTE_CHARS = 100_000;
const GEN_AI_MAX_ARRAY_ITEMS = 50;
const GEN_AI_MAX_OBJECT_KEYS = 50;

function truncateGenAiString(value: string, maxChars: number): string {
  return value.length > maxChars ? "" : value;
}

function sanitizeGenAiValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  keyName?: string,
): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const shouldTreatAsBlob =
      (keyName === "data" ||
        keyName === "base64" ||
        keyName?.endsWith("_base64") === true) &&
      value.length > 256;
    if (shouldTreatAsBlob) {
      return `[omitted:${value.length}]`;
    }
    return redactSecrets(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (depth >= 8) {
    return "[depth_limit]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, GEN_AI_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeGenAiValue(entry, seen, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value !== "object") {
    return redactSecrets(String(value));
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value).slice(
    0,
    GEN_AI_MAX_OBJECT_KEYS,
  )) {
    const sanitized = sanitizeGenAiValue(entryValue, seen, depth + 1, key);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

/** Serialize a value for a gen_ai span attribute, with secrets redacted. */
export function serializeGenAiAttribute(
  value: unknown,
  maxChars = GEN_AI_DEFAULT_MAX_ATTRIBUTE_CHARS,
): string | undefined {
  const sanitized = sanitizeGenAiValue(value, new WeakSet<object>(), 0);
  if (sanitized === undefined) {
    return undefined;
  }

  const serialized =
    typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  if (!serialized) {
    return undefined;
  }

  return truncateGenAiString(redactSecrets(serialized), maxChars) || undefined;
}
