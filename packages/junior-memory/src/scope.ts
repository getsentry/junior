import type { MemoryRuntimeContext, MemoryScope } from "./types";

export interface ResolvedMemoryScope {
  scope: MemoryScope;
  scopeKey: string;
}

function sourceConversationKey(ctx: MemoryRuntimeContext): string | undefined {
  if (ctx.source.platform === "local") {
    return ctx.source.conversationId;
  }
  const threadKey = ctx.source.threadTs ?? ctx.source.messageTs;
  if (!threadKey) {
    return undefined;
  }
  return `slack:${ctx.source.teamId}:${ctx.source.channelId}:${threadKey}`;
}

function requesterScopeKey(ctx: MemoryRuntimeContext): string | undefined {
  const requester = ctx.requester;
  if (!requester?.userId) {
    return undefined;
  }
  if (requester.platform === "slack") {
    return `slack:${requester.teamId}:${requester.userId}`;
  }
  return `local:${requester.userId}`;
}

/** Derive the authority-bearing key for a requested memory scope. */
export function deriveMemoryScope(
  ctx: MemoryRuntimeContext,
  scope: MemoryScope,
): ResolvedMemoryScope {
  if (scope === "personal") {
    const scopeKey = requesterScopeKey(ctx);
    if (!scopeKey) {
      throw new Error("Personal memory requires requester context.");
    }
    return { scope, scopeKey };
  }

  const scopeKey = sourceConversationKey(ctx);
  if (!scopeKey) {
    throw new Error("Conversation memory requires conversation context.");
  }
  return { scope, scopeKey };
}

/** Return every visible scope for memory retrieval in the current context. */
export function deriveVisibleMemoryScopes(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope[] {
  const scopes: ResolvedMemoryScope[] = [];
  try {
    scopes.push(deriveMemoryScope(ctx, "personal"));
  } catch {
    // Personal memory is optional when a runtime surface has no requester.
  }
  try {
    scopes.push(deriveMemoryScope(ctx, "conversation"));
  } catch {
    // Conversation memory is optional for synthetic invocations.
  }
  return scopes;
}
