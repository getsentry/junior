import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

function isStructuredToolExecutionResult(value: unknown): value is {
  content: Array<TextContent | ImageContent>;
  details: unknown;
} {
  const content = (value as { content?: unknown } | null)?.content;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(content) &&
    content.every((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }
      const record = part as Record<string, unknown>;
      if (record.type === "text") {
        return typeof record.text === "string";
      }
      if (record.type === "image") {
        return (
          typeof record.data === "string" && typeof record.mimeType === "string"
        );
      }
      return false;
    }) &&
    "details" in value
  );
}

function toToolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Unwrap sandbox envelope and detect structured results. */
export function normalizeToolResult(
  result: unknown,
  isSandboxResult: boolean,
): { content: Array<TextContent | ImageContent>; details: unknown } {
  const unwrapped =
    isSandboxResult &&
    result &&
    typeof result === "object" &&
    "result" in result
      ? (result as { result: unknown }).result
      : result;

  if (isStructuredToolExecutionResult(unwrapped)) {
    return unwrapped;
  }

  return {
    content: [{ type: "text", text: toToolContentText(unwrapped) }],
    details: unwrapped,
  };
}
