import type {
  MemoryRuntimeContext,
  MemoryScope,
  MemorySubjectType,
} from "./types";

const PUBLIC_SCOPE_KEY = "public";

/** Stored memory access rule. */
export interface ResolvedMemoryScope {
  scope: MemoryScope;
  scopeKey: string;
}

/** What a stored memory is about. */
export interface ResolvedMemorySubject {
  subjectKey: string;
  subjectType: Extract<MemorySubjectType, "user" | "conversation">;
}

/** Public memories are visible everywhere. */
export const publicMemoryScope: ResolvedMemoryScope = {
  scope: "public",
  scopeKey: PUBLIC_SCOPE_KEY,
};

function privateMemoryScope(userId: string): ResolvedMemoryScope {
  return { scope: "private", scopeKey: userId };
}

/** Set memory access from the Source. */
export function deriveMemoryScope(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope {
  if (ctx.source.visibility === "public") {
    return publicMemoryScope;
  }
  if (!ctx.userId) {
    throw new Error("Private memory requires a User.");
  }
  return privateMemoryScope(ctx.userId);
}

/** Set what a memory is about. Access is set separately. */
export function deriveMemorySubject(
  ctx: MemoryRuntimeContext,
  subjectType: Extract<MemorySubjectType, "user" | "conversation">,
): ResolvedMemorySubject {
  if (subjectType === "user") {
    if (!ctx.userId) {
      throw new Error("User memory requires a User.");
    }
    return { subjectType, subjectKey: ctx.userId };
  }
  const subjectKey = ctx.conversationId;
  if (!subjectKey) {
    throw new Error(
      "Conversation-subject memory requires conversation context.",
    );
  }
  return {
    subjectType,
    subjectKey,
  };
}

/** Return the memory scopes that the current User can access. */
export function deriveVisibleMemoryScopes(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope[] {
  if (!ctx.userId) {
    return [publicMemoryScope];
  }
  return [publicMemoryScope, privateMemoryScope(ctx.userId)];
}
