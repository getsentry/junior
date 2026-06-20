import type {
  MemoryRuntimeContext,
  MemoryScope,
  MemorySubjectType,
} from "./types";

/** Runtime-derived visibility scope used for memory authorization checks. */
export interface ResolvedMemoryScope {
  scope: MemoryScope;
  scopeKey: string;
}

/** Runtime-derived subject classification stored for filtering and rendering. */
export interface ResolvedMemorySubject {
  subjectKey?: string;
  subjectType: MemorySubjectType;
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

/** Derive the memory subject from the already-authorized write scope. */
export function deriveMemorySubject(
  ctx: MemoryRuntimeContext,
  scope: ResolvedMemoryScope,
): ResolvedMemorySubject {
  if (scope.scope === "personal") {
    const subjectKey = requesterScopeKey(ctx);
    if (!subjectKey) {
      throw new Error("User-subject memory requires requester context.");
    }
    return { subjectType: "user", subjectKey };
  }

  const subjectKey = sourceConversationKey(ctx);
  if (!subjectKey) {
    throw new Error(
      "Conversation-subject memory requires conversation context.",
    );
  }
  return { subjectType: "conversation", subjectKey };
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
