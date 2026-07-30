import type { PluginMcpContent } from "@sentry/junior-plugin-api";

export type LinearIssueLink = {
  identifier: string;
  url: string;
};

function collectObjects(
  value: unknown,
  objects: Record<string, unknown>[],
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, objects);
    return;
  }
  const record = value as Record<string, unknown>;
  objects.push(record);
  for (const item of Object.values(record)) collectObjects(item, objects);
}

function stringField(
  objects: Record<string, unknown>[],
  field: string,
): string | undefined {
  for (const object of objects) {
    const value = object[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Extract a Linear issue identifier and URL from an MCP tool result. */
export function extractLinearIssueLink(result: {
  content: PluginMcpContent[];
  structuredContent?: unknown;
}): LinearIssueLink | null {
  const objects: Record<string, unknown>[] = [];
  collectObjects(result.structuredContent, objects);
  const textParts = result.content.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  for (const text of textParts) {
    collectObjects(parseJsonText(text), objects);
  }

  const urlMatch = textParts
    .map((text) =>
      text.match(
        /https:\/\/linear\.app\/[^\s<>)"']+\/issue\/([A-Z][A-Z0-9]*-\d+)[^\s<>)"']*/i,
      ),
    )
    .find((match) => match !== null);
  const identifierMatch = textParts
    .map((text) => text.match(/\b[A-Z][A-Z0-9]*-\d+\b/))
    .find((match) => match !== null);
  const identifier =
    stringField(objects, "identifier") ??
    urlMatch?.[1]?.toUpperCase() ??
    identifierMatch?.[0];
  const url = stringField(objects, "url") ?? urlMatch?.[0];
  if (!identifier || !url) {
    return null;
  }
  return {
    identifier: identifier.toUpperCase(),
    url,
  };
}
