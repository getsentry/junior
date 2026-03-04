const DEFAULT_MAX_ATTRIBUTE_CHARS = 12_000;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function truncateString(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function sanitizeForSerialization(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  keyName?: string
): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const shouldTreatAsBlob =
      (keyName === "data" || keyName === "base64" || keyName?.endsWith("_base64") === true) && value.length > 256;
    if (shouldTreatAsBlob) {
      return `[omitted:${value.length}]`;
    }
    return truncateString(value, MAX_STRING_CHARS);
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
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeForSerialization(entry, seen, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record).slice(0, MAX_OBJECT_KEYS)) {
    const sanitized = sanitizeForSerialization(entryValue, seen, depth + 1, key);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

export function serializeGenAiAttribute(value: unknown, maxChars = DEFAULT_MAX_ATTRIBUTE_CHARS): string | undefined {
  const sanitized = sanitizeForSerialization(value, new WeakSet<object>(), 0);
  if (sanitized === undefined) {
    return undefined;
  }

  const serialized = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  if (!serialized) {
    return undefined;
  }

  return truncateString(serialized, maxChars);
}

function toFiniteTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : undefined;
}

function readTokenCount(root: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toFiniteTokenCount(root[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function collectUsageRoots(source: unknown): Record<string, unknown>[] {
  const sourceRecord = asRecord(source);
  if (!sourceRecord) {
    return [];
  }

  const roots: Record<string, unknown>[] = [sourceRecord];
  const usage = asRecord(sourceRecord.usage);
  if (usage) {
    roots.push(usage);
  }

  const tokenUsage = asRecord(sourceRecord.tokenUsage);
  if (tokenUsage) {
    roots.push(tokenUsage);
  }

  const providerMetadata = asRecord(sourceRecord.providerMetadata);
  if (providerMetadata) {
    roots.push(providerMetadata);
    const providerUsage = asRecord(providerMetadata.usage);
    if (providerUsage) {
      roots.push(providerUsage);
    }
  }

  const response = asRecord(sourceRecord.response);
  if (response) {
    roots.push(response);
    const responseUsage = asRecord(response.usage);
    if (responseUsage) {
      roots.push(responseUsage);
    }
  }

  return roots;
}

export function extractGenAiUsageAttributes(
  ...sources: unknown[]
): Partial<Record<"gen_ai.usage.input_tokens" | "gen_ai.usage.output_tokens", number>> {
  const roots = sources.flatMap((source) => collectUsageRoots(source));
  if (roots.length === 0) {
    return {};
  }

  const inputTokens =
    roots.map((root) =>
      readTokenCount(root, [
        "input_tokens",
        "inputTokens",
        "prompt_tokens",
        "promptTokens",
        "inputTokenCount",
        "promptTokenCount"
      ])
    ).find((value) => value !== undefined) ?? undefined;

  const outputTokens =
    roots.map((root) =>
      readTokenCount(root, [
        "output_tokens",
        "outputTokens",
        "completion_tokens",
        "completionTokens",
        "outputTokenCount",
        "completionTokenCount"
      ])
    ).find((value) => value !== undefined) ?? undefined;

  return {
    ...(inputTokens !== undefined ? { "gen_ai.usage.input_tokens": inputTokens } : {}),
    ...(outputTokens !== undefined ? { "gen_ai.usage.output_tokens": outputTokens } : {})
  };
}
