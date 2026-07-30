import type { PluginMcpContent } from "@sentry/junior-plugin-api";
import { z } from "zod";

export type LinearIssueLink = {
  identifier: string;
  url: string;
};

/** Loose Linear issue identity fields returned by hosted MCP tools. */
const issueFieldsSchema = z
  .object({
    identifier: z.string().trim().min(1),
    url: z.string().url(),
  })
  .passthrough();

const nestedIssueSchema = z
  .object({
    issue: issueFieldsSchema,
  })
  .passthrough();

const ISSUE_URL_RE =
  /https:\/\/linear\.app\/[^\s<>)"']+\/issue\/([A-Z][A-Z0-9]*-\d+)[^\s<>)"']*/i;

function asIssueLink(value: z.infer<typeof issueFieldsSchema>): LinearIssueLink {
  return {
    identifier: value.identifier.toUpperCase(),
    url: value.url,
  };
}

function fromStructured(value: unknown): LinearIssueLink | null {
  const nested = nestedIssueSchema.safeParse(value);
  if (nested.success) {
    return asIssueLink(nested.data.issue);
  }
  const topLevel = issueFieldsSchema.safeParse(value);
  if (topLevel.success) {
    return asIssueLink(topLevel.data);
  }
  return null;
}

function textParts(content: PluginMcpContent[]): string[] {
  return content.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
}

function fromJsonText(text: string): LinearIssueLink | null {
  try {
    return fromStructured(JSON.parse(text));
  } catch {
    return null;
  }
}

function fromIssueUrl(text: string): LinearIssueLink | null {
  const match = text.match(ISSUE_URL_RE);
  if (!match?.[0] || !match[1]) {
    return null;
  }
  return {
    identifier: match[1].toUpperCase(),
    url: match[0],
  };
}

/**
 * Extract a Linear issue identifier and URL from an MCP tool result.
 *
 * Prefers structured/JSON issue fields, then falls back to a Linear issue URL
 * in text content. Returns null when identity cannot be recovered.
 */
export function extractLinearIssueLink(result: {
  content: PluginMcpContent[];
  structuredContent?: unknown;
}): LinearIssueLink | null {
  const structured = fromStructured(result.structuredContent);
  if (structured) {
    return structured;
  }

  for (const text of textParts(result.content)) {
    const fromJson = fromJsonText(text);
    if (fromJson) {
      return fromJson;
    }
    const fromUrl = fromIssueUrl(text);
    if (fromUrl) {
      return fromUrl;
    }
  }

  return null;
}
