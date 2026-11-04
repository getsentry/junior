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

/**
 * Memory is public only. Reads and writes use this scope. Stored rows with
 * the legacy private scope stay in the table, but no read returns them.
 */
export const publicMemoryScope: ResolvedMemoryScope = {
  scope: "public",
  scopeKey: PUBLIC_SCOPE_KEY,
};

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
