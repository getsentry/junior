import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";

/** Shared state operations used by MCP OAuth records. */
export type McpState = Pick<
  StateAdapter,
  "delete" | "get" | "set" | "setIfNotExists"
>;

/** Hash a secret or unbounded value before it becomes part of a state key. */
export function stateKeyHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Build one versioned MCP state key. */
export function mcpStateKey(kind: string, id: string): string {
  return `junior:mcp:v1:${kind}:${id}`;
}
