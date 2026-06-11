import { createHash } from "node:crypto";
import path from "node:path";

const LOCAL_CONVERSATION_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function slugifyConversationAlias(alias: string): string | undefined {
  const trimmed = alias.trim();
  if (!LOCAL_CONVERSATION_ALIAS_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase().replaceAll(".", "-");
}

function workspaceKey(cwd: string): string {
  return createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 12);
}

/** Normalize a local CLI conversation alias into the durable conversation id. */
export function normalizeLocalConversationId(input: {
  alias?: string;
  cwd?: string;
}): string | undefined {
  const slug = slugifyConversationAlias(input.alias ?? "default");
  if (!slug) {
    return undefined;
  }
  return `local:${workspaceKey(input.cwd ?? process.cwd())}:${slug}`;
}

/** Return whether a user-facing local conversation alias is accepted. */
export function isLocalConversationAlias(value: string): boolean {
  return Boolean(slugifyConversationAlias(value));
}
