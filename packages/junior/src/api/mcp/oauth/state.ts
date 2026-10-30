import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import type { z } from "zod";

/** Shared state operations used by MCP OAuth records. */
export type McpState = Pick<
  StateAdapter,
  "delete" | "get" | "set" | "setIfNotExists"
>;

/** Return the SHA-256 hex digest of a secret or unbounded value. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Build one versioned MCP state key. */
export function mcpStateKey(kind: string, id: string): string {
  return `junior:mcp:v1:${kind}:${id}`;
}

/** Read and parse one MCP state record. A missing record reads as undefined. */
export async function readRecord<T>(
  state: McpState,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const value = await state.get(key);
  return value === null ? undefined : schema.parse(value);
}
