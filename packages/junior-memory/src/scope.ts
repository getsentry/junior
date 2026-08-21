import { type Actor, type Identity, type Source } from "@sentry/junior-plugin-api";
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

function uniqueScopes(scopes: ResolvedMemoryScope[]): ResolvedMemoryScope[] {
  return [
    ...new Map(
      scopes.map((scope) => [`${scope.scope}:${scope.scopeKey}`, scope]),
    ).values(),
  ];
}

/** Personal scope key for one verified provider identity, when one exists. */
function personalScopeFromIdentity(
  identity: Identity,
): ResolvedMemoryScope | undefined {
  if (identity.provider === "local") {
    return {
      scope: "personal",
      scopeKey: `local:${identity.providerSubjectId}`,
    };
  }
  // Dashboard/web actors persist as junior identities keyed by verified email.
  if (identity.provider === "junior") {
    return {
      scope: "personal",
      scopeKey: `junior:${identity.providerSubjectId}`,
    };
  }
  if (identity.provider === "slack" && identity.providerTenantId) {
    return {
      scope: "personal",
      scopeKey: `slack:${identity.providerTenantId}:${identity.providerSubjectId}`,
    };
  }
  return undefined;
}

/** Derive viewer-visible memory scopes from canonical provider identities. */
export function deriveViewerMemoryScopes(identities: Identity[]): {
  privateScopes: ResolvedMemoryScope[];
  publicScopes: ResolvedMemoryScope[];
} {
  const privateScopes = identities.flatMap((identity) => {
    const scope = personalScopeFromIdentity(identity);
    return scope ? [scope] : [];
  });
  const publicScopes = identities.flatMap((identity) =>
    identity.provider === "slack" && identity.providerTenantId
      ? [
          {
            scope: "conversation" as const,
            scopeKey: `slack:${identity.providerTenantId}`,
          },
        ]
      : [],
  );
  return {
    privateScopes: uniqueScopes(privateScopes),
    publicScopes: uniqueScopes(publicScopes),
  };
}

/** Conversation-scoped key for the Source branch we actually have. */
function sourceConversationKey(source: Source): string | undefined {
  switch (source.platform) {
    case "web":
    case "local":
      return source.conversationId;
    case "slack": {
      if (source.visibility === "public") {
        return `slack:${source.teamId}`;
      }
      const threadKey = source.threadTs ?? source.messageTs;
      if (!threadKey) {
        return undefined;
      }
      return `slack:${source.teamId}:${source.channelId}:${threadKey}`;
    }
  }
}

/** Personal scope key for the Actor branch we actually have. */
function actorScopeKey(actor: Actor | undefined): string | undefined {
  if (!actor) {
    return undefined;
  }
  switch (actor.platform) {
    case "system":
      return undefined;
    case "slack":
      return `slack:${actor.teamId}:${actor.userId}`;
    case "local":
      return `local:${actor.userId}`;
    case "web": {
      // Match junior identity personal scopes used by the dashboard viewer.
      const email = actor.email?.trim().toLowerCase();
      return email ? `junior:${email}` : undefined;
    }
  }
}

/** Derive the authority-bearing key for a requested memory scope. */
export function deriveMemoryScope(
  ctx: MemoryRuntimeContext,
  scope: MemoryScope,
): ResolvedMemoryScope {
  if (scope === "personal") {
    const scopeKey = actorScopeKey(ctx.actor);
    if (!scopeKey) {
      throw new Error("Personal memory requires actor context.");
    }
    return { scope, scopeKey };
  }

  const scopeKey = sourceConversationKey(ctx.source);
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
    const subjectKey = actorScopeKey(ctx.actor);
    if (!subjectKey) {
      throw new Error("User-subject memory requires actor context.");
    }
    return { subjectType: "user", subjectKey };
  }

  const subjectKey = sourceConversationKey(ctx.source);
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
    // Personal memory is optional when a runtime surface has no actor.
  }
  try {
    scopes.push(deriveMemoryScope(ctx, "conversation"));
  } catch {
    // Conversation memory is optional for synthetic invocations.
  }
  // Linked identities expand reads only on private web surfaces. Shared
  // conversation surfaces stay bound to their current actor and Source.
  if (
    ctx.source.platform === "web" &&
    ctx.identities &&
    ctx.identities.length > 0
  ) {
    const linked = deriveViewerMemoryScopes(ctx.identities);
    scopes.push(...linked.privateScopes, ...linked.publicScopes);
  }
  return uniqueScopes(scopes);
}
