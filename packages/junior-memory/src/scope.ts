import { type Actor, type Source } from "@sentry/junior-plugin-api";
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

/** Public memories are visible in every source domain. */
export const publicMemoryScope: ResolvedMemoryScope = {
  scope: "public",
  scopeKey: PUBLIC_SCOPE_KEY,
};

/** Stable domain that contains private memory learned from one Source. */
function sourceDomainKey(source: Source): string {
  switch (source.platform) {
    case "web":
    case "local":
      return source.conversationId;
    case "slack":
      return `slack:${source.teamId}:${source.channelId}`;
  }
}

/** Stable provider subject used only to classify what a memory is about. */
function actorSubjectKey(actor: Actor | undefined): string | undefined {
  if (!actor) return undefined;
  switch (actor.platform) {
    case "system":
      return undefined;
    case "slack":
      return `slack:${actor.teamId}:${actor.userId}`;
    case "local":
      return `local:${actor.userId}`;
    case "web": {
      const email = actor.email?.trim().toLowerCase();
      return email ? `junior:${email}` : `web:${actor.userId}`;
    }
  }
}

/** Derive write visibility from the Source that supplied the evidence. */
export function deriveMemoryScope(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope {
  if (ctx.source.visibility === "public") {
    return publicMemoryScope;
  }
  return {
    scope: "private",
    scopeKey: sourceDomainKey(ctx.source),
  };
}

/** Derive what a memory is about independently from its visibility. */
export function deriveMemorySubject(
  ctx: MemoryRuntimeContext,
  subjectType: Extract<MemorySubjectType, "user" | "conversation">,
): ResolvedMemorySubject {
  if (subjectType === "user") {
    const subjectKey = actorSubjectKey(ctx.actor);
    if (!subjectKey) {
      throw new Error("User-subject memory requires actor context.");
    }
    return { subjectType, subjectKey };
  }
  return {
    subjectType,
    subjectKey: sourceDomainKey(ctx.source),
  };
}

/** Return every memory scope visible from the current Source. */
export function deriveVisibleMemoryScopes(
  ctx: MemoryRuntimeContext,
): ResolvedMemoryScope[] {
  if (ctx.source.visibility === "public") {
    return [publicMemoryScope];
  }
  return [publicMemoryScope, deriveMemoryScope(ctx)];
}
