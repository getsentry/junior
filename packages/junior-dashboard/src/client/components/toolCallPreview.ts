import { stringifyPartValue } from "../format";

const MAX_VALUE_LENGTH = 48;
const MAX_PREVIEW_LENGTH = 120;
const MAX_OBJECT_ENTRIES = 4;

/** Format the useful arguments from a tool call for its collapsed transcript row. */
export function toolCallPreview(name: string, input: unknown): string | null {
  if (name === "bash") {
    return fieldValue(input, "command");
  }

  if (name === "loadSkill") {
    return fieldValue(input, "skill_name");
  }

  if (name === "webSearch") {
    return fieldValue(input, "query");
  }

  if (name === "executeTool") {
    const toolName = fieldValue(input, "tool_name");
    const argumentsPreview = objectFieldPreview(input, "arguments");
    return joinPreview(toolName, argumentsPreview);
  }

  return valuePreview(input, MAX_PREVIEW_LENGTH);
}

function objectFieldPreview(input: unknown, key: string): string | null {
  if (!isRecord(input)) return null;
  return objectPreview(input[key]);
}

function fieldValue(input: unknown, key: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[key];
  if (typeof value !== "string") return null;
  return compactText(value, MAX_PREVIEW_LENGTH);
}

function valuePreview(value: unknown, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (isRecord(value)) return objectPreview(value);
  return compactText(formatValue(value), maxLength);
}

function objectPreview(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;

  const preview = entries
    .slice(0, MAX_OBJECT_ENTRIES)
    .map(
      ([key, entryValue]) =>
        `${key}: ${compactText(formatValue(entryValue), MAX_VALUE_LENGTH)}`,
    )
    .join(", ");
  const withOmission =
    entries.length > MAX_OBJECT_ENTRIES ? `${preview}, …` : preview;
  return compactText(withOmission, MAX_PREVIEW_LENGTH);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return stringifyPartValue(value).replace(/\s+/g, " ").trim();
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
    : normalized;
}

function joinPreview(...parts: Array<string | null>): string | null {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0
    ? compactText(present.join(", "), MAX_PREVIEW_LENGTH)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
