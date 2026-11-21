/**
 * Own the MCP OAuth scopes. Each scope unlocks a fixed set of tools. Only
 * `conversations:write` lets a client send a message, which starts agent
 * work as the user. It is a separate scope so a grant without it can never
 * start a Turn.
 *
 * A grant stores its scopes as one space-separated string (RFC 6749 section
 * 3.3), so grants from before the scope split still parse.
 */
import * as z from "zod";

/** Every scope, in the order that the consent page shows it. */
export const MCP_SCOPES = [
  "conversations:read",
  "conversations:manage",
  "conversations:write",
  "inbox_items:read",
  "automations:read",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** What each scope lets the client do, as the consent page says it. */
export const MCP_SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  "conversations:read":
    "List and read the conversations that you started or take part in",
  "conversations:manage":
    "Archive, pin, and mark your conversations read, stop a running Turn, and cancel queued messages",
  "conversations:write":
    "Start conversations and send messages as you. Each message starts agent work",
  "inbox_items:read": "List and read your inbox items",
  "automations:read": "List and read the automations that you can see",
};

/** The `scope` value that names every scope. */
export const MCP_ALL_SCOPES = MCP_SCOPES.join(" ");

// Grants and clients from before Review items became Inbox items still name
// the old scope, so it reads as its new name.
const RENAMED_MCP_SCOPES: Readonly<Record<string, McpScope>> = {
  "review_items:read": "inbox_items:read",
};

function scopeNames(value: string): string[] {
  return value
    .split(" ")
    .filter(Boolean)
    .map((name) => RENAMED_MCP_SCOPES[name] ?? name);
}

/**
 * Parse a space-separated scope value into known scopes in canonical order.
 * Return `undefined` when it is empty or names an unknown scope.
 */
export function parseMcpScopes(value: string): McpScope[] | undefined {
  const names = scopeNames(value);
  if (names.length === 0) return undefined;
  if (!names.every((name) => (MCP_SCOPES as readonly string[]).includes(name)))
    return undefined;
  return MCP_SCOPES.filter((scope) => names.includes(scope));
}

/** A stored scope value: known scopes, space-separated, in canonical order. */
export const mcpScopeValueSchema = z
  .string()
  .refine(
    (value) => parseMcpScopes(value)?.join(" ") === scopeNames(value).join(" "),
  );
