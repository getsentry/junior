import type {
  MemoryRuntimeContext,
  MemoryScope,
  MemorySubjectType,
} from "./types";

const PUBLIC_SCOPE_KEY = "public";

/** Runtime-derived scope used for memory authorization checks. */
export interface ResolvedMemoryScope {
  scope: MemoryScope;
  scopeKey: string;
}

/** Runtime-derived subject classification stored for filtering and rendering. */
export interface ResolvedMemorySubject {
  subjectKey?: string;
  subjectType: MemorySubjectType;
}

/** Public memories are visible everywhere. */
export const publicMemoryScope: ResolvedMemoryScope = {
  scope: "public",
  scopeKey: PUBLIC_SCOPE_KEY,
};

function privateMemoryScope(userId: string): ResolvedMemoryScope {
  return { scope: "private", scopeKey: userId };
}

/** Derive write visibility from the Source that supplied the evidence. */
export function deriveMemoryScope(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope {
  if (ctx.source.visibility === "public") {
    return publicMemoryScope;
  }
  if (!ctx.userId) {
    throw new Error("Private memory requires a linked user.");
  }
  return privateMemoryScope(ctx.userId);
}

/** Derive what a memory is about independently from its visibility. */
export function deriveMemorySubject(
  ctx: MemoryRuntimeContext,
  subjectType: Extract<MemorySubjectType, "user" | "conversation">,
): ResolvedMemorySubject {
  if (subjectType === "user") {
    if (!ctx.userId) {
      throw new Error("User-subject memory requires a linked user.");
    }
    return { subjectType, subjectKey: ctx.userId };
  }
  const subjectKey = ctx.locationId ?? ctx.conversationId;
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

/** Return every memory scope visible to the current linked user. */
export function deriveVisibleMemoryScopes(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope[] {
  if (!ctx.userId) {
    return [publicMemoryScope];
  }
  return [publicMemoryScope, privateMemoryScope(ctx.userId)];
}
